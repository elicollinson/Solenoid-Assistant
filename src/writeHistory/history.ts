import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db";
import type { WriteCall, WriteOutcome, WriteRecorder, WriteResponse } from "../core/writeExecution";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class HistoryConflict extends Error {}
export class HistoryUnavailable extends Error {}
export interface HistoryRow {
  id: string; tool: string; origin: string; actor: string; execution: WriteOutcome;
  response: WriteResponse; capability: string; inverseOf: string | null;
  createdAt: number; expiresAt: number | null;
}
export class WriteHistory implements WriteRecorder {
  constructor(readonly db: Db, private key?: Buffer, readonly now = () => Date.now()) {
    if (key && key.length !== 32) throw new Error("Write history encryption key must contain 32 bytes");
  }
  begin(call: WriteCall, tool: string): void {
    // Re-entering the same logical call is permitted; re-dispatching a completed
    // call is not. Tool-boundary nesting is handled by the caller, not here.
    const old = this.get(call.id);
    if (old) throw new HistoryConflict(`Write already recorded: ${call.id}`);
    this.db.$client.transaction(() => {
      this.db.$client.query(`INSERT INTO write_operations
        (id,parent_id,tool,origin,actor,run_id,workflow_id,idempotency_key,execution,response,capability,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'not_dispatched','pending','unknown',?,?)`).run(
          call.id, call.parentId ?? null, tool, call.origin ?? "tool", call.actor ?? "agent",
          call.runId ?? null, call.workflowId ?? null, call.idempotencyKey ?? call.id, this.now(), this.now());
      this.event(call.id, "intent");
    }).immediate();
  }
  event(id: string, kind: string, code?: string): void {
    this.db.$client.query("INSERT INTO write_events(operation_id,kind,code,at) VALUES(?,?,?,?)")
      .run(id, kind, code ?? null, this.now());
  }
  outcome(id: string, outcome: WriteOutcome, code?: string): void {
    const old = this.get(id);
    if (!old) return;
    // A response failure never downgrades an adapter-confirmed side effect.
    if (["committed", "no_effect", "partial"].includes(old.execution) && !code?.startsWith("adapter:")) return;
    const authoritative = this.db.$client.query("SELECT 1 FROM write_events WHERE operation_id=? AND code LIKE 'adapter:%' LIMIT 1").get(id);
    if (authoritative && !code?.startsWith("adapter:")) return;
    this.db.$client.transaction(() => {
      this.db.$client.query("UPDATE write_operations SET execution=?,updated_at=? WHERE id=?").run(outcome, this.now(), id);
      this.event(id, `outcome:${outcome}`, code);
    }).immediate();
  }
  response(id: string, response: WriteResponse): void {
    if (!this.get(id)) return;
    this.db.$client.transaction(() => {
      this.db.$client.query("UPDATE write_operations SET response=?,updated_at=? WHERE id=?").run(response, this.now(), id);
      this.event(id, `response:${response}`);
    }).immediate();
  }
  get(id: string): HistoryRow | null {
    return this.db.$client.query(`SELECT id,tool,origin,actor,execution,response,capability,inverse_of AS inverseOf,
      created_at AS createdAt,expires_at AS expiresAt FROM write_operations WHERE id=?`).get(id) as HistoryRow | null;
  }
  list(before = Number.MAX_SAFE_INTEGER, limit = 50): HistoryRow[] {
    return this.db.$client.query(`SELECT id,tool,origin,actor,execution,response,capability,inverse_of AS inverseOf,
      created_at AS createdAt,expires_at AS expiresAt FROM write_operations WHERE created_at<? ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(before, Math.min(100, Math.max(1, limit))) as HistoryRow[];
  }
  events(id: string) {
    return this.db.$client.query("SELECT kind,code,at FROM write_events WHERE operation_id=? ORDER BY id").all(id);
  }
  encrypt(value: unknown): string {
    if (!this.key) throw new HistoryUnavailable("Set WRITE_HISTORY_KEY to enable captured changes and undo");
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 2 * 1024 * 1024) throw new HistoryUnavailable("Change exceeds the 2 MiB capture budget");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  }
  decrypt<T>(value: string): T {
    if (!this.key) throw new HistoryUnavailable("Write history key is unavailable");
    const bytes = Buffer.from(value, "base64");
    const cipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString()) as T;
  }
  capture(id: string, value: unknown, capability = "conditional_local_inverse"): void {
    const cipher = this.encrypt(value);
    const expires = this.now() + 30 * 86400_000;
    this.db.$client.transaction(() => {
      this.db.$client.query("INSERT INTO write_payloads(operation_id,version,cipher,expires_at) VALUES(?,1,?,?)").run(id, cipher, expires);
      this.db.$client.query("UPDATE write_operations SET capability=?,expires_at=? WHERE id=?").run(capability, expires, id);
      this.event(id, "prepared");
    }).immediate();
  }
  payload<T>(id: string, recovery = false): T {
    const row = this.db.$client.query("SELECT cipher,expires_at AS expires FROM write_payloads WHERE operation_id=?").get(id) as { cipher: string; expires: number } | null;
    if (!row || (!recovery && row.expires <= this.now())) throw new HistoryUnavailable("Undo data is unavailable or expired");
    return this.decrypt<T>(row.cipher);
  }
  plan(kind: string, value: unknown, operationId?: string) {
    const id = randomUUID(), digest = hash(JSON.stringify(value));
    this.db.$client.query("INSERT INTO write_plans(id,kind,operation_id,digest,cipher,state,created_at,expires_at) VALUES(?,?,?,?,?,'proposed',?,?)")
      .run(id, kind, operationId ?? null, digest, this.encrypt(value), this.now(), this.now() + 86400_000);
    return { id, digest, value };
  }
  readPlan<T>(id: string): { kind: string; operationId: string | null; digest: string; value: T; state: string; appliedOperationId: string | null } {
    const row = this.db.$client.query("SELECT * FROM write_plans WHERE id=? AND expires_at>?").get(id, this.now()) as Record<string, unknown> | null;
    if (!row) throw new HistoryUnavailable("Review plan expired or unavailable");
    return { kind: String(row.kind), operationId: row.operation_id as string | null, digest: String(row.digest),
      value: this.decrypt<T>(String(row.cipher)), state: String(row.state), appliedOperationId: row.applied_operation_id as string | null };
  }
  claimPlan(id: string, digest: string, operationId: string): void {
    const result = this.db.$client.query("UPDATE write_plans SET state='applying',applied_operation_id=? WHERE id=? AND digest=? AND state='proposed' AND expires_at>?")
      .run(operationId, id, digest, this.now());
    if (!result.changes) throw new HistoryConflict("Plan was changed, expired, or already applied");
  }
  markPlan(id: string, state: string): void { this.db.$client.query("UPDATE write_plans SET state=? WHERE id=?").run(state, id); }
  inverse(id: string, original: string): void { this.db.$client.query("UPDATE write_operations SET inverse_of=? WHERE id=?").run(original, id); }
  prune(): void {
    // Unknown/partial in-flight changes stay pinned until explicitly recovered.
    this.db.$client.query(`DELETE FROM write_payloads WHERE expires_at<? AND operation_id IN
      (SELECT id FROM write_operations WHERE execution IN ('committed','no_effect','not_dispatched'))`).run(this.now());
    this.db.$client.query("DELETE FROM write_plans WHERE expires_at<? AND state!='applying'").run(this.now());
    const cutoff = this.now() - 180 * 86400_000;
    this.db.$client.transaction(() => {
      this.db.$client.query(`DELETE FROM write_events WHERE operation_id IN (SELECT id FROM write_operations WHERE created_at<?
        AND execution IN ('committed','no_effect','not_dispatched') AND id NOT IN (SELECT operation_id FROM write_payloads))`).run(cutoff);
      this.db.$client.query(`DELETE FROM write_operations WHERE created_at<? AND execution IN ('committed','no_effect','not_dispatched')
        AND id NOT IN (SELECT operation_id FROM write_payloads)`).run(cutoff);
    }).immediate();
  }
}
