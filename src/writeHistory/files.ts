import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { currentWriteCall, newWriteCall } from "../core/writeExecution";
import { WriteHistory, HistoryConflict, hash } from "./history";
import { writeFileAtomic, openBundle } from "../okf/bundle";
import { validateBundle } from "../okf/validate";
import { regenerateIndexChain } from "../okf/indexFile";
import { appendLogEntry } from "../okf/logFile";
import { conceptLinks } from "../okf/links";
import { parseDocument } from "../okf/concept";

export interface FileChange { path: string; before: string | null; after: string | null }
export interface FileRecord { kind: "okf-v1"; root: string; changes: FileChange[] }
export interface FileInverse { kind: "okf-inverse-v1"; root: string; changes: FileChange[]; original: string }
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
  async preview<T>(root: string, stage: (root: string) => Promise<T>) {
    const dir = await mkdtemp(join(tmpdir(), "solenoid-preview-"));
    try {
      const before = await snapshot(root);
      for (const [path, text] of before) await writeFileAtomic(safe(dir, path), text);
      await stage(dir);
      return delta(before, await snapshot(dir));
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  private async root(root: string) {
    await mkdir(root, { recursive: true });
    if ((await lstat(root)).isSymbolicLink()) throw new HistoryConflict("Bundle root cannot be a symlink");
    return realpath(root);
  }
  private lock(root: string, owner: string, recovering = false) {
    const db = this.history.db.$client;
    db.transaction(() => {
      const held = db.query("SELECT owner,pid FROM write_resource_locks WHERE resource=?").get(root) as { owner: string; pid: number } | null;
      if (held) {
        let alive = true;
        try { process.kill(held.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
        if (!recovering || alive) throw new HistoryConflict("Bundle is locked; wait for its writer or recover after it stops");
        db.query("DELETE FROM write_resource_locks WHERE resource=?").run(root);
      }
      db.query("INSERT INTO write_resource_locks(resource,owner,pid,acquired_at) VALUES(?,?,?,?)").run(root, owner, process.pid, this.history.now());
    }).immediate();
  }
  private unlock(root: string, owner: string) {
    this.history.db.$client.query("DELETE FROM write_resource_locks WHERE resource=? AND owner=?").run(root, owner);
  }
  async mutate<T>(inputRoot: string, actor: string, tool: string, stage: (root: string) => Promise<T>): Promise<T> {
    const root = await this.root(inputRoot);
    const call = currentWriteCall() ?? newWriteCall({ actor, origin: "okf-store" });
    if (!this.history.get(call.id)) this.history.begin(call, tool);
    this.lock(root, call.id);
    const dir = await mkdtemp(join(tmpdir(), "solenoid-write-"));
    let captured = false;
    try {
      const before = await snapshot(root);
      for (const [path, text] of before) await writeFileAtomic(safe(dir, path), text);
      const result = await stage(dir);
      const valid = await validateBundle(openBundle(dir));
      if (!valid.conformant) throw new HistoryConflict("Staged bundle is invalid");
      const changes = delta(before, await snapshot(dir));
      if (!changes.length) { this.history.outcome(call.id, "no_effect", "adapter:unchanged"); return result; }
      if (changes.some(c => Buffer.byteLength(c.before ?? "") + Buffer.byteLength(c.after ?? "") > 256 * 1024)) throw new HistoryConflict("File exceeds the 256 KiB capture budget");
      // All observed source files are a read set, including files a move may link to.
      if (delta(before, await snapshot(root)).length) throw new HistoryConflict("Bundle changed while planning");
      this.history.capture(call.id, { kind: "okf-v1", root, changes } satisfies FileRecord);
      captured = true;
      this.history.outcome(call.id, "dispatch_started", "adapter:files_prepared");
      this.fault?.("prepared", -1);
      await this.commit(call.id, { kind: "okf-v1", root, changes });
      if (result && typeof result === "object" && "path" in result && typeof result.path === "string") {
        return { ...result, path: result.path.replace(dir, root) };
      }
      return result;
    } catch (error) {
      this.history.outcome(call.id, captured ? "partial" : "no_effect", captured ? "adapter:recovery_required" : "adapter:prepare_failed");
      throw error;
    } finally {
      await rm(dir, { recursive: true, force: true });
      // Partial changes keep their durable lock; only recovery may clear it.
      if (this.history.get(call.id)?.execution !== "partial") this.unlock(root, call.id);
    }
  }
  private async commit(id: string, record: FileRecord) {
    for (const [index, change] of record.changes.entries()) {
      const file = Bun.file(safe(record.root, change.path));
      const current = await file.exists() ? await file.text() : null;
      if (!equal(current, change.before) && !equal(current, change.after)) throw new HistoryConflict("File changed; recovery needs review");
      if (!equal(current, change.after)) await replace(record.root, change.path, change.after);
      this.history.event(id, "file_applied", String(index));
      this.fault?.("applied", index);
    }
    const concepts = record.changes.filter(c => isConcept(c.path)).map(c => c.path.slice(0, -3));
    this.history.db.$client.transaction(() => {
      this.history.db.$client.query("INSERT OR REPLACE INTO write_reconciliations(operation_id,root,concepts,state) VALUES(?,?,?,'pending')")
        .run(id, record.root, JSON.stringify(concepts));
      this.history.outcome(id, "committed", "adapter:files_committed");
      this.history.db.$client.query("UPDATE write_plans SET state='applied' WHERE applied_operation_id=? AND state IN ('applying','failed')").run(id);
    }).immediate();
    await this.refresh(id, record.root, concepts);
  }
  private async refresh(id: string, root: string, concepts: string[]) {
    try {
      await this.reconcile(root, concepts);
      this.history.db.$client.query("UPDATE write_reconciliations SET state='done' WHERE operation_id=?").run(id);
    } catch { this.history.event(id, "refresh_pending"); }
  }
  async refreshPending() {
    const rows = this.history.db.$client.query("SELECT operation_id AS id,root,concepts FROM write_reconciliations WHERE state='pending'").all() as { id: string; root: string; concepts: string }[];
    for (const row of rows) await this.refresh(row.id, row.root, JSON.parse(row.concepts));
  }
  async recover(id: string) {
    const state = this.history.get(id)?.execution;
    if (state === "committed") return;
    if (!["partial", "dispatch_started", "outcome_unknown"].includes(state ?? "")) throw new HistoryConflict("This operation does not need file recovery");
    const record = this.history.payload<FileRecord>(id, true);
    if (record.kind !== "okf-v1") throw new HistoryConflict("Unsupported recovery adapter");
    const root = await this.root(record.root);
    // Recovery of a failed operation in this same service is safe only after its
    // mutate call has returned. No other operation can hold this id's lock.
    const held = this.history.db.$client.query("SELECT owner,pid FROM write_resource_locks WHERE resource=?").get(root) as { owner: string; pid: number } | null;
    if (held?.owner === id && held.pid === process.pid && this.history.get(id)?.execution === "partial") this.unlock(root, id);
    this.lock(root, id, true);
    try {
      const current = await snapshot(root);
      for (const change of record.changes) {
        const value = current.get(change.path) ?? null;
        if (!equal(value, change.before) && !equal(value, change.after)) throw new HistoryConflict("Recovery conflicts with newer content");
      }
      await this.commit(id, record);
      this.history.event(id, "recovered");
      this.unlock(root, id);
    } catch (e) { this.history.outcome(id, "partial", "adapter:recovery_conflict"); throw e; }
  }
  async planInverse(id: string) {
    if (this.history.get(id)?.execution !== "committed") throw new HistoryConflict("Only a committed operation can be reversed");
    const priorInverse = this.history.db.$client.query("SELECT id FROM write_operations WHERE inverse_of=? AND execution IN ('committed','dispatch_started','partial')").get(id);
    if (priorInverse) throw new HistoryConflict("Already reversed; use redo on the recorded inverse");
    const record = this.history.payload<FileRecord>(id);
    if (record.kind !== "okf-v1") throw new HistoryConflict("No supported file inverse");
    const current = await snapshot(record.root);
    const changes = record.changes.filter(c => isConcept(c.path)).map(c => ({ path: c.path, before: c.after, after: c.before }));
    for (const change of changes) if (!equal(current.get(change.path) ?? null, change.before)) throw new HistoryConflict("Later edits exist; exact undo would overwrite them. Keep the current content or prepare a reviewed manual edit.");
    const removed = new Set(changes.filter(c => c.after === null).map(c => c.path.slice(0, -3)));
    for (const [path, text] of current) {
      if (!isConcept(path) || changes.some(c => c.path === path)) continue;
      const doc = parseDocument(text);
      if (conceptLinks(path.slice(0, -3), doc.body).some(l => l.id && removed.has(l.id))) throw new HistoryConflict("A later page references this created page; cannot remove it");
    }
    return this.history.plan("okf-inverse", { kind: "okf-inverse-v1", root: record.root, changes, original: id } satisfies FileInverse, id);
  }
  async applyInverse(planId: string, digest: string) {
    const plan = this.history.readPlan<FileInverse>(planId);
    if (plan.kind !== "okf-inverse" || plan.value.kind !== "okf-inverse-v1" || digest !== plan.digest) throw new HistoryConflict("Wrong review plan");
    if (plan.state === "applied") return { operationId: plan.appliedOperationId };
    // Re-evaluate dependencies as well as file revisions at application time.
    const fresh = await this.planInverse(plan.value.original);
    if (hash(JSON.stringify(fresh.value)) !== digest) throw new HistoryConflict("Review plan is stale");
    this.history.db.$client.query("DELETE FROM write_plans WHERE id=?").run(fresh.id);
    const call = newWriteCall({ origin: "review", actor: "user", idempotencyKey: `inverse:${planId}` });
    this.history.db.$client.transaction(() => {
      this.history.claimPlan(planId, digest, call.id);
      this.history.begin(call, "okf_undo");
      this.history.inverse(call.id, plan.value.original);
    }).immediate();
    const { withWriteCall } = await import("../core/writeExecution");
    try {
      await withWriteCall(call, () => this.mutate(plan.value.root, "human:user", "okf_undo", async root => {
        const stageFiles = await snapshot(root);
        const removing = new Set(plan.value.changes.filter(c => c.after === null).map(c => c.path.slice(0, -3)));
        for (const [path, text] of stageFiles) {
          if (!isConcept(path) || plan.value.changes.some(c => c.path === path)) continue;
          if (conceptLinks(path.slice(0, -3), parseDocument(text).body).some(l => l.id && removing.has(l.id))) throw new HistoryConflict("A later reference prevents removal");
        }
        for (const c of plan.value.changes) {
          const file = Bun.file(safe(root, c.path));
          if (!equal(await file.exists() ? await file.text() : null, c.before)) throw new HistoryConflict("Later edits prevent undo");
          if (c.after === null) await rm(safe(root, c.path)); else await writeFileAtomic(safe(root, c.path), c.after);
        }
        const bundle = openBundle(root);
        for (const c of plan.value.changes) await regenerateIndexChain(bundle, dirname(c.path) === "." ? "" : dirname(c.path));
        await appendLogEntry(bundle, "Update", `Restored saved content (history operation ${call.id}).`);
      }));
      this.history.markPlan(planId, "applied");
      this.history.response(call.id, "delivered");
      return { operationId: call.id };
    } catch (e) { this.history.markPlan(planId, "failed"); throw e; }
  }
}
