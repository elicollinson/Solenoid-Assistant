import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { ulid } from "../db";
import * as s from "../db/schema";
import type { PushClient, PushMessage, PushResult } from "./client";
import { PushoverClient, messageSchema } from "./client";
import { loadPushoverConfig, pushoverStatus, type PushoverConfig } from "./config";

type Delivery = typeof s.pushDeliveries.$inferSelect;
export const STALE_SUBMISSION_MS = 60_000; // greater than the maximum HTTP deadline
export const REMINDER_POLL_MS = 5_000;

function event(db: Db, reminderId: string | null, text: string, now: number) {
  if (!reminderId || !db.select({ id: s.reminders.id }).from(s.reminders).where(eq(s.reminders.id, reminderId)).get()) return;
  db.insert(s.subjectEvents).values({ id: ulid(), subjectId: reminderId, at: new Date(now), actor: "system", eventKind: "push_notification", text }).run();
}

/** Expired reservations are never reclaimed: a crash may follow acceptance. */
export function expireSubmissions(db: Db, now: number) {
  db.$client.transaction(() => {
    const expired = db.$client.query<{ id: string; reminder_id: string | null }, [number]>(
      "SELECT id, reminder_id FROM push_deliveries WHERE state = 'submitting' AND updated_at <= ?").all(now - STALE_SUBMISSION_MS);
    for (const row of expired) {
      db.update(s.pushDeliveries).set({ state: "unknown", errorCode: "interrupted_submission", updatedAt: now }).where(eq(s.pushDeliveries.id, row.id)).run();
      event(db, row.reminder_id, "Push acceptance is unknown after an interrupted attempt. It will not be automatically resent.", now);
    }
  }).immediate();
}

function busy(db: Db, now: number): boolean {
  return !!db.$client.query("SELECT 1 FROM push_deliveries WHERE state = 'submitting' LIMIT 1").get() ||
    !!db.$client.query("SELECT 1 FROM push_provider_state WHERE provider = 'pushover' AND blocked_until > ?").get(now);
}

function finish(db: Db, id: string, result: PushResult, now: number) {
  db.$client.transaction(() => {
    const row = db.select().from(s.pushDeliveries).where(eq(s.pushDeliveries.id, id)).get();
    // A late acceptance may resolve an expired reservation without another send.
    if (!row || !["submitting", "unknown"].includes(row.state)) return;
    let state: Delivery["state"] = result.status === "not_sent" ? "pending" : result.status;
    let nextAttemptAt = now + 60_000;
    if (result.code === "invalid_message") state = "rejected";
    if (result.status === "rejected" && result.httpStatus === 429) {
      const reset = (result.quota?.resetAt ?? 0) * 1000;
      nextAttemptAt = Number.isSafeInteger(reset) && reset > now ? reset : now + 3_600_000;
      state = row.reminderId ? "pending" : "rejected";
      db.insert(s.pushProviderState).values({ provider: "pushover", blockedUntil: nextAttemptAt })
        .onConflictDoUpdate({ target: s.pushProviderState.provider, set: { blockedUntil: nextAttemptAt } }).run();
    }
    if (state === "pending" && row.reminderId) {
      // Closing/rescheduling during a definitely-unsent attempt wins over retry.
      const reminder = db.select().from(s.reminders).where(eq(s.reminders.id, row.reminderId)).get();
      const replacement = db.$client.query("SELECT 1 FROM push_deliveries WHERE reminder_id = ? AND id <> ? AND state = 'pending' LIMIT 1").get(row.reminderId, row.id);
      if (!reminder || reminder.completedAt || ["done", "cancelled"].includes(reminder.state) || !reminder.dueAt ||
        Math.max(reminder.dueAt.getTime(), reminder.snoozedUntil?.getTime() ?? reminder.dueAt.getTime()) !== row.scheduledFor || replacement) state = "cancelled";
    }
    db.update(s.pushDeliveries).set({ state, nextAttemptAt, updatedAt: now, providerRequestId: result.providerRequestId, errorCode: result.code })
      .where(eq(s.pushDeliveries.id, id)).run();
    const text = state === "accepted" ? "Push accepted by Pushover. Device delivery is unverified."
      : state === "unknown" ? "Push acceptance is unknown. It will not be automatically resent."
      : state === "rejected" ? "Push was not accepted. Check Pushover setup before scheduling another attempt."
      : state === "pending" && result.httpStatus === 429 ? "Pushover rejected this push because of its quota. Delivery is pending until the sending allowance resets."
      : null;
    if (text) event(db, row.reminderId, text, now);
  }).immediate();
}

async function attempt(client: PushClient, message: PushMessage, signal?: AbortSignal): Promise<PushResult> {
  try { return await client.send(message, signal); }
  catch { return { status: "unknown", code: "acceptance_unverified", providerRequestId: null }; }
}

/** One due occurrence per tick. No model call or second approval at due time. */
export async function deliverDueReminder(db: Db, options: {
  config?: PushoverConfig; client?: PushClient; now?: () => number; signal?: AbortSignal;
} = {}) {
  const clock = options.now ?? Date.now;
  const now = clock();
  expireSubmissions(db, now);
  const config = options.config ?? loadPushoverConfig();
  if (!pushoverStatus(config).remindersReady || options.signal?.aborted) return null;
  const claimed = db.$client.transaction(() => {
    if (busy(db, now)) return null;
    const row = db.$client.query<{ id: string; title: string }, [number, number]>(`
      SELECT p.id, r.title FROM push_deliveries p JOIN reminders r ON r.id = p.reminder_id
      WHERE p.state = 'pending' AND p.scheduled_for <= ? AND p.next_attempt_at <= ?
        AND r.completed_at IS NULL AND r.state NOT IN ('done', 'cancelled') AND r.due_at IS NOT NULL
        AND p.scheduled_for = max(r.due_at, coalesce(r.snoozed_until, r.due_at))
      ORDER BY p.scheduled_for, p.id LIMIT 1`).get(now, now);
    if (!row) return null;
    db.$client.query("UPDATE push_deliveries SET state = 'submitting', updated_at = ?, attempts = attempts + 1 WHERE id = ? AND state = 'pending'").run(now, row.id);
    return row;
  }).immediate();
  if (!claimed) return null;
  // Preserve internal titles; truncate only the notification copy when necessary.
  const points = [...claimed.title.toWellFormed()];
  const message = points.length > 1024 ? points.slice(0, 1023).join("") + "…" : points.join("");
  const result = await attempt(options.client ?? new PushoverClient(config), { title: "Solenoid reminder", message }, options.signal);
  finish(db, claimed.id, result, clock());
  return { id: claimed.id, ...result };
}

/** Durable deduplication for explicit chat sends; uses the same shared reservation. */
export async function sendPush(db: Db, requestId: string, message: PushMessage, options: {
  config?: PushoverConfig; client?: PushClient; now?: () => number; signal?: AbortSignal;
} = {}) {
  const config = options.config ?? loadPushoverConfig();
  if (!pushoverStatus(config).ready) throw new Error("Pushover is disabled or unconfigured; no notification was sent. Use pushover_status for setup requirements.");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) throw new Error("Invalid push requestId; no notification was sent.");
  const input = messageSchema.parse(message);
  const clock = options.now ?? Date.now;
  const now = clock();
  const id = `manual:${requestId}`;
  const hash = createHash("sha256").update(JSON.stringify([config.appToken, config.userKey, input.message, input.title ?? "Solenoid Assistant", input.url ?? null, input.urlTitle ?? null])).digest("hex");
  expireSubmissions(db, now);
  const reservation = db.$client.transaction(() => {
    const old = db.select().from(s.pushDeliveries).where(eq(s.pushDeliveries.id, id)).get();
    if (old) {
      if (old.payloadHash !== hash) throw new Error("requestId already belongs to a different notification; nothing sent.");
      // Pending manual entries represent a client-confirmed pre-dispatch failure.
      // Unlike unknown submissions, they can safely use the same ID again.
      if (old.state === "pending" && old.nextAttemptAt <= now && !options.signal?.aborted && !busy(db, now)) {
        db.update(s.pushDeliveries).set({ state: "submitting", updatedAt: now, attempts: old.attempts + 1 }).where(eq(s.pushDeliveries.id, id)).run();
        return null;
      }
      return old;
    }
    if (options.signal?.aborted) throw new Error("Cancelled before sending; no notification was sent.");
    if (busy(db, now)) throw new Error("Pushover is busy or its quota is exhausted; no notification was sent. Retry later with this requestId.");
    db.insert(s.pushDeliveries).values({ id, scheduledFor: now, state: "submitting", payloadHash: hash, attempts: 1, updatedAt: now }).run();
    return null;
  }).immediate();
  if (reservation) {
    if (reservation.state !== "accepted") throw new Error(`Pushover request ${requestId}: ${reservation.state}; no duplicate submitted. Unknown/submitting outcomes must not be automatically resent with a new ID.`);
    return { provider: "pushover", status: "accepted", requestId, providerRequestId: reservation.providerRequestId,
      delivery: "unverified", acknowledgement: "unavailable", duplicateSuppressed: true };
  }
  const result = await attempt(options.client ?? new PushoverClient(config), input, options.signal);
  finish(db, id, result, clock());
  if (result.status !== "accepted") throw new Error(JSON.stringify({ ...result, requestId, automaticRetry: false,
    explanation: result.status === "unknown" ? "Acceptance could not be determined. Do not automatically resend." : "Notification was not accepted." }));
  return { provider: "pushover", status: "accepted", requestId, providerRequestId: result.providerRequestId,
    delivery: "unverified", acknowledgement: "unavailable", duplicateSuppressed: false, quota: result.quota };
}
