// Agent-facing tools for the Calendar surface, and the group that hands them
// over.
//
// What a calendar item IS, and the list of what these tools deliberately cannot
// do, are in `purpose` and `guidance` at the foot of this file rather than up
// here. That prose is worth more to the model than to us, and the briefing is
// the only place the model ever reads it; a second copy in a comment would be a
// second copy to drift.
//
// A factory rather than module-level singletons, for the same reason
// ./recommendations.ts is one: the database handle is bound at construction, so
// nothing the model says can redirect these at another database.
//
// The read tools are safe to hand to any agent. The write tools should NOT sit
// in the same loop as untrusted input — an agent reading a stranger's email
// while holding `calendar_create` is a path for that stranger to put an
// appointment in somebody's week. That filtering does not happen here: the
// group returns EVERY tool, and `readOnly` in ../core/toolGroups.ts drops the
// writes once, for every group, so no group can get its own filter wrong.
//
// One shape, four tables. An item's own columns are the spine; how often it
// repeats, who is coming and the offer behind a held slot are rows elsewhere
// that belong to it, and the briefing says so under names an agent would use.
import { and, asc, eq, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { defineTool, type AgentTool } from "../core/tools";
import { defineToolGroup, type ToolGroup } from "../core/toolGroups";
import type { Db } from "../db";
import * as s from "../db/schema";
import { describeTable } from "../db/schemaDoc";
import { clock, dayLabel } from "../db/queries/_format";
import {
  cancelCalendarItem,
  createCalendarItem,
  offerCalendarHolds,
  rescheduleCalendarItem,
  setCalendarAttendees,
} from "../db/mutations/calendar";
import type { ToolGroupContext } from "./groups";
import { instant } from "./_shared";
import { narrativeLines } from "../db/queries/_narrative";

/** A week, which is what the Calendar screen draws and what `calendar_list`
 *  answers with when it is asked for no window in particular. */
const WEEK_MS = 7 * 86_400_000;

const idSchema = z
  .string()
  .min(1)
  .describe(
    "The item's id, as returned by calendar_list, calendar_create or calendar_hold. Ids of runs and " +
      "reminders drawn on the same screen are not accepted here — they are not rows in this table.",
  );

const attendeeSchema = z.object({
  participantId: z
    .string()
    .min(1)
    .describe(
      "The id of the participants row for whoever is coming. An id, never a name — two people called " +
        "Marta are two rows, and this tool will not guess which one you mean. Read the ids off " +
        "calendar_read for an item they are already on, or off the people records.",
    ),
  response: z
    .enum(s.ATTENDEE_RESPONSE)
    .default("none")
    .describe(
      "What they have actually said: 'accepted', 'declined', 'tentative', or 'none' when they have not " +
        "answered yet. This is the record of their answer, not your expectation of it — do not write " +
        "'accepted' because the meeting is obviously happening.",
    ),
  optional: z
    .boolean()
    .default(false)
    .describe("True when they are welcome but the thing happens without them."),
  isExternal: z
    .boolean()
    .default(false)
    .describe(
      "True for somebody outside the household or the org. Kept because it is what lets the surface say " +
        "'no external invites changed' after a move.",
    ),
});

type Row = typeof s.calendarItems.$inferSelect;

/** Both readings of the same span: the instants, and what a clock in the app's
 *  timezone shows for them. The agent reasons in one and speaks in the other. */
function when(row: Row): Record<string, unknown> {
  const local = row.endsAt
    ? `${dayLabel(row.startsAt)} ${clock(row.startsAt)} – ${clock(row.endsAt)}`
    : `${dayLabel(row.startsAt)} ${clock(row.startsAt)}`;
  return {
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    local,
    allDay: row.allDay,
  };
}

/** A row as a list entry: enough to decide whether to open it. */
function brief(row: Row): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    ...when(row),
    location: row.location,
    meta: row.metaLabel,
    setBy: row.setBy,
    ...(row.holdGroupId ? { holdGroupId: row.holdGroupId } : {}),
  };
}

export function calendarGroup(context: ToolGroupContext): ToolGroup {
  const db: Db = context.db;

  const attendeesOf = (id: string) =>
    db
      .select({
        participantId: s.calendarAttendees.participantId,
        name: s.participants.displayName,
        response: s.calendarAttendees.response,
        optional: s.calendarAttendees.optional,
        isExternal: s.calendarAttendees.isExternal,
      })
      .from(s.calendarAttendees)
      .innerJoin(s.participants, eq(s.participants.id, s.calendarAttendees.participantId))
      .where(eq(s.calendarAttendees.calendarItemId, id))
      .all();

  const list = defineTool({
    name: "calendar_list",
    kind: "read",
    description:
      "Everything on the grid between two instants, earliest first — the cheap first step before putting " +
      "anything anywhere near somebody's week. Defaults to the next seven days. " +
      "It answers with commitments and held slots only. The workflow runs and reminders drawn on the same " +
      "screen are not rows here: they are read from the workflow and reminder records, so a window that " +
      "looks empty here is not proof the time is free. " +
      "An item that started before the window and is still running inside it is included; cancelled ones " +
      "are left out unless you ask for them.",
    schema: z.object({
      from: instant.optional().describe("Start of the window. Defaults to now."),
      to: instant.optional().describe("End of the window, exclusive. Defaults to seven days after `from`."),
      kind: z
        .enum(["event", "hold"])
        .optional()
        .describe(
          "'event' for things that are happening, 'hold' for time only being offered. Omit for both, " +
            "which is usually what you want: a held slot is exactly what makes a window not free.",
        ),
      includeCancelled: z
        .boolean()
        .default(false)
        .describe(
          "Include items that were cancelled. They stay on file — use this when somebody is asking what " +
            "happened to something they expected to find.",
        ),
      limit: z.number().int().positive().max(200).default(50),
    }),
    execute: ({ from, to, kind, includeCancelled, limit }) => {
      const start = from ? new Date(from) : new Date();
      const end = to ? new Date(to) : new Date(start.getTime() + WEEK_MS);
      const rows = db
        .select()
        .from(s.calendarItems)
        .where(
          and(
            lt(s.calendarItems.startsAt, end),
            // Overlap, not containment: a meeting that began before the window
            // and has not finished is on the grid the window draws. An item
            // with no end is a point, so it stands for its own end.
            sql`coalesce(${s.calendarItems.endsAt}, ${s.calendarItems.startsAt}) >= ${start.getTime()}`,
            ...(kind ? [eq(s.calendarItems.kind, kind)] : []),
            ...(includeCancelled ? [] : [ne(s.calendarItems.status, "cancelled")]),
          ),
        )
        .orderBy(asc(s.calendarItems.startsAt))
        .limit(limit)
        .all();
      return {
        from: start.toISOString(),
        to: end.toISOString(),
        count: rows.length,
        items: rows.map(brief),
      };
    },
  });

  const read = defineTool({
    name: "calendar_read",
    kind: "read",
    description:
      "One item in full: its span, where it is, who is coming and what each of them has said, how often it " +
      "repeats, what it was moved off, and the offer behind it when it is a held slot. " +
      "Read it before changing anything — attendees are replaced wholesale rather than added to, so " +
      "the list you send has to start from the list that is there.",
    schema: z.object({ id: idSchema }),
    execute: ({ id }) => {
      const [row] = db.select().from(s.calendarItems).where(eq(s.calendarItems.id, id)).limit(1).all();
      if (!row) {
        return {
          error:
            `No calendar item with id ${id}. Workflow runs and reminders appear on the Calendar screen ` +
            "but are not rows in this table; read those with their own tools.",
        };
      }

      const [repeat] = db
        .select()
        .from(s.calendarRecurrences)
        .where(eq(s.calendarRecurrences.itemId, id))
        .limit(1)
        .all();
      const [hold] = db.select().from(s.calendarHolds).where(eq(s.calendarHolds.id, id)).limit(1).all();
      const [organizer] = row.organizerId
        ? db
            .select({ id: s.participants.id, name: s.participants.displayName })
            .from(s.participants)
            .where(eq(s.participants.id, row.organizerId))
            .limit(1)
            .all()
        : [];
      const account = narrativeLines(db, id, "account");

      return {
        ...brief(row),
        tz: row.tz,
        organizer: organizer ?? null,
        seriesId: row.seriesId,
        movedFrom: row.movedFromAt
          ? { at: row.movedFromAt.toISOString(), local: dayLabel(row.movedFromAt), by: row.movedBy, because: row.movedReason }
          : null,
        account,
        repeats: repeat
          ? {
              rrule: repeat.rrule,
              untilAt: repeat.untilAt?.toISOString() ?? null,
              exdates: repeat.exdates.map((ms) => new Date(ms).toISOString()),
            }
          : null,
        attendees: attendeesOf(id),
        hold: hold
          ? {
              holdGroupId: hold.holdGroupId,
              offeredById: hold.offeredById,
              offeredAt: hold.offeredAt.toISOString(),
              expiresAt: hold.expiresAt?.toISOString() ?? null,
              acceptedAt: hold.acceptedAt?.toISOString() ?? null,
              releasedAt: hold.releasedAt?.toISOString() ?? null,
              clashNote: hold.clashNote,
            }
          : null,
      };
    },
  });

  const create = defineTool({
    name: "calendar_create",
    kind: "write",
    description:
      "Put a commitment on the grid, confirmed. Answers with the id it minted. " +
      "This is a claim on somebody's time, so call calendar_list for the window first: a second copy of a " +
      "meeting that is already there is worse than none. " +
      "Use it for things that are actually happening. Time you are only offering goes through calendar_hold, " +
      "and a thing you have to do rather than be at is a reminder, not an entry here. Do not create an item " +
      "for a workflow run — the Calendar screen draws those from the runs themselves, and a row written " +
      "here would be a second copy that disagrees with the first by lunchtime.",
    schema: z.object({
      title: z
        .string()
        .min(1)
        .describe(
          "What it is, the way somebody would say it out loud: 'Latham review', 'Boiler service'. Not a " +
            "sentence, and not the time — the time is the span.",
        ),
      startsAt: instant,
      endsAt: instant
        .optional()
        .describe(
          "When it finishes. Leave it out only when you genuinely do not know: the grid then draws an " +
            "hour, which is its guess and not a fact about the thing.",
        ),
      allDay: z
        .boolean()
        .default(false)
        .describe("True for something that occupies the day rather than a span of it."),
      location: z.string().optional().describe("Where it is, as somebody would need it: 'Room 2', 'Their office'."),
      metaLabel: z
        .string()
        .optional()
        .describe(
          "The one line under the title on the grid: 'Room 2 · four people'. Do not restate the time, and " +
            "do not count the attendees here — a count written into this line will not move when the " +
            "attendee list does.",
        ),
      setBy: z
        .enum(s.AUTHOR)
        .default("agent")
        .describe(
          "'agent' — you put it there, which is the usual case for a tool call. 'user' — they arranged it " +
            "and you are writing it down. The detail pane says 'Set by me' or 'Set by you' off this.",
        ),
      organizerId: z
        .string()
        .optional()
        .describe("The participants id of whoever's meeting it is, when it is not simply theirs."),
      attendees: z
        .array(attendeeSchema)
        .optional()
        .describe("Everyone invited. Can be settled later with calendar_set_attendees instead."),
      repeats: z
        .object({
          rrule: z
            .string()
            .min(1)
            .describe(
              "An RRULE: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30'. Only FREQ, BYDAY, BYHOUR and " +
                "BYMINUTE are read, and only DAILY and WEEKLY are drawn.",
            ),
          untilAt: instant.optional().describe("When it stops repeating. Omit for a series with no end."),
        })
        .optional()
        .describe("How often it comes round. Omit for something that happens once."),
      account: z
        .array(z.string().min(1))
        .optional()
        .describe(
          "'Why it is here', one string per paragraph, in your own voice. Worth writing for anything you " +
            "put in their week without being asked: say what made you do it.",
        ),
    }),
    execute: ({ startsAt, endsAt, repeats, ...rest }) => {
      const id = createCalendarItem(db, {
        ...rest,
        startsAt: new Date(startsAt),
        ...(endsAt ? { endsAt: new Date(endsAt) } : {}),
        ...(repeats
          ? {
              recurrence: {
                rrule: repeats.rrule,
                ...(repeats.untilAt ? { untilAt: new Date(repeats.untilAt) } : {}),
              },
            }
          : {}),
      });
      return { id, kind: "event", status: "confirmed" };
    },
  });

  const reschedule = defineTool({
    name: "calendar_reschedule",
    kind: "write",
    description:
      "Move one in time. A different act from editing it — what it is has not changed, only when — and the " +
      "row keeps where it came from, so the surface can say 'moved from the 25th' rather than quietly " +
      "showing a different day than the one they wrote down. " +
      "Give `because` whenever you know it: a meeting that moved for a reason and a meeting that moved for " +
      "no stated reason read very differently to whoever finds it somewhere new. " +
      "It keeps the length it had unless you give a new `endsAt` — putting something an hour later is not " +
      "making it shorter. Check the new window with calendar_list first; nothing here refuses a clash.",
    schema: z.object({
      id: idSchema,
      startsAt: instant.describe("Where it moves to."),
      endsAt: instant.optional().describe("A new finish, when the length changes too. Omit to keep it."),
      movedBy: z
        .enum(s.AUTHOR)
        .default("agent")
        .describe("'agent' — you moved it. 'user' — they did, and you are writing it down."),
      because: z
        .string()
        .optional()
        .describe(
          "Why, in the mover's voice: 'Latham asked for the morning'. Shown next to where it moved from.",
        ),
    }),
    execute: ({ id, startsAt, endsAt, movedBy, because }) => {
      rescheduleCalendarItem(db, id, {
        startsAt: new Date(startsAt),
        ...(endsAt ? { endsAt: new Date(endsAt) } : {}),
        by: movedBy,
        ...(because ? { because } : {}),
      });
      return { id, startsAt, moved: true };
    },
  });

  const cancel = defineTool({
    name: "calendar_cancel",
    kind: "write",
    description:
      "Take it off the grid. The row stays, marked cancelled, because a meeting that was in the diary and " +
      "is not any more is a different thing from one that was never there — and it is what somebody looking " +
      "for it next week needs to find. Nothing here deletes anything. " +
      "Cancelling a held slot releases the offer as a consequence. If the thing is still happening and only " +
      "at another time, use calendar_reschedule: cancelling and recreating loses what it was moved off.",
    schema: z.object({
      id: idSchema,
      cancelledBy: z
        .enum(s.AUTHOR)
        .default("agent")
        .describe("'agent' — you called it off. 'user' — they did, and you are writing it down."),
      because: z.string().optional().describe("Why it is off, in your voice. Kept on its history."),
    }),
    execute: ({ id, cancelledBy, because }) => {
      cancelCalendarItem(db, id, { by: cancelledBy, ...(because ? { because } : {}) });
      return { id, status: "cancelled" };
    },
  });

  const setAttendees = defineTool({
    name: "calendar_set_attendees",
    kind: "write",
    description:
      "Settle who is coming, and what each of them has said. " +
      "This REPLACES the whole list: send everyone who is invited, not only the ones who changed, because " +
      "anybody left out is uninvited. Call calendar_read first and work from what is there. " +
      "Nothing here sends an invitation or tells anybody anything — it records who is coming, in this " +
      "database, and the people named do not find out from it.",
    schema: z.object({
      id: idSchema,
      attendees: z
        .array(attendeeSchema)
        .describe("The complete list. An empty array means nobody is coming, which is a real answer."),
    }),
    execute: ({ id, attendees }) => {
      setCalendarAttendees(db, id, attendees);
      return { id, attendees: attendees.length };
    },
  });

  const hold = defineTool({
    name: "calendar_hold",
    kind: "write",
    description:
      "Offer time rather than take it. Every window lands as a held slot marked tentative, and they share " +
      "one hold group — so two windows for the same boiler service are one question with two answers " +
      "rather than two bookings. Answers with the group and the ids it minted. " +
      "Use this whenever the time is not agreed: a slot somebody offered you, or two you are offering them. " +
      "It is the honest thing to draw while an answer is outstanding, and it keeps the window from being " +
      "given away twice. When one is taken, cancel the others — cancelling a held slot releases it — and " +
      "put the agreed one on the grid with calendar_create.",
    schema: z.object({
      title: z
        .string()
        .min(1)
        .describe("What the time would be for. Said once and used for every window in the offer."),
      windows: z
        .array(
          z.object({
            startsAt: instant,
            endsAt: instant.optional().describe("When the window closes, when you know it."),
            clashNote: z
              .string()
              .optional()
              .describe(
                "What is wrong with this one, if something is: 'runs into the standup'. Say it here rather " +
                  "than leaving them to notice.",
              ),
          }),
        )
        .min(1)
        .describe(
          "The alternatives, in the order you would put them. Offer them in one call: they are one " +
            "question, and taking one of them releases the others.",
        ),
      location: z.string().optional().describe("Where it would be."),
      metaLabel: z.string().optional().describe("The line under the title on the grid, as for calendar_create."),
      offeredById: z
        .string()
        .optional()
        .describe("The participants id of whoever offered them — the contractor, not you."),
      offeredAt: instant.optional().describe("When the offer was made, if that is not now."),
      expiresAt: instant
        .optional()
        .describe("When it lapses. Give it when you know it: an offer with no expiry is one nobody has to answer."),
      holdGroupId: z
        .string()
        .optional()
        .describe("An existing group, to add a window to an offer already made. Omit to start a new one."),
      setBy: z
        .enum(s.AUTHOR)
        .default("agent")
        .describe("'agent' — you are holding the time. 'user' — they are, and you are writing it down."),
    }),
    execute: ({ windows, offeredAt, expiresAt, ...rest }) =>
      offerCalendarHolds(db, {
        ...rest,
        windows: windows.map((w) => ({
          startsAt: new Date(w.startsAt),
          ...(w.endsAt ? { endsAt: new Date(w.endsAt) } : {}),
          ...(w.clashNote ? { clashNote: w.clashNote } : {}),
        })),
        ...(offeredAt ? { offeredAt: new Date(offeredAt) } : {}),
        ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
      }),
  });

  const tools: AgentTool[] = [list, read, create, reschedule, cancel, setAttendees, hold];

  return defineToolGroup({
    name: "calendar",
    summary:
      "The week: what somebody has committed to being at, and the time being offered but not yet agreed.",
    purpose:
      "A calendar item is a claim on somebody's time. Four kinds sit on the Calendar screen and only two of " +
      "them are rows in this table: an event, which is a commitment that is happening, and a hold, which is " +
      "time offered and not yet agreed. The other two — workflow runs and reminders — are drawn from the " +
      "run and reminder records at the moment the screen is read, so they are not here, cannot be written " +
      "here, and a calendar window that looks empty is not proof the time is free.\n\n" +
      "What an item IS spans four tables and one idea: the item's own columns, how often it comes round, " +
      "who is coming, and the offer behind it while it is only held. These tools read all four together and " +
      "write each of them through the act that means something — putting one in the diary, moving it, " +
      "calling it off, settling who is coming, offering time. There is no general update tool, because " +
      "'move the review to Thursday' and 'change what the review is' are not the same thing to anybody who " +
      "later asks what happened to their Tuesday.",
    guidance:
      "Times are instants. Everything is written and read in America/New_York, the one timezone this " +
      "product runs in; every tool takes an ISO 8601 instant with an offset or a Z, so there is nothing to " +
      "get wrong, and none of them will write a second zone.\n\n" +
      "Nothing here is a message. Creating an item, moving it or setting its attendees changes this " +
      "database and tells nobody: the people named do not find out, and no external calendar is touched. " +
      "Rows synced in from elsewhere carry a provider and an external id, and changing one of those here " +
      "changes only our copy.\n\n" +
      "One-way doors are few but real. Cancelling is not deleting and nothing here deletes: a cancelled " +
      "item stays on file and calendar_list will show it if asked. Moving one records where it came from, " +
      "so a move and a cancel-then-recreate leave a different trail — prefer the move. Attendees are " +
      "replaced wholesale rather than merged, so read before you write.\n\n" +
      "A hold is not an agreement. Holds offered together share a group and are one question with several " +
      "answers: when one is taken, cancel the others, which releases them, and create the agreed thing as " +
      "an event. A hold left standing quietly occupies a window somebody could otherwise be given.\n\n" +
      "Nothing here sets the mark drawn on the grid, or the shelf, the day column, the week's heading or " +
      "the counts under it. Every one of those is a reading of the clock against these rows, and a stored " +
      "one is wrong by morning.",
    shape: {
      singular: "calendar item",
      spine: describeTable(s.calendarItems, {
        id: "Its id. Every other tool here takes this.",
        kind: "Which of the four this is. Only 'event' and 'hold' are rows: 'run' and 'reminder' are drawn from elsewhere, and nothing here writes one.",
        state: "The mark drawn on it. Left unset on everything these tools write — a mark is a reading of a run's state, and a commitment of yours is not running.",
        title: "What it is, the way somebody would say it out loud.",
        metaLabel: "The one line under the title on the grid: 'Room 2 · four people'.",
        location: "Where it is.",
        startsAt: "When it starts, as an instant.",
        endsAt: "When it finishes. Absent means the grid draws an hour, which is its guess rather than a fact.",
        tz: "The zone it is read in. Always America/New_York today; the column is here so a second zone is a data change rather than a migration.",
        allDay: "It occupies the day rather than a span of it.",
        status: "'confirmed' for something happening, 'tentative' for a held slot, 'cancelled' for one taken off the grid. Cancelled rows stay.",
        sourceId: null,
        workflowId: null,
        provider: "Where the row came from. 'local' for anything these tools wrote; anything else came from a calendar we sync with, and changing it here changes only our copy.",
        externalId: null,
        externalCalendarId: null,
        etag: null,
        syncedAt: null,
        organizerId: "Whose meeting it is, as a participants row.",
        setBy: "Who put it there — 'agent' is you, 'user' is them. The column falls back to 'user', but anything these tools create is stamped 'agent' unless you say otherwise.",
        movedFromAt: "Where it was before the last move. Written when one is rescheduled, never directly.",
        movedBy: "Who moved it.",
        movedReason: "Why it moved, in the mover's voice.",
        holdGroupId: "The offer a held slot belongs to. Slots sharing one are alternatives to each other.",
        decisionId: "The question this slot is an answer to, when a reminder asked one. Nothing here writes it: a hold does not open a question of its own.",
        seriesId: "The item this one is an occurrence of.",
      }),
      related: [
        {
          label: "How often it comes round",
          fields: describeTable(s.calendarRecurrences, {
            itemId: null,
            rrule: "'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30'. Only FREQ, BYDAY, BYHOUR and BYMINUTE are read, and only DAILY and WEEKLY are drawn.",
            tz: "The zone the series repeats in. America/New_York, as everything else is.",
            untilAt: "When it stops repeating. Absent means it does not.",
            exdates: "The instants the series skips — the week the standup did not happen.",
          }),
        },
        {
          label: "Who is coming",
          fields: describeTable(s.calendarAttendees, {
            calendarItemId: null,
            participantId: "The person, as a participants row. There are no names here; an id names exactly one of them.",
            response: "What they have actually said. 'none' means they have not answered — do not read it as a yes.",
            optional: "They are welcome but the thing happens without them.",
            isExternal: "Outside the household or the org. This is what lets the surface say 'no external invites changed'.",
          }),
        },
        {
          label: "The offer behind a held slot",
          fields: describeTable(s.calendarHolds, {
            id: null,
            holdGroupId: "The offer this window belongs to. Windows sharing one are alternatives, and taking one releases the rest.",
            offeredById: "Who offered it — the contractor, not you.",
            offeredAt: "When the offer was made.",
            expiresAt: "When it lapses. Absent means nobody has to answer.",
            acceptedAt: "When it was taken up. Nothing in this group writes it; a slot that was agreed is created as an event.",
            releasedAt: "When it stopped being held. Written as a consequence of cancelling the slot.",
            clashNote: "What is wrong with this window: 'runs into the standup'.",
          }),
        },
      ],
      derived: [
        {
          name: "local",
          type: "string",
          note: "'Tue 25 Aug 10:00 – 11:30' — the stored instants read on a clock in America/New_York. Assembled on every read; nothing stores it.",
        },
        {
          name: "attendees[].name",
          type: "string",
          note: "The participant's display name, joined on read so you can see who you are looking at. You still write attendees by id.",
        },
      ],
    },
    tools,
  });
}
