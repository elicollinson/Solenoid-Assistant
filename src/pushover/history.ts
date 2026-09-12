import type { Db } from "../db";
import { currentWriteCall, newWriteCall } from "../core/writeExecution";
import { WriteHistory } from "../writeHistory/history";
import type { PushResult } from "./client";

/** Called inside the delivery reservation transaction, before network dispatch.
 * This independent receipt survives deletion of the reminder and push row.
 * Notification text, recipient keys and credentials never enter the receipt.
 */
export function reservePushHistory(db: Db, deliveryId: string) {
  const row = db.$client.query("SELECT attempts,reminder_id FROM push_deliveries WHERE id=?").get(deliveryId) as { attempts: number; reminder_id: string | null };
  const id = `push:${deliveryId}:${row.attempts}`;
  const h = new WriteHistory(db);
  h.begin(newWriteCall({ id, parentId: currentWriteCall()?.id, origin: "pushover", actor: row.reminder_id ? "system" : "agent" }), "pushover_attempt");
  h.targets(id, [deliveryId, ...(row.reminder_id ? [`reminder:${row.reminder_id}`] : [])]);
  h.db.$client.query("UPDATE write_operations SET capability='history_only' WHERE id=?").run(id);
  h.outcome(id, "dispatch_started", "adapter:push_reserved");
}

export function finishPushHistory(db: Db, deliveryId: string, result: PushResult) {
  const row = db.$client.query("SELECT attempts FROM push_deliveries WHERE id=?").get(deliveryId) as { attempts: number } | null;
  const outcome = result.status === "accepted" ? "committed" : result.status === "unknown" ? "outcome_unknown" : "no_effect";
  const code = `push_${result.status}`;
  const h = new WriteHistory(db);
  const orphan = row ? null : db.$client.query("SELECT o.id FROM write_operations o JOIN write_events e ON e.operation_id=o.id WHERE o.origin='pushover' AND e.kind='target' AND e.code=? ORDER BY o.created_at DESC,o.id DESC LIMIT 1").get(deliveryId) as { id: string } | null;
  const id = row ? `push:${deliveryId}:${row.attempts}` : orphan?.id;
  if (id) {
    h.outcome(id, outcome, `adapter:${code}`);
    if (result.providerRequestId && /^[\w-]{1,200}$/.test(result.providerRequestId)) h.event(id, "provider_receipt", result.providerRequestId);
    h.response(id, "delivered");
  }

}
