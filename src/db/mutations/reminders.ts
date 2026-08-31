// The Reminders surface, written to.
//
// ../queries/reminders.ts answers "what does this screen draw". This is the
// other half. There are four things that can happen to a reminder:
//
//   create    the agent (or you, through it) puts something on the list
//   revise    the wording or the date is sharpened, while it is still open
//   complete  the thing was done
//   dismiss   the thing will not be done, and that is a different fact
//
// Complete and dismiss are separate on purpose. Both close a reminder and both
// land it in "Closed", but "I sent the invoice" and "you decided not to" are
// not the same sentence, and a single `close(state)` would let a caller write
// one when it meant the other by getting an argument wrong.
//
// Nothing here writes a bucket, a mark, a "when", or the count in the header.
// All four are read off `dueAt` and `state` against the clock — see the note at
// the top of the query file. A stored "Today" is wrong by morning.
//
// Nor does anything here open a decision. A reminder that gates you is a
// question with buttons on it, and the gate on the detail pane is drawn from
// `decisions`; these writes only SETTLE a question somebody else opened, when
// closing the reminder it hangs off. A reminder nags, it does not ask.
//
// Every one of them answers with nothing (except `createReminder`, which
// answers with the id it minted) and leaves the caller to re-read — the same
// bargain ./recommendations.ts and ./workflows.ts strike.
import { eq } from "drizzle-orm";
import { ulid, type Db } from "../index";
import {
  touch,
  writePairs as writeAttributePairs,
  writeProse as writeSlots,
  type Tx,
} from "./_shared";
import * as s from "../schema";

/** Thrown when the id names nothing this database knows — HTTP 404. */
export class NoSuchReminderError extends Error {
  constructor(id: string) {
    super(`No reminder with id ${id}`);
    this.name = "NoSuchReminderError";
  }
}

/**
 * Thrown when something is asked of a reminder that is already closed —
 * rewriting one you finished, completing one you called off.
 *
 * HTTP 409: the request is well formed and the row has simply moved on. Closing
 * is the one-way door on this surface; there is no re-opening write, because a
 * thing that came back is a new reminder rather than the old one undone.
 */
export class ReminderSettledError extends Error {
  constructor(id: string, state: string, wanted: string) {
    super(`Cannot ${wanted} ${id}: it is already ${state}`);
    this.name = "ReminderSettledError";
  }
}


type Row = typeof s.reminders.$inferSelect;
type Author = (typeof s.AUTHOR)[number];

/**
 * The states a reminder can be in while it is still yours to do.
 *
 * Subtracted from the schema's own list rather than written out, so a sixth
 * state added to the table lands here without anybody remembering to: `done`
 * and `cancelled` are reached through `completeReminder` and `dismissReminder`
 * and nowhere else.
 */
export type OpenReminderState = Exclude<(typeof s.REMINDER_STATE)[number], "done" | "cancelled">;

/** A `[label, value]` line of the pairs under "This reminder". */
export type MetaPair = readonly [label: string, value: string];

/** Where a reminder came from, when it came from something. */
export interface ReminderOrigin {
  kind?: (typeof s.REMINDER_ORIGIN)[number];
  /** The entity it was drawn from — a conversation, a message, a run. It has
   *  to exist: an origin pointing at nothing is worse than no origin. */
  id?: string;
  /** What the row says under the title: "from okf:vendor/ferris-terms",
   *  "from thread/9a44". Absent reads as "set by me". */
  label?: string;
}

/** What the agent knows when it puts something on the list. */
export interface ReminderDraft {
  /** The thing to be done, as a thing: "Send Fenwick the meter reading". */
  title: string;
  /** The one line the list row carries under the title. */
  blurb?: string;
  /** "Why I set this", one string per paragraph. */
  prose?: readonly string[];
  /** Defaults to `idle` — on the list, waiting, asking nothing of you. */
  state?: OpenReminderState;
  /** Null, or left out, is "Someday": on the list with no date on it. */
  dueAt?: Date | null;
  /** Whether the date is a day rather than a moment. */
  allDay?: boolean;
  /** Who wanted it. Defaults to the agent; `user` records one you asked for. */
  setBy?: Author;
  /** When it was set, if that is not now — one drawn from a run that finished
   *  an hour ago was set then. */
  setAt?: Date;
  origin?: ReminderOrigin;
  /** The pairs under "This reminder" that count something no column holds:
   *  "Two invoices", "£84". The derived ones are not writable — see metaFor. */
  meta?: readonly MetaPair[];
}

/**
 * Anything a draft holds about the reminder itself can be sharpened. Who set it
 * and where it came from cannot: those are facts about how it got here, and a
 * reminder that changed its own provenance would be a reminder you could not
 * check. Every field is optional — one left out is left alone, one given
 * replaces what was there. Pass `null` for `dueAt` to take the date off, which
 * is what moves it to "Someday".
 */
export type ReminderRevision = Partial<Omit<ReminderDraft, "setAt" | "setBy" | "origin">>;

/** How a reminder ended. */
export interface ReminderClosing {
  /** Who closed it. Defaults to the agent, which is who is usually calling. */
  by?: Author;
  /** What happened, in one sentence: "Sent it with this morning's batch." */
  because?: string;
  /** When it actually closed, if that is not now. */
  at?: Date;
}

function require_(db: Db, id: string): Row {
  const [row] = db.select().from(s.reminders).where(eq(s.reminders.id, id)).limit(1).all();
  if (!row) throw new NoSuchReminderError(id);
  return row;
}


/** Whether it has already been closed, by either of the two words for it. */
function isClosed(row: Row): boolean {
  return row.state === "done" || row.state === "cancelled" || row.completedAt != null;
}

/** The word for how it closed, for the error message. */
function closedAs(row: Row): string {
  return row.state === "done" || row.state === "cancelled" ? row.state : "closed";
}

/* ── the writes ─────────────────────────────────────────────────────────── */

/**
 * Put something on the list. Answers with the id it minted.
 *
 * It lands `idle` unless the caller says otherwise: on the list, in whichever
 * bucket its date puts it, asking nothing of anybody. `attention` is the state
 * that says the reminder wants you rather than merely existing, and it is worth
 * the caller having to choose it.
 */
export function createReminder(db: Db, draft: ReminderDraft, now: Date = new Date()): string {
  const title = draft.title.trim();
  if (!title) throw new Error("A reminder needs a title: it is the thing to be done");

  const setAt = draft.setAt ?? now;
  const blurb = draft.blurb?.trim() || undefined;
  const prose = (draft.prose ?? []).map((p) => p.trim()).filter(Boolean);
  const originId = draft.origin?.id?.trim() || null;

  return db.transaction((t) => {
    // Checked rather than left to the foreign key, so a bad origin reads as a
    // sentence about what went wrong instead of a constraint name.
    if (originId) {
      const [source] = t.select({ id: s.entities.id }).from(s.entities).where(eq(s.entities.id, originId)).limit(1).all();
      if (!source) throw new Error(`Nothing with id ${originId} to have come from: an origin points at what was read`);
    }

    const id = ulid(setAt.getTime());
    t.insert(s.entities).values({ id, kind: "reminder", createdAt: setAt, updatedAt: now }).run();
    t.insert(s.reminders)
      .values({
        id,
        title,
        state: draft.state ?? "idle",
        dueAt: draft.dueAt ?? null,
        allDay: draft.allDay ?? false,
        setBy: draft.setBy ?? "agent",
        setAt,
        originKind: draft.origin?.kind ?? "manual",
        originId,
        originLabel: draft.origin?.label?.trim() || null,
      })
      .run();

    writeProse(t, id, { blurb, prose }, setAt);
    writeMeta(t, id, draft.meta);
    return id;
  });
}

/**
 * Sharpen one that is still open.
 *
 * Only while it is open. Once it is closed, what it said is part of the record
 * of what was done about it, and rewriting it afterwards would leave the trail
 * describing a different reminder.
 *
 * Fields left out are left alone; a field given replaces what was there. The
 * account and the pairs are lists, so each is replaced wholesale rather than
 * merged — there is no sensible way to patch the third paragraph of an
 * explanation in place.
 */
export function reviseReminder(db: Db, id: string, patch: ReminderRevision, now: Date = new Date()): void {
  const row = require_(db, id);
  if (isClosed(row)) throw new ReminderSettledError(id, closedAs(row), "revise");

  const title = patch.title?.trim();
  if (patch.title != null && !title) throw new Error("A reminder needs a title");

  db.transaction((t) => {
    const set: Partial<typeof s.reminders.$inferInsert> = {};
    if (title) set.title = title;
    if (patch.state) set.state = patch.state;
    if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;
    if (patch.allDay !== undefined) set.allDay = patch.allDay;
    if (Object.keys(set).length > 0) {
      t.update(s.reminders).set(set).where(eq(s.reminders.id, id)).run();
    }

    const blurb = patch.blurb?.trim();
    const prose = patch.prose?.map((p) => p.trim()).filter(Boolean);
    if (blurb !== undefined || prose !== undefined) {
      writeProse(t, id, { blurb, prose }, now, { only: true });
    }
    if (patch.meta !== undefined) writeMeta(t, id, patch.meta);
    touch(t, id, now);
  });
}

/**
 * It was done.
 *
 * The reminder moves to "Closed" and draws the done mark. Any question hanging
 * off it is resolved rather than dismissed: something got done, so the thing it
 * was waiting on has an answer.
 */
export function completeReminder(
  db: Db,
  id: string,
  closing: ReminderClosing = {},
  now: Date = new Date(),
): void {
  const row = require_(db, id);
  if (isClosed(row)) throw new ReminderSettledError(id, closedAs(row), "complete");
  db.transaction((t) => close(t, row, "done", closing, now));
}

/**
 * It will not be done.
 *
 * Closed without being finished, which is a different fact from completed and
 * is why it is a different call. It draws the quiet mark rather than the failed
 * one — something called off is not something that went wrong — and the reason
 * is required, because a reminder that disappears without one is
 * indistinguishable from one that was forgotten.
 *
 * The question hanging off it, if there is one, is dismissed rather than
 * resolved: nobody answered it.
 */
export function dismissReminder(
  db: Db,
  id: string,
  because: string,
  now: Date = new Date(),
): void {
  if (!because.trim()) throw new Error("Say why it is being called off: a reminder that vanishes reads as one you lost");
  const row = require_(db, id);
  if (isClosed(row)) throw new ReminderSettledError(id, closedAs(row), "dismiss");
  db.transaction((t) => close(t, row, "cancelled", { because }, now));
}

/**
 * The shared tail of the two ways to close one.
 *
 * `completedAt` is set for both, because it is what the surface reads "Closed"
 * off: a cancelled reminder with a null date would keep drawing a "Due" pair
 * for a date nobody is going to act on.
 */
function close(
  t: Tx,
  row: Row,
  state: "done" | "cancelled",
  closing: ReminderClosing,
  now: Date,
): void {
  const by = closing.by ?? "agent";
  const at = closing.at ?? now;
  const because = closing.because?.trim() || undefined;

  t.update(s.reminders)
    .set({ state, completedAt: at, completedBy: by, completedReason: because ?? null })
    .where(eq(s.reminders.id, row.id))
    .run();

  if (row.decisionId) {
    // The buttons are left as they are. Nobody pressed one — the reminder was
    // settled out here in the world — so recording a chosen action would be
    // inventing which word was said.
    t.update(s.decisions)
      .set({
        state: state === "done" ? "resolved" : "dismissed",
        resolvedAt: at,
        resolvedBy: by,
      })
      .where(eq(s.decisions.id, row.decisionId))
      .run();
  }

  // `completedReason` holds the sentence but nothing draws it; the trail under
  // "What I've done about it" is where it is actually read. Hence both, and
  // hence nothing at all when there is no sentence to write — a fabricated
  // "Done." would be the agent putting words in the trail it never said.
  if (because) {
    t.insert(s.subjectEvents)
      .values({
        id: ulid(at.getTime()),
        subjectId: row.id,
        at,
        actor: by,
        eventKind: state === "done" ? "completed" : "cancelled",
        text: because,
      })
      .run();
  }
  touch(t, row.id, now);
}

/* ── the pieces each write shares ───────────────────────────────────────── */


/**
 * The one line and the account.
 *
 * Each slot is rewritten whole. `only` says the caller is patching, so a slot
 * it did not mention keeps what it had; without it every slot is written, which
 * is what a fresh reminder wants.
 */
function writeProse(
  t: Tx,
  id: string,
  text: { blurb?: string; prose?: readonly string[] },
  now: Date,
  opts: { only?: boolean } = {},
): void {
  writeSlots(t, id, { blurb: text.blurb, account: text.prose }, now, opts);
}

/**
 * The written pairs under "This reminder".
 *
 * Only the ones counting something the database has no rows for. Who set it,
 * when it is due, what it came from and what it blocks are all read off columns
 * and edges at query time, so a pair labelled "Due" would draw twice and the
 * second copy would be the one that goes stale.
 *
 * Replaced wholesale, and the delete runs even for an empty list: the unique
 * index is on (subject, group, ordinal), so leaving old rows behind would make
 * the next write collide rather than overwrite.
 */
function writeMeta(t: Tx, id: string, pairs: readonly MetaPair[] | undefined): void {
  if (pairs === undefined) return;
  writeAttributePairs(t, id, "meta", pairs);
}
