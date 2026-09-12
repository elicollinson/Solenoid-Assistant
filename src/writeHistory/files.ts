import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { WriteHistory, HistoryConflict, hash } from "./history";
import { writeFileAtomic, openBundle } from "../okf/bundle";
import { validateBundle } from "../okf/validate";
import { regenerateIndexChain } from "../okf/indexFile";
import { appendLogEntry } from "../okf/logFile";
import { conceptLinks } from "../okf/links";
import { parseDocument } from "../okf/concept";

export interface FileChange { path: string; before: string | null; after: string | null }
export interface FileRecord { kind: "okf-v1"; root: string; changes: FileChange[] }
const isConcept = (path: string) => !["index.md", "log.md"].includes(basename(path));

/** Refuse symlinks and out-of-bundle files; the source bundle contains Markdown only. */
export async function snapshot(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let bytes = 0;
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new HistoryConflict("Symlinks are not supported in a captured bundle");
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".md")) {
        const text = await Bun.file(path).text();
        bytes += Buffer.byteLength(text);
        if (bytes > 32 * 1024 * 1024) throw new HistoryConflict("Bundle exceeds the 32 MiB staging budget");
        result.set(relative(root, path), text);
      }
    }
  }
  await walk(root);
  return result;
}
function delta(before: Map<string, string>, after: Map<string, string>): FileChange[] {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(path => {
    const a = before.get(path) ?? null, b = after.get(path) ?? null;
    return a === b ? [] : [{ path, before: a, after: b }];
  });
}
function safe(root: string, path: string): string {
  const full = resolve(root, path);
  if (!full.startsWith(resolve(root) + "/") || !path.endsWith(".md")) throw new HistoryConflict("Invalid journal path");
  return full;
}
async function syncFile(path: string) {
  const file = await open(path, "r");
  try { await file.sync(); } finally { await file.close(); }
}
async function replace(root: string, path: string, value: string | null) {
  const full = safe(root, path);
  if (value === null) await rm(full);
  else { await writeFileAtomic(full, value); await syncFile(full); }
  await syncFile(dirname(full));
}
function equal(a: string | null, b: string | null) { return a === null || b === null ? a === b : hash(a) === hash(b); }

/** Cross-process app writers cannot steal a live owner's lock. A stale lock is
 * acquired only by explicit recovery after the owner process is gone.
 */
export class FileHistory {
  constructor(readonly history: WriteHistory,
    readonly reconcile: (root: string, concepts: string[]) => Promise<void> = async () => {},
    readonly fault?: (point: string, index: number) => void) {}
  private async root(root: string) {
    await mkdir(root, { recursive: true });
    if ((await lstat(root)).isSymbolicLink()) throw new HistoryConflict("Bundle root cannot be a symlink");
    return realpath(root);
  }
  private lock(root: string, owner: string, recovering = false) {
    const db = this.history.db.$client;
    db.transaction(() => {
      const held = db.query("SELECT owner,pid FROM okf_write_locks WHERE resource=?").get(root) as { owner: string; pid: number } | null;
      if (held) {
        let alive = true;
        try { process.kill(held.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
        if (!recovering || alive) throw new HistoryConflict("Bundle is locked; wait for its writer or recover after it stops");
        db.query("DELETE FROM okf_write_locks WHERE resource=?").run(root);
      }
      db.query("INSERT INTO okf_write_locks(resource,owner,pid,acquired_at) VALUES(?,?,?,?)").run(root, owner, process.pid, this.history.now());
    }).immediate();
  }
  private unlock(root: string, owner: string) {
    this.history.db.$client.query("DELETE FROM okf_write_locks WHERE resource=? AND owner=?").run(root, owner);
  }
  async mutate<T>(inputRoot: string, actor: string, tool: string, stage: (root: string) => Promise<T>, inverseOf?: string): Promise<T & { operationId: string }> {
    const root = await this.root(inputRoot);
    const id = this.history.begin(tool, actor, inverseOf);
    let dir: string | undefined;
    let captured = false;
    try {
      this.lock(root, id);
      dir = await mkdtemp(join(tmpdir(), "solenoid-write-"));
      const before = await snapshot(root);
      for (const [path, text] of before) await writeFileAtomic(safe(dir, path), text);
      const result = await stage(dir);
      const valid = await validateBundle(openBundle(dir));
      if (!valid.conformant) throw new HistoryConflict("Staged bundle is invalid");
      const changes = delta(before, await snapshot(dir));
      if (!changes.length) { this.history.outcome(id, "no_effect"); return { ...result, operationId: id }; }
      if (changes.some(c => Buffer.byteLength(c.before ?? "") + Buffer.byteLength(c.after ?? "") > 256 * 1024)) throw new HistoryConflict("File exceeds the 256 KiB capture budget");
      // All observed source files are a read set, including files a move may link to.
      if (delta(before, await snapshot(root)).length) throw new HistoryConflict("Bundle changed while planning");
      this.history.capture(id, { kind: "okf-v1", root, changes } satisfies FileRecord);
      captured = true;
      this.history.outcome(id, "dispatch_started");
      this.fault?.("prepared", -1);
      await this.commit(id, { kind: "okf-v1", root, changes });
      if (result && typeof result === "object" && "path" in result && typeof result.path === "string") {
        return { ...result, path: result.path.replace(dir, root), operationId: id };
      }
      return { ...result, operationId: id };
    } catch (error) {
      this.history.outcome(id, captured ? "partial" : "no_effect");
      throw error;
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
      // Partial changes keep their durable lock; only recovery may clear it.
      if (this.history.get(id)?.execution !== "partial") this.unlock(root, id);
    }
  }
  private async commit(id: string, record: FileRecord) {
    for (const [index, change] of record.changes.entries()) {
      const file = Bun.file(safe(record.root, change.path));
      const current = await file.exists() ? await file.text() : null;
      if (!equal(current, change.before) && !equal(current, change.after)) throw new HistoryConflict("File changed; recovery needs review");
      if (!equal(current, change.after)) await replace(record.root, change.path, change.after);
      this.fault?.("applied", index);
    }
    this.history.db.$client.query("UPDATE okf_writes SET execution='committed',refresh_pending=1 WHERE id=?").run(id);
    await this.refresh(id, record);
  }
  private async refresh(id: string, record: FileRecord) {
    try {
      await this.reconcile(record.root, record.changes.filter(c => isConcept(c.path)).map(c => c.path.slice(0, -3)));
      this.history.db.$client.query("UPDATE okf_writes SET refresh_pending=0 WHERE id=?").run(id);
    } catch { /* The committed journal keeps projection refresh pending. */ }
  }
  async refreshPending() {
    const rows = this.history.db.$client.query("SELECT id FROM okf_writes WHERE refresh_pending=1").all() as { id: string }[];
    for (const row of rows) await this.refresh(row.id, this.history.payload<FileRecord>(row.id, true));
  }
  async maintain() {
    const rows = this.history.db.$client.query("SELECT id FROM okf_writes WHERE execution IN ('partial','dispatch_started','preparing')").all() as { id: string }[];
    for (const row of rows) { try { await this.recover(row.id); } catch { /* Live writer or newer content: preserve for explicit resolution. */ } }
    await this.refreshPending();
  }
  async recover(id: string) {
    const state = this.history.get(id)?.execution;
    if (state === "committed") return;
    if (state === "preparing") {
      const held = this.history.db.$client.query("SELECT resource,pid FROM okf_write_locks WHERE owner=?").get(id) as { resource: string; pid: number } | null;
      if (held) {
        try { process.kill(held.pid, 0); throw new HistoryConflict("Writer is still running"); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
      }
      const row = this.history.db.$client.query("SELECT payload FROM okf_writes WHERE id=?").get(id) as { payload: string | null };
      if (!row.payload) { this.history.outcome(id, "no_effect"); if (held) this.unlock(held.resource, id); return; }
    }
    if (!["preparing", "partial", "dispatch_started"].includes(state ?? "")) throw new HistoryConflict("This operation does not need file recovery");
    const record = this.history.payload<FileRecord>(id, true);
    if (record.kind !== "okf-v1") throw new HistoryConflict("Unsupported recovery adapter");
    const root = await this.root(record.root);
    // Recovery of a failed operation in this same service is safe only after its
    // mutate call has returned. No other operation can hold this id's lock.
    const held = this.history.db.$client.query("SELECT owner,pid FROM okf_write_locks WHERE resource=?").get(root) as { owner: string; pid: number } | null;
    if (held?.owner === id && held.pid === process.pid && this.history.get(id)?.execution === "partial") this.unlock(root, id);
    this.lock(root, id, true);
    try {
      const current = await snapshot(root);
      for (const change of record.changes) {
        const value = current.get(change.path) ?? null;
        if (!equal(value, change.before) && !equal(value, change.after)) throw new HistoryConflict("Recovery conflicts with newer content");
      }
      await this.commit(id, record);
      this.unlock(root, id);
    } catch (e) { this.history.outcome(id, "partial"); throw e; }
  }
  async undo(id: string) {
    if (this.history.get(id)?.execution !== "committed") throw new HistoryConflict("Only a committed write can be undone");
    if (this.history.db.$client.query("SELECT 1 FROM okf_writes WHERE inverse_of=? AND execution IN ('committed','dispatch_started','partial')").get(id)) throw new HistoryConflict("Already undone; undo the inverse to redo");
    const record = this.history.payload<FileRecord>(id);
    if (record.kind !== "okf-v1") throw new HistoryConflict("Unsupported saved change");
    return this.mutate(record.root, "okf-undo", "okf_undo", async root => {
      // Under the same durable bundle lock as every other OKF writer.
      if (this.history.db.$client.query("SELECT 1 FROM okf_writes WHERE inverse_of=? AND execution IN ('committed','dispatch_started','partial')").get(id)) throw new HistoryConflict("Already undone");
      const current = await snapshot(root);
      const changes = record.changes.filter(c => isConcept(c.path)).map(c => ({ path: c.path, before: c.after, after: c.before }));
      const removed = new Set(changes.filter(c => c.after === null).map(c => c.path.slice(0, -3)));
      for (const [path, text] of current) {
        if (!isConcept(path) || changes.some(c => c.path === path)) continue;
        if (conceptLinks(path.slice(0, -3), parseDocument(text).body).some(l => l.id && removed.has(l.id))) throw new HistoryConflict("A later memory references this created page; cannot remove it");
      }
      for (const change of changes) {
        if (!equal(current.get(change.path) ?? null, change.before)) throw new HistoryConflict("Later edits prevent undo; current content is preserved");
        if (change.after === null) await rm(safe(root, change.path)); else await writeFileAtomic(safe(root, change.path), change.after);
      }
      const bundle = openBundle(root);
      for (const change of changes) await regenerateIndexChain(bundle, dirname(change.path) === "." ? "" : dirname(change.path));
      await appendLogEntry(bundle, "Update", `Restored saved content from operation ${id}.`);
      return { restored: changes.map(c => c.path) };
    }, id);
  }
}

export type FileMutation = <T>(root: string, actor: string, tool: string, stage: (root: string) => Promise<T>) => Promise<T>;
let fileMutation: FileMutation | undefined;
export function configureFileMutation(handler?: FileMutation): void { fileMutation = handler; }
export function fileMutationHandler(): FileMutation | undefined { return fileMutation; }
