import { currentWriteCall, newWriteCall, withWriteCall } from "../core/writeExecution";
import { HistoryConflict, WriteHistory } from "./history";

const fieldsFor = {
  reminders: ["title", "due_at", "all_day"],
  collection_items: ["name", "description", "notes", "archived"],
} as const;
type Table = keyof typeof fieldsFor;
type Cell = string | number | null;
interface RowRecord { kind: "row-v1"; table: Table; id: string; before: Record<string, Cell>; after: Record<string, Cell> }

/** These allowlists are code-owned. Stored SQL and arbitrary table snapshots
 * are never executable history. Immutable source receipts are not touched.
 */
export class RowHistory {
  constructor(readonly history: WriteHistory) {}
  private read(table: Table, id: string, fields: string[]) {
    if (!Object.hasOwn(fieldsFor, table) || !fields.length || fields.some(f => !(fieldsFor[table] as readonly string[]).includes(f))) throw new HistoryConflict("Unsupported row adapter fields");
    const row = this.history.db.$client.query(`SELECT ${fields.join(",")} FROM ${table} WHERE id=?`).get(id) as Record<string, Cell> | null;
    if (!row) throw new HistoryConflict("Resource no longer exists");
    if (table === "reminders") {
      const state = this.history.db.$client.query("SELECT state,completed_at FROM reminders WHERE id=?").get(id) as { state: string; completed_at: number | null };
      if (["done", "cancelled"].includes(state.state) || state.completed_at !== null) throw new HistoryConflict("A settled reminder cannot be reopened by undo");
    }
    return row;
  }
  mutate<T>(table: Table, id: string, fields: string[], fn: () => T): T {
    const call = currentWriteCall() ?? newWriteCall({ origin: "domain", actor: "user" });
    if (!this.history.get(call.id)) this.history.begin(call, `${table}_edit`);
    try {
      return this.history.db.$client.transaction(() => {
        const before = this.read(table, id, fields);
        // Verify capture availability BEFORE calling a domain mutation.
        this.history.encrypt(before);
        const result = fn();
        const after = this.read(table, id, fields);
        const changed = fields.filter(f => before[f] !== after[f]);
        if (!changed.length) this.history.outcome(call.id, "no_effect", "adapter:row_unchanged");
        else {
          this.history.capture(call.id, { kind: "row-v1", table, id,
            before: Object.fromEntries(changed.map(f => [f, before[f]])),
            after: Object.fromEntries(changed.map(f => [f, after[f]])) });
          this.history.outcome(call.id, "committed", "adapter:row_committed");
        }
        return result;
      }).immediate();
    } catch (e) { this.history.outcome(call.id, "no_effect", "adapter:row_rolled_back"); throw e; }
  }
  private check(original: string, record: RowRecord) {
    if (record.kind !== "row-v1" || this.history.get(original)?.execution !== "committed") throw new HistoryConflict("No supported row inverse");
    if (this.history.db.$client.query("SELECT 1 FROM write_operations WHERE inverse_of=? AND execution IN ('committed','dispatch_started','partial')").get(original)) throw new HistoryConflict("Already reversed; redo the recorded inverse");
    const current = this.read(record.table, record.id, Object.keys(record.after));
    if (Object.keys(record.after).some(f => current[f] !== record.after[f])) throw new HistoryConflict("A changed field was edited later; undo requires a new reviewed edit");
  }
  planInverse(original: string) {
    const record = this.history.payload<RowRecord>(original); this.check(original, record);
    return this.history.plan("row-inverse", { original, record }, original);
  }
  applyInverse(planId: string, digest: string) {
    const plan = this.history.readPlan<{ original: string; record: RowRecord }>(planId);
    if (plan.kind !== "row-inverse" || plan.digest !== digest) throw new HistoryConflict("Wrong review plan");
    if (plan.state === "applied") return { operationId: plan.appliedOperationId };
    const call = newWriteCall({ origin: "review", actor: "user", idempotencyKey: `inverse:${planId}` });
    return this.history.db.$client.transaction(() => {
      const { original, record } = plan.value;
      this.check(original, record);
      this.history.claimPlan(planId, digest, call.id); this.history.begin(call, `${record.table}_undo`);
      this.history.inverse(call.id, original);
      const fields = Object.keys(record.before);
      withWriteCall(call, () => this.mutate(record.table, record.id, fields, () => {
        this.history.db.$client.query(`UPDATE ${record.table} SET ${fields.map(f => `${f}=?`).join(",")} WHERE id=?`)
          .run(...fields.map(f => record.before[f]!), record.id);
        if (record.table === "collection_items") this.history.db.$client.query("UPDATE collection_items SET updated_at=? WHERE id=?").run(this.history.now(), record.id);
        else this.history.db.$client.query("UPDATE entities SET updated_at=? WHERE id=?").run(this.history.now(), record.id);
      }));
      this.history.markPlan(planId, "applied"); this.history.response(call.id, "delivered");
      return { operationId: call.id };
    }).immediate();
  }
}
