import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { inList } from "./_shared";
import { reminders } from "./reminders";

export const PUSH_STATE = ["pending", "submitting", "accepted", "rejected", "unknown", "cancelled"] as const;
/** Durable send reservations. No credentials or notification body are stored here. */
export const pushDeliveries = sqliteTable("push_deliveries", {
  id: text().primaryKey().notNull(),
  reminderId: text().references(() => reminders.id, { onDelete: "cascade" }),
  scheduledFor: integer().notNull(),
  state: text({ enum: PUSH_STATE }).notNull().default("pending"),
  payloadHash: text(),
  attempts: integer().notNull().default(0),
  nextAttemptAt: integer().notNull().default(0),
  updatedAt: integer().notNull().default(0),
  providerRequestId: text(),
  errorCode: text(),
}, t => [check("push_state_check", inList(t.state, PUSH_STATE)), index("push_pending").on(t.state, t.nextAttemptAt, t.scheduledFor),
  index("push_reminder").on(t.reminderId)]);

/** A shared provider cooldown across chat and all workers using this database. */
export const pushProviderState = sqliteTable("push_provider_state", {
  provider: text().primaryKey().notNull(),
  blockedUntil: integer().notNull().default(0),
});
