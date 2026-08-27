// The calendar.
//
// Four kinds sit on the grid: event (yours), run (mine), reminder (a point in
// time), hold (offered, not agreed). Only events and holds own content — a run
// row and a reminder row carry a sourceId and nothing else of their own, so
// "Call Marta back" cannot say one thing on Reminders and another here.
//
// Future scheduled runs are NOT materialised. Expand workflowSchedules at query
// time for the visible window and backfill sourceId once a run actually starts;
// writing rows for them is a cron job that quietly forks from the schedule.
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { APP_TZ, AUTHOR, inList, json, ts, tsReq } from "./_shared";
import { entityId, entityRefOwned } from "./entities";
import { decisions } from "./decisions";
import { participants } from "./people";
import { workflows } from "./workflows";

export const CALENDAR_KIND = ["event", "run", "reminder", "hold"] as const;
/** Only these four are ever marked; anything merely scheduled has no state. */
export const CALENDAR_STATE = ["attention", "running", "done", "failed"] as const;
export const CALENDAR_STATUS = ["confirmed", "tentative", "cancelled"] as const;
export const CALENDAR_PROVIDER = ["google", "ical", "exchange", "local", "agent"] as const;

export const calendarItems = sqliteTable("calendar_items", {
  id: entityId(),
  kind: text({ enum: CALENDAR_KIND }).notNull(),
  state: text({ enum: CALENDAR_STATE }),
  title: text().notNull(),
  /** "Room 2 · four people" */
  metaLabel: text(),
  location: text(),
  startsAt: tsReq(),
  endsAt: ts(),
  /** The app is single-timezone today; the column keeps a second zone a data
   *  change rather than a migration. */
  tz: text().notNull().default(APP_TZ),
  allDay: integer({ mode: "boolean" }).notNull().default(false),
  status: text({ enum: CALENDAR_STATUS }).notNull().default("confirmed"),
  /** Projection link: the run or reminder this row displays. Cascades: a
   *  projection of a deleted run is not a calendar entry, it is a ghost. */
  sourceId: entityRefOwned(),
  workflowId: text().references(() => workflows.id, { onDelete: "set null" }),
  provider: text({ enum: CALENDAR_PROVIDER }).notNull().default("local"),
  externalId: text(),
  externalCalendarId: text(),
  etag: text(),
  syncedAt: ts(),
  organizerId: text().references(() => participants.id, { onDelete: "set null" }),
  setBy: text({ enum: AUTHOR }).notNull().default("user"),
  /** "I moved it from the 25th when Latham asked" */
  movedFromAt: ts(),
  movedBy: text({ enum: AUTHOR }),
  movedReason: text(),
  /** The two boiler windows share a group and a decision, so accepting one is
   *  a single write and releasing the other is a consequence. */
  holdGroupId: text(),
  decisionId: text().references(() => decisions.id, { onDelete: "set null" }),
  seriesId: text().references((): AnySQLiteColumn => calendarItems.id, { onDelete: "cascade" }),
}, (t) => [
  check("calendar_items_kind_check", inList(t.kind, CALENDAR_KIND)),
  check("calendar_items_state_check", sql`${t.state} is null or ${inList(t.state, CALENDAR_STATE)}`),
  check("calendar_items_status_check", inList(t.status, CALENDAR_STATUS)),
  uniqueIndex("calendar_items_external").on(t.provider, t.externalId),
  index("calendar_window").on(t.startsAt, t.endsAt).where(sql`${t.status} <> 'cancelled'`),
  index("calendar_holds_group").on(t.holdGroupId).where(sql`${t.holdGroupId} is not null`),
]);

/** "Standup, weekly" is otherwise unrepresentable. */
export const calendarRecurrences = sqliteTable("calendar_recurrences", {
  itemId: text().primaryKey().references(() => calendarItems.id, { onDelete: "cascade" }),
  rrule: text().notNull(),
  tz: text().notNull().default(APP_TZ),
  untilAt: ts(),
  exdates: json<number[]>().notNull().default(sql`'[]'`),
});

export const ATTENDEE_RESPONSE = ["accepted", "declined", "tentative", "none"] as const;

export const calendarAttendees = sqliteTable("calendar_attendees", {
  calendarItemId: text().notNull().references(() => calendarItems.id, { onDelete: "cascade" }),
  participantId: text().notNull().references(() => participants.id, { onDelete: "cascade" }),
  response: text({ enum: ATTENDEE_RESPONSE }).notNull().default("none"),
  optional: integer({ mode: "boolean" }).notNull().default(false),
  /** "No external invites changed." */
  isExternal: integer({ mode: "boolean" }).notNull().default(false),
}, (t) => [
  check("calendar_attendees_response_check", inList(t.response, ATTENDEE_RESPONSE)),
  primaryKey({ columns: [t.calendarItemId, t.participantId] }),
]);

export const calendarHolds = sqliteTable("calendar_holds", {
  id: text().primaryKey().references(() => calendarItems.id, { onDelete: "cascade" }),
  holdGroupId: text().notNull(),
  offeredById: text().references(() => participants.id, { onDelete: "set null" }),
  offeredAt: tsReq(),
  expiresAt: ts(),
  acceptedAt: ts(),
  releasedAt: ts(),
  /** "runs into the standup" */
  clashNote: text(),
}, (t) => [index("calendar_holds_by_group").on(t.holdGroupId)]);
