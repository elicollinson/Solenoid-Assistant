// The Calendar surface, written to.
//
// ../queries/calendar.ts answers "what does the week draw". This is the other
// half. Four kinds sit on that canvas and only two of them are rows: an event
// and a hold own their content, so they are written here; a run and a reminder
// are projections built at query time from workflow_runs and reminders, and
// nothing in this file will write one. A calendar row for a run is a second
// copy of a run, and the two disagree by lunchtime.
//
// Five things can happen to a commitment:
//
//   create      it goes on the grid
//   reschedule  it moves in time, which is not the same act as editing it
//   cancel      it stops being on the grid without stopping having been there
//   attendees   who is coming is settled, or settled again
//   hold        time is offered rather than agreed
//
// What this file deliberately cannot do:
//
//   * write `state`. The mark on the grid is a reading of a run's state; a
//     commitment of yours is not running, and nothing here sets one.
//   * write `provider`, `externalId`, `etag` or `syncedAt`. Those belong to
//     whatever syncs with the external calendar. A row written here is local,
//     and saying it came from Google would not make Google agree.
//   * write `sourceId` or `workflowId` — the projection links, which is the
//     same rule as the first paragraph said.
//   * attach a hold to a decision. A hold does not open a question of its own:
//     it is one of the answers to a question the reminder already asked, and
//     wiring one from here would let a slot be attached to any question in the
//     database.
//   * put anything in a second timezone. Times come in as instants and the row
//     is stamped APP_TZ, which every code path may assume today; `tz` is on the
//     draft so that a second zone stays a data change rather than a migration.
//
// Every one of them answers with nothing, except the two that create rows and
// answer with the ids they minted. A mutation that returned its own idea of the
// new row would be a second answer to a question the next read settles anyway —
// the same bargain ./recommendations.ts strikes.
import { eq } from "drizzle-orm";
import { ulid, type Db } from "../index";
import { note as trail, touch, writeProse as writeSlots, type Tx } from "./_shared";
import * as s from "../schema";

/** Thrown when the id names no calendar row — HTTP 404. A run or a reminder id
 *  lands here too, and correctly: neither has a row in this table. */
export class NoSuchCalendarItemError extends Error {
  constructor(id: string) {
    super(`No calendar item with id ${id}`);
    this.name = "NoSuchCalendarItemError";
  }
}

/**
 * Thrown when something is asked of a cancelled row — moving it, cancelling it
 * twice, changing who is coming to it. HTTP 409: the request is well formed and
 * the thing it is about is no longer on the grid.
 */
export class CalendarItemCancelledError extends Error {
  constructor(id: string, wanted: string) {
    super(`Cannot ${wanted} ${id}: it is cancelled`);
    this.name = "CalendarItemCancelledError";
  }
}

/**
 * Thrown when a write lands on a row that only displays something else. Such a
 * row should not exist — the query layer builds runs and reminders rather than
 * storing them — but if one ever does, the fix belongs to the run or the
 * reminder, not to its shadow on the calendar. HTTP 409.
 */
export class CalendarProjectionError extends Error {
  constructor(id: string, kind: string, wanted: string) {
    super(`Cannot ${wanted} ${id}: it is a ${kind}, which the calendar only displays`);
    this.name = "CalendarProjectionError";
  }
}

/** Thrown when an attendee or an organiser names nobody — HTTP 404. */
export class NoSuchParticipantError extends Error {
  constructor(id: string) {
    super(`No participant with id ${id}`);
    this.name = "NoSuchParticipantError";
  }
}


type Row = typeof s.calendarItems.$inferSelect;

export interface AttendeeDraft {
  /** A participants row. Names are not accepted: two people called Marta are
   *  two rows, and guessing which one is coming is not this file's job. */
  participantId: string;
  response?: (typeof s.ATTENDEE_RESPONSE)[number];
  /** They are welcome but the thing happens without them. */
  optional?: boolean;
  /** Outside the household or the org. The surface says "no external invites
   *  changed", which it can only say because this is stored. */
  isExternal?: boolean;
}

export interface RecurrenceDraft {
  /** "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30". The query layer reads FREQ,
   *  BYDAY, BYHOUR and BYMINUTE and nothing else. */
  rrule: string;
  /** When it stops repeating. Null means it does not. */
  untilAt?: Date;
  /** Instants the series skips — the week the standup did not happen. */
  exdates?: readonly Date[];
}

export interface CalendarDraft {
  /** What it is, said the way you would say it out loud. */
  title: string;
  startsAt: Date;
  /** Absent means the surface draws an hour, which is its own guess and not a
   *  stored one. Give it when you know it. */
  endsAt?: Date;
  allDay?: boolean;
  location?: string;
  /** "Room 2 · four people" — the line under the title on the grid. */
  metaLabel?: string;
  /** Defaults to APP_TZ, which every code path may assume today. */
  tz?: string;
  /** Who put it there. The detail pane says "Set by me" or "Set by you". */
  setBy?: (typeof s.AUTHOR)[number];
  /** Whose meeting it is. A participants row, like every attendee. */
  organizerId?: string;
  attendees?: readonly AttendeeDraft[];
  recurrence?: RecurrenceDraft;
  /** The item this is an occurrence of, when it belongs to a series. */
  seriesId?: string;
  /** "Why it is here", one string per paragraph, shown on the detail pane. */
  account?: readonly string[];
}

function require_(db: Db, id: string): Row {
  const [row] = db.select().from(s.calendarItems).where(eq(s.calendarItems.id, id)).limit(1).all();
  if (!row) throw new NoSuchCalendarItemError(id);
  return row;
}

/** The row, if it is one this file may change at all. */
function requireWritable(db: Db, id: string, wanted: string): Row {
  const row = require_(db, id);
  if (row.kind !== "event" && row.kind !== "hold") {
    throw new CalendarProjectionError(id, row.kind, wanted);
  }
  if (row.status === "cancelled") throw new CalendarItemCancelledError(id, wanted);
  return row;
}

function requireParticipant(t: Tx, id: string): void {
  const [found] = t.select({ id: s.participants.id }).from(s.participants).where(eq(s.participants.id, id)).limit(1).all();
  if (!found) throw new NoSuchParticipantError(id);
}


/**
 * One line on the object's history trail.
 *
 * The row itself keeps only the LAST move, in `movedFromAt` and its two
 * companions, because that is what the detail pane shows. A thing moved twice
 * has been moved twice, so each move is also written here, where the second one
 * does not overwrite the first.
 */
function note(t: Tx, subjectId: string, at: Date, eventKind: string, text: string, by: (typeof s.AUTHOR)[number]): void {
  trail(t, subjectId, text, at, { actor: by, eventKind });
}

function checkSpan(startsAt: Date, endsAt: Date | undefined): void {
  if (endsAt && endsAt.getTime() < startsAt.getTime()) {
    throw new Error("A calendar item cannot end before it starts");
  }
}

function writeAttendees(t: Tx, itemId: string, attendees: readonly AttendeeDraft[]): void {
  // Replaced wholesale rather than merged: "who is coming" is a list, and there
  // is no sensible way to patch the third person in it. The primary key is
  // (item, participant), so a repeat in the same call would fail the insert
  // rather than quietly winning, which is why it is cleared first.
  t.delete(s.calendarAttendees).where(eq(s.calendarAttendees.calendarItemId, itemId)).run();
  const seen = new Set<string>();
  for (const attendee of attendees) {
    if (seen.has(attendee.participantId)) continue;
    seen.add(attendee.participantId);
    requireParticipant(t, attendee.participantId);
    t.insert(s.calendarAttendees)
      .values({
        calendarItemId: itemId,
        participantId: attendee.participantId,
        response: attendee.response ?? "none",
        optional: attendee.optional ?? false,
        isExternal: attendee.isExternal ?? false,
      })
      .run();
  }
}

function writeAccount(t: Tx, subjectId: string, account: readonly string[], now: Date): void {
  // Trimmed and emptied out here rather than in the shared writer: a blank
  // paragraph in the middle of an account is this surface's mistake to catch.
  writeSlots(t, subjectId, { account: account.map((p) => p.trim()).filter(Boolean) }, now);
}

/* ── the writes ─────────────────────────────────────────────────────────── */

/**
 * Put a commitment on the grid. Answers with the id it minted.
 *
 * It lands `confirmed`, which is what makes it a thing that is happening rather
 * than a thing being offered — see `offerCalendarHolds` for the other case.
 *
 * The id is minted from `startsAt` rather than from now, so calendar ids sort
 * by when the thing happens. That is how the seed mints them and how anything
 * reading a range of ids will expect them to read.
 */
export function createCalendarItem(db: Db, draft: CalendarDraft, now: Date = new Date()): string {
  const title = draft.title.trim();
  if (!title) throw new Error("A calendar item needs a title: it is the thing you are being asked to be at");
  checkSpan(draft.startsAt, draft.endsAt);

  return db.transaction((t) => {
    if (draft.organizerId) requireParticipant(t, draft.organizerId);

    const id = ulid(draft.startsAt.getTime());
    t.insert(s.entities).values({ id, kind: "calendar_item", createdAt: now, updatedAt: now }).run();
    t.insert(s.calendarItems)
      .values({
        id,
        kind: "event",
        title,
        metaLabel: draft.metaLabel?.trim() || null,
        location: draft.location?.trim() || null,
        startsAt: draft.startsAt,
        endsAt: draft.endsAt ?? null,
        tz: draft.tz ?? s.APP_TZ,
        allDay: draft.allDay ?? false,
        status: "confirmed",
        setBy: draft.setBy ?? "agent",
        organizerId: draft.organizerId ?? null,
        seriesId: draft.seriesId ?? null,
      })
      .run();

    if (draft.recurrence) writeRecurrence(t, id, draft.recurrence);
    if (draft.attendees?.length) writeAttendees(t, id, draft.attendees);
    if (draft.account?.length) writeAccount(t, id, draft.account, now);
    return id;
  });
}

function writeRecurrence(t: Tx, itemId: string, recurrence: RecurrenceDraft): void {
  const rrule = recurrence.rrule.trim();
  if (!rrule) throw new Error("A repeat needs an rrule: without one there is nothing to repeat by");
  t.insert(s.calendarRecurrences)
    .values({
      itemId,
      rrule,
      // The series repeats in the zone the product runs in, for the same reason
      // the item is stamped with it.
      tz: s.APP_TZ,
      untilAt: recurrence.untilAt ?? null,
      exdates: (recurrence.exdates ?? []).map((d) => d.getTime()),
    })
    .run();
}

export interface Move {
  startsAt: Date;
  /** Absent keeps the length it had: moving something is not shortening it. */
  endsAt?: Date;
  /** Who moved it, and why, in the mover's voice: "Latham asked for the
   *  morning". The detail pane says "Moved from Aug 25" and this is the rest
   *  of that sentence. */
  by?: (typeof s.AUTHOR)[number];
  because?: string;
}

/**
 * Move one in time.
 *
 * A different act from editing it: what it is has not changed, only when, and
 * the row records where it came from so the surface can say "moved from the
 * 25th" instead of quietly showing a different day than the one somebody wrote
 * down. Only the last move is on the row; every move is on the history trail.
 *
 * A move with no new end keeps the length it had, because "put the review an
 * hour later" is not "make the review shorter".
 */
export function rescheduleCalendarItem(db: Db, id: string, move: Move, now: Date = new Date()): void {
  const row = requireWritable(db, id, "reschedule");
  checkSpan(move.startsAt, move.endsAt);

  const shift = move.startsAt.getTime() - row.startsAt.getTime();
  const endsAt = move.endsAt ?? (row.endsAt ? new Date(row.endsAt.getTime() + shift) : null);
  if (shift === 0 && !move.endsAt) {
    throw new Error(`Cannot reschedule ${id}: it already starts then, and a move that moves nothing is not a move`);
  }

  const by = move.by ?? "agent";
  db.transaction((t) => {
    t.update(s.calendarItems)
      .set({
        startsAt: move.startsAt,
        endsAt,
        movedFromAt: row.startsAt,
        movedBy: by,
        movedReason: move.because?.trim() || null,
      })
      .where(eq(s.calendarItems.id, id))
      .run();
    note(t, id, now, "moved", move.because?.trim() || `Moved ${row.title}`, by);
    touch(t, id, now);
  });
}

/**
 * Take it off the grid.
 *
 * The row stays, `cancelled`. Everything that draws the week filters on status
 * rather than on the row's absence, so a cancelled meeting is one that was in
 * the diary and is not any more — which is a different thing from one that was
 * never there, and is what somebody looking for it next week needs to find.
 *
 * Cancelling a held slot releases it as a consequence: an offer nobody can take
 * up any more is released, and the holds table is where that is recorded.
 */
export function cancelCalendarItem(
  db: Db,
  id: string,
  reason: { by?: (typeof s.AUTHOR)[number]; because?: string } = {},
  now: Date = new Date(),
): void {
  const row = requireWritable(db, id, "cancel");
  const by = reason.by ?? "agent";

  db.transaction((t) => {
    t.update(s.calendarItems).set({ status: "cancelled" }).where(eq(s.calendarItems.id, id)).run();

    const [hold] = t.select().from(s.calendarHolds).where(eq(s.calendarHolds.id, id)).limit(1).all();
    if (hold && !hold.releasedAt) {
      t.update(s.calendarHolds).set({ releasedAt: now }).where(eq(s.calendarHolds.id, id)).run();
    }

    note(t, id, now, "cancelled", reason.because?.trim() || `Cancelled ${row.title}`, by);
    touch(t, id, now);
  });
}

/**
 * Settle who is coming.
 *
 * The whole list, every time: pass everyone who is invited, not only the ones
 * who changed. Anybody left out is uninvited, which is the honest reading of a
 * list that no longer names them.
 */
export function setCalendarAttendees(
  db: Db,
  id: string,
  attendees: readonly AttendeeDraft[],
  now: Date = new Date(),
): void {
  requireWritable(db, id, "set attendees on");
  db.transaction((t) => {
    writeAttendees(t, id, attendees);
    touch(t, id, now);
  });
}

/** One of the windows being offered. */
export interface HoldWindow {
  startsAt: Date;
  endsAt?: Date;
  /** What is wrong with this one, if something is: "runs into the standup". */
  clashNote?: string;
}

export interface HoldOffer {
  /** What the time is for, said once for every window in the offer. */
  title: string;
  /** The alternatives. Offering them in one call is the point: they are one
   *  question, and taking one of them releases the others. */
  windows: readonly HoldWindow[];
  location?: string;
  metaLabel?: string;
  /** Who offered them. A participants row — the contractor, not you. */
  offeredById?: string;
  /** When the offer was made, if that is not now. */
  offeredAt?: Date;
  /** When it lapses. An offer with no expiry is one nobody has to answer. */
  expiresAt?: Date;
  /** An existing group, to add a window to an offer already made. Absent mints
   *  a new one. */
  holdGroupId?: string;
  setBy?: (typeof s.AUTHOR)[number];
}

/**
 * Offer time rather than take it.
 *
 * Every window lands as a `hold` marked `tentative`, sharing one
 * `holdGroupId` — so the two boiler windows are one question with two answers,
 * and releasing the one nobody took is a consequence of taking the other rather
 * than a second decision. Nothing here agrees to anything: a hold is what the
 * grid draws while the answer is outstanding.
 *
 * Answers with the group and the ids it minted, in the order the windows were
 * given.
 */
export function offerCalendarHolds(
  db: Db,
  offer: HoldOffer,
  now: Date = new Date(),
): { holdGroupId: string; ids: string[] } {
  const title = offer.title.trim();
  if (!title) throw new Error("A hold needs a title: it is what the time would be for");
  if (!offer.windows.length) throw new Error("A hold needs at least one window: there is nothing to offer otherwise");
  for (const window of offer.windows) checkSpan(window.startsAt, window.endsAt);

  const offeredAt = offer.offeredAt ?? now;
  // Readable rather than opaque, because this id turns up in a clash note and
  // in the log long before anybody looks it up.
  const holdGroupId = offer.holdGroupId ?? `hold-${ulid(offeredAt.getTime())}`;

  return db.transaction((t) => {
    if (offer.offeredById) requireParticipant(t, offer.offeredById);

    const ids = offer.windows.map((window) => {
      const id = ulid(window.startsAt.getTime());
      t.insert(s.entities).values({ id, kind: "calendar_item", createdAt: now, updatedAt: now }).run();
      t.insert(s.calendarItems)
        .values({
          id,
          kind: "hold",
          title,
          metaLabel: offer.metaLabel?.trim() || null,
          location: offer.location?.trim() || null,
          startsAt: window.startsAt,
          endsAt: window.endsAt ?? null,
          tz: s.APP_TZ,
          // Nothing is agreed until one of them is picked, and the column says so.
          status: "tentative",
          setBy: offer.setBy ?? "agent",
          holdGroupId,
        })
        .run();
      t.insert(s.calendarHolds)
        .values({
          id,
          holdGroupId,
          offeredById: offer.offeredById ?? null,
          offeredAt,
          expiresAt: offer.expiresAt ?? null,
          clashNote: window.clashNote?.trim() || null,
        })
        .run();
      return id;
    });

    return { holdGroupId, ids };
  });
}
