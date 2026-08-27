// One identity per person or org, many handles. Unifies iMessage senders,
// email addresses and calendar attendees, and hangs them off the OKF contact
// object — so "Marta Reyes" is one thing across texts, mail, calendar and
// memory.
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { TRUST_STATE, inList, ts, tsReq } from "./_shared";
import { entityId } from "./entities";

export const PARTICIPANT_KIND = ["person", "org", "agent", "system", "self"] as const;
export const HANDLE_KIND = ["phone", "email", "imessage", "handle", "other"] as const;

export const participants = sqliteTable("participants", {
  id: entityId(),
  kind: text({ enum: PARTICIPANT_KIND }).notNull(),
  displayName: text().notNull(),
  /** okf:contact/marta — the link between a handle and what the agent knows. */
  okfUri: text(),
  orgLabel: text(),
  trustState: text({ enum: TRUST_STATE }).notNull().default("unknown"),
  createdAt: tsReq(),
}, (t) => [
  check("participants_kind_check", inList(t.kind, PARTICIPANT_KIND)),
  check("participants_trust_check", inList(t.trustState, TRUST_STATE)),
  index("participants_okf").on(t.okfUri).where(sql`${t.okfUri} is not null`),
]);

export const participantHandles = sqliteTable("participant_handles", {
  id: text().primaryKey(),
  participantId: text().notNull().references(() => participants.id, { onDelete: "cascade" }),
  kind: text({ enum: HANDLE_KIND }).notNull(),
  /** E.164 for phones, lowercased for email. Normalise before writing. */
  value: text().notNull(),
  isPrimary: integer({ mode: "boolean" }).notNull().default(false),
  verifiedAt: ts(),
}, (t) => [
  check("participant_handles_kind_check", inList(t.kind, HANDLE_KIND)),
  uniqueIndex("participant_handles_value").on(t.kind, t.value),
]);
