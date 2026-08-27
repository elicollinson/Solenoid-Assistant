// Reminders.
//
// Overdue / Today / This week / Someday is DERIVED from dueAt at query time
// (Someday = dueAt is null). A stored "Today" is wrong by morning.
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { APP_TZ, AUTHOR, inList, ts, tsReq } from "./_shared";
import { entityId, entityRefNull } from "./entities";
import { decisions } from "./decisions";
import { workflowInstructions } from "./workflows";

export const REMINDER_STATE = ["attention", "running", "done", "idle", "cancelled"] as const;
export const REMINDER_ORIGIN = ["okf", "conversation", "message", "workflow", "screenshot", "manual"] as const;

export const reminders = sqliteTable("reminders", {
  id: entityId(),
  title: text().notNull(),
  state: text({ enum: REMINDER_STATE }).notNull().default("idle"),
  /** Null = "Someday" / "No date". */
  dueAt: ts(),
  dueTz: text().notNull().default(APP_TZ),
  allDay: integer({ mode: "boolean" }).notNull().default(false),
  setBy: text({ enum: AUTHOR }).notNull().default("agent"),
  setAt: tsReq(),
  /** "from okf:vendor/ferris-terms" / "from thread/9a44" / "set by me" */
  originKind: text({ enum: REMINDER_ORIGIN }).notNull().default("manual"),
  originId: entityRefNull(),
  originLabel: text(),
  completedAt: ts(),
  completedBy: text({ enum: AUTHOR }),
  /** "closed without asking; you'd already sent them" */
  completedReason: text(),
  snoozedUntil: ts(),
  decisionId: text().references(() => decisions.id, { onDelete: "set null" }),
  instructionId: text().references(() => workflowInstructions.id, { onDelete: "set null" }),
  recurrenceRrule: text(),
}, (t) => [
  check("reminders_state_check", inList(t.state, REMINDER_STATE)),
  check("reminders_origin_check", inList(t.originKind, REMINDER_ORIGIN)),
  index("reminders_due").on(t.dueAt).where(sql`${t.completedAt} is null and ${t.state} <> 'cancelled'`),
  index("reminders_open").on(t.state, t.dueAt).where(sql`${t.completedAt} is null`),
]);
