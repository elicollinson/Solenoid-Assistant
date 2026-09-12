import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db";
import { canonicalBundleRoot } from "../okf/bundle";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class HistoryConflict extends Error {}
export class HistoryUnavailable extends Error {}
export interface HistoryRow { id: string; tool: string; actor: string; execution: string; inverseOf: string | null }

/** Internal OKF write journal, not an application activity log or review queue.
 * After-images make interrupted multi-file writes recoverable without rerunning
 * a model. Before-images support the existing OKF tool surface's guarded undo.
 */
export class WriteHistory {
  constructor(readonly db: Db, readonly now = () => Date.now()) {}
  begin(tool: string, actor: string, inverseOf?: string): string {
    const id = randomUUID();
    this.db.$client.query("INSERT INTO okf_writes(id,tool,actor,execution,created_at,expires_at,inverse_of) VALUES(?,?,?,'preparing',?,?,?)")
      .run(id, tool, actor, this.now(), this.now() + 30 * 86400_000, inverseOf ?? null);
    return id;
  }
  get(id: string): HistoryRow | null {
    return this.db.$client.query("SELECT id,tool,actor,execution,inverse_of AS inverseOf FROM okf_writes WHERE id=?").get(id) as HistoryRow | null;
  }
  outcome(id: string, state: string): void { this.db.$client.query("UPDATE okf_writes SET execution=? WHERE id=?").run(state, id); }
  capture(id: string, value: unknown): void {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 2 * 1024 * 1024) throw new HistoryUnavailable("Change exceeds the 2 MiB capture budget");
    this.db.$client.query("UPDATE okf_writes SET payload=?,digest=?,version=1 WHERE id=?").run(data, hash(data), id);
  }
  payload<T>(id: string, recovery = false): T {
    const row = this.db.$client.query("SELECT payload,digest,version,expires_at FROM okf_writes WHERE id=?").get(id) as { payload: string | null; digest: string; version: number; expires_at: number } | null;
    if (!row?.payload || (!recovery && row.expires_at <= this.now())) throw new HistoryUnavailable("Undo data is unavailable or expired");
    if (row.version !== 1 || hash(row.payload) !== row.digest) throw new HistoryUnavailable("Saved change failed its version or integrity check");
    return JSON.parse(row.payload) as T;
  }
  prune(): void {
    this.db.$client.query("DELETE FROM okf_writes WHERE expires_at<? AND execution IN ('committed','no_effect') AND refresh_pending=0").run(this.now());
  }
}
export function hasPendingFileWrite(db: Db, root: string): boolean {
  return !!db.$client.query(`SELECT 1 FROM okf_write_locks l JOIN okf_writes o ON o.id=l.owner
    WHERE l.resource=? AND o.execution!='committed' LIMIT 1`).get(canonicalBundleRoot(root));
}
