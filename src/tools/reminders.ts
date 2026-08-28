// Agent-facing tools for the Reminders surface, and the group that hands them
// over.
//
// What a reminder IS, and how one moves, are in `purpose` and `guidance` at the
// foot of this file rather than up here. That prose is worth more to the model
// than to us, and the briefing is the only place the model ever reads it; a
// second copy in a comment would be a second copy to drift.
//
// A factory rather than module-level singletons, for the same reason ./okf.ts
// is one: the database handle is bound at construction. Nothing the model says
// can redirect these at another database.
//
// The read tools are safe to hand to any agent. The write tools should NOT sit
// in the same loop as untrusted input — an agent reading email while holding
// `reminders_create` is a path for a stranger to put a line on a list you
// trust. That filtering does not happen here: the factory returns EVERY tool,
// and `readOnly` in ../core/toolGroups.ts drops the writes once, for every
// group, so no group can get its own filter wrong.
//
// What these tools deliberately cannot do:
//
//   * set a bucket, a mark, a "when" or the header's count. All four are read
//     off `dueAt` and `state` against the clock — see the note at the top of
//     ../db/queries/reminders.ts. A stored "Today" is wrong by morning.
//   * re-open something closed. Completing and dismissing are one-way doors; a
//     thing that came back is a new reminder, not the old one undone.
//   * open a question with buttons on it. The gate on the detail pane belongs
//     to a decision somebody else opened; closing a reminder settles one, and
//     nothing here creates one. A reminder nags, it does not ask.
//   * cite evidence, or claim a standing rule. Both are drawn on the detail
//     pane and both are written elsewhere; these tools read them back.
import { z } from "zod";
import { defineTool, type AgentTool } from "../core/tools";
import { defineToolGroup, type DerivedField, type FieldDoc, type ToolGroup } from "../core/toolGroups";
import * as s from "../db/schema";
import { describeTable } from "../db/schemaDoc";
import { loadReminder, loadReminders } from "../db/queries/reminders";
import {
  completeReminder,
  createReminder,
  dismissReminder,
  reviseReminder,
  type MetaPair,
} from "../db/mutations/reminders";
import type { ToolGroupContext } from "./groups";
import { instant } from "./_shared";

const idSchema = z
  .string()
  .min(1)
  .describe("The reminder's id, as returned by reminders_list or reminders_create.");

/** The three states a reminder can be in while it is still yours to do. The
 *  other two are reached by closing it, and only by closing it. */
const openStateSchema = z
  .enum(["idle", "attention", "running"])
  .describe(
    "'idle' is the default and means it is on the list, waiting, asking nothing of you. 'attention' means it " +
      "wants you specifically — it draws the loud mark and should be reserved for the ones that genuinely do. " +
      "'running' means you are acting on it right now. 'done' and 'cancelled' are not settable here: they are " +
      "what reminders_complete and reminders_dismiss write, and writing one directly would leave no record of " +
      "which of the two happened.",
  );

const metaSchema = z
  .array(
    z.object({
      label: z.string().min(1).describe("The left column, e.g. 'Invoices'."),
      value: z.string().min(1).describe("The right column, e.g. 'two, £84 between them'."),
    }),
  )
  .describe(
    "The pairs under 'This reminder', in the order they should read. Only for things no column holds — a " +
      "count you made, an amount, a name. Do NOT write a 'Set by', 'Due', 'Closed', 'Source', 'Blocks' or " +
      "'About' pair: every one of those is already drawn from the row itself, and a written copy would " +
      "appear twice and go stale first. Giving this REPLACES the pairs that were there.",
  );

const proseSchema = z
  .array(z.string().min(1))
  .describe(
    "'Why I set this', one string per paragraph, in your own voice. Say why it is worth holding and what " +
      "you are waiting for; do not restate the title. Giving this REPLACES the paragraphs that were there.",
  );

const blurbSchema = z
  .string()
  .describe(
    "The one line under the title in the list. Say what this is actually about, in a sentence: 'Their terms " +
      "give you until the 30th, and the reading has to be theirs, not yours.' Not a restatement of the title.",
  );

/** An ISO 8601 instant, or "" to say there is no date at all — which is what
 *  "Someday" is. The empty string is the only thing this accepts that ./_shared
 *  `instant` does not, so it is written as that plus the one exception rather
 *  than as a looser check of its own. */
const clearableDueAt = z
  .union([instant, z.literal("")])
  .describe(
    "A new ISO 8601 due timestamp, or an empty string to take the date off entirely and move it to " +
      "'Someday'. Rescheduling is a real edit and belongs here; do not close one and make another to move it.",
  );

const pairs = (meta: { label: string; value: string }[]): MetaPair[] =>
  meta.map((pair) => [pair.label, pair.value] as const);

export function remindersGroup(context: ToolGroupContext): ToolGroup {
  const db = context.db;

  /** The stored state, which the list payload does not carry — it carries the
   *  mark, and the mark folds `cancelled` into `idle` because something you
   *  called off is quiet rather than failed. */
  const states = (): Map<string, string> =>
    new Map(
      db
        .select({ id: s.reminders.id, state: s.reminders.state })
        .from(s.reminders)
        .all()
        .map((r) => [r.id, r.state]),
    );

  const list = defineTool({
    name: "reminders_list",
    kind: "read",
    description:
      "List what is being held, in the order the surface draws it: overdue first, then today, then the rest " +
      "of the week, then the undated, then what is closed. This is the cheap first step before setting " +
      "anything — a reminder you already set should be revised rather than set again, and one you already " +
      "closed should not quietly come back. " +
      "Each row carries its id, title, the one line under it, the stored state, the bucket it falls in, when " +
      "it is due in words, where it came from, and whether a question is genuinely open on it. The bucket " +
      "and the words are computed from the due date against the clock, so they are answers about right now " +
      "rather than anything stored.",
    schema: z.object({
      group: z
        .enum(["Overdue", "Today", "This week", "Later", "Someday", "Closed"])
        .optional()
        .describe(
          "Return only the reminders in this bucket. 'Someday' is the ones with no date at all; 'Closed' is " +
            "everything completed or called off. Omit for all of them.",
        ),
      state: z
        .enum(s.REMINDER_STATE)
        .optional()
        .describe(
          "Return only reminders in this exact stored state. Narrower than `group` and cuts across it: use " +
            "'attention' to find the ones asking for you, or 'cancelled' to tell what was called off from " +
            "what was finished, which the bucket alone cannot.",
        ),
      limit: z.number().int().positive().max(200).default(50),
    }),
    execute: ({ group, state, limit }) => {
      const stored = states();
      const payload = loadReminders(db);
      const rows = payload.rows
        .filter((r) => (group ? r.group === group : true))
        .filter((r) => (state ? stored.get(r.id) === state : true))
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          title: r.title,
          note: r.note,
          state: stored.get(r.id) ?? "idle",
          group: r.group,
          when: r.when,
          source: r.source,
          gated: r.gated,
        }));
      return { lede: payload.lede, count: rows.length, rows };
    },
  });

  const read = defineTool({
    name: "reminders_read",
    kind: "read",
    description:
      "Read one reminder in full: why it was set, the pairs under it, everything that has been done about it " +
      "so far, the standing rule it is an instance of, the question open on it if there is one, and the " +
      "messages, captures and pages it was formed from, each with the sentence saying why that one was kept. " +
      "Use it before revising one, so you are sharpening what is there rather than overwriting it with a " +
      "fresh draft, and before closing one, so what you write about how it ended follows from what it said.",
    schema: z.object({ id: idSchema }),
    execute: ({ id }) => loadReminder(db, id) ?? { error: `No reminder with id ${id}` },
  });

  const create = defineTool({
    name: "reminders_create",
    kind: "write",
    description:
      "Put something on the list and answer with the id it minted. This is for a thing that has to happen and " +
      "is not happening now — a date somebody else set, a promise made in a thread, a window that closes. " +
      "It is a real interruption: it is counted, it draws a bucket off its date, and somebody will read it " +
      "back. Check reminders_list first; the same reminder set twice is worse than not set. " +
      "Leave `dueAt` off only when there genuinely is no date, which puts it on 'Someday' — a guessed date is " +
      "worse than none, because the list will then be wrong about what is overdue. Say in `blurb` what this " +
      "is about and in `prose` why you are holding it rather than acting on it.",
    schema: z.object({
      title: z
        .string()
        .min(1)
        .describe(
          "The thing to be done, phrased as a thing to do: 'Send Fenwick the meter reading', 'Renew the " +
            "resident permit'. Not a topic, not a question, and not a sentence about how you feel about it.",
        ),
      blurb: blurbSchema.optional(),
      prose: proseSchema.optional(),
      dueAt: instant
        .optional()
        .describe(
          "ISO 8601 timestamp for when you want to hear about it. Omit entirely when there is no date — that " +
            "is 'Someday', and it is an honest answer. Everything the list says about lateness is read off " +
            "this one field.",
        ),
      allDay: z
        .boolean()
        .default(false)
        .describe("True when the date is a day rather than a moment — a deadline, not an appointment."),
      state: openStateSchema.default("idle"),
      setBy: z
        .enum(s.AUTHOR)
        .default("agent")
        .describe(
          "Who wanted it. 'agent' is you noticing something and holding it. 'user' is only for one they " +
            "actually asked for — the pane says 'set by you', and that has to be true.",
        ),
      setAt: instant
        .optional()
        .describe("ISO 8601 timestamp, when this comes from something that happened earlier. Defaults to now."),
      originKind: z
        .enum(s.REMINDER_ORIGIN)
        .default("manual")
        .describe("What kind of thing it came out of. 'manual' means nothing in particular did."),
      originId: z
        .string()
        .optional()
        .describe(
          "The id of the conversation, message, run or capture it came out of. It must already exist in this " +
            "database — an origin pointing at nothing is worse than no origin at all.",
        ),
      originLabel: z
        .string()
        .optional()
        .describe(
          "What the row says under the title: 'from thread/9a44', 'from okf:vendor/ferris-terms'. Leave it " +
            "off and the row reads 'set by me', which is right when nothing in particular prompted it.",
        ),
      meta: metaSchema.optional(),
    }),
    execute: (args) => {
      const { dueAt, setAt, originKind, originId, originLabel, meta, ...rest } = args;
      const id = createReminder(db, {
        ...rest,
        ...(dueAt ? { dueAt: new Date(dueAt) } : {}),
        ...(setAt ? { setAt: new Date(setAt) } : {}),
        origin: { kind: originKind, ...(originId ? { id: originId } : {}), ...(originLabel ? { label: originLabel } : {}) },
        ...(meta ? { meta: pairs(meta) } : {}),
      });
      return { id, state: args.state };
    },
  });

  const revise = defineTool({
    name: "reminders_revise",
    kind: "write",
    description:
      "Change the wording or the date of one that is still open — the deadline moved, the one line was doing " +
      "nobody any favours, it turned out to be about something narrower. This is also how a reminder is " +
      "rescheduled or snoozed: give a new `dueAt`. " +
      "Only works while it is open. Once it is closed, what it said is part of the record of what was done " +
      "about it, and rewriting it would leave the trail describing a different reminder. " +
      "Fields you omit are left alone. `prose` and `meta` are lists, so each one you give REPLACES what was " +
      "there rather than adding to it — read it first with reminders_read.",
    schema: z.object({
      id: idSchema,
      title: z.string().min(1).optional().describe("A better phrasing of the same thing to be done."),
      blurb: blurbSchema.optional(),
      prose: proseSchema.optional(),
      dueAt: clearableDueAt.optional(),
      allDay: z.boolean().optional().describe("Whether the date is a day rather than a moment."),
      state: openStateSchema.optional(),
      meta: metaSchema.optional(),
    }),
    execute: ({ id, dueAt, meta, ...patch }) => {
      reviseReminder(db, id, {
        ...patch,
        // "" is the only way to say "no date", and it means Someday.
        ...(dueAt === undefined ? {} : { dueAt: dueAt === "" ? null : new Date(dueAt) }),
        ...(meta ? { meta: pairs(meta) } : {}),
      });
      return { id, revised: true };
    },
  });

  const complete = defineTool({
    name: "reminders_complete",
    kind: "write",
    description:
      "Record that the thing was done. It moves to 'Closed', stops counting against you, and answers any " +
      "question that was open on it. " +
      "Only for something that actually happened — either you did it, or they told you they did. If it is " +
      "simply not going to happen, that is reminders_dismiss, and the two are kept apart because 'I sent it' " +
      "and 'we decided not to' are not the same sentence to read back six weeks later. " +
      "Say what happened in `because`: the trail under 'What I've done about it' is where anybody checking " +
      "you will look, and closing one in silence leaves nothing there. There is no undoing this.",
    schema: z.object({
      id: idSchema,
      because: z
        .string()
        .optional()
        .describe(
          "What happened, in one sentence: 'Sent it with this morning's batch; they confirmed at 11:04.' Say " +
            "what was done, not that it is done.",
        ),
      by: z
        .enum(s.AUTHOR)
        .default("agent")
        .describe(
          "Who did it. 'agent' is you. 'user' is only for something they did or told you they did — never " +
            "assume it on their behalf because the date passed.",
        ),
      at: instant
        .optional()
        .describe("ISO 8601 timestamp for when it was actually done, if that was not now."),
    }),
    execute: ({ id, because, by, at }) => {
      completeReminder(db, id, {
        by,
        ...(because ? { because } : {}),
        ...(at ? { at: new Date(at) } : {}),
      });
      return { id, state: "done" };
    },
  });

  const dismiss = defineTool({
    name: "reminders_dismiss",
    kind: "write",
    description:
      "Close one that will not be done. It moves to 'Closed' and goes quiet — something called off is not " +
      "something that failed — and any question open on it is dismissed rather than answered, because nobody " +
      "answered it. " +
      "This is the honest close for a reminder whose reason went away: the invoice was already paid, the " +
      "window shut, they said not to bother. Do NOT use it to tidy the list of things still outstanding, and " +
      "do not use it for something that was actually done — that is reminders_complete. " +
      "The reason is required. A reminder that disappears without one is indistinguishable from one you lost.",
    schema: z.object({
      id: idSchema,
      because: z
        .string()
        .min(1)
        .describe(
          "Why it is being called off, in one sentence: 'They paid it on the 12th, so there is nothing left " +
            "to chase.' This is the whole record of why the list got shorter.",
        ),
    }),
    execute: ({ id, because }) => {
      dismissReminder(db, id, because);
      return { id, state: "cancelled" };
    },
  });

  return defineToolGroup({
    name: "reminders",
    title: "Reminders",
    summary:
      "Things being held for you rather than acted on — a date somebody else set, a promise made in a " +
      "thread, a window that closes — each with what it is waiting for and what has been done about it.",
    purpose:
      "A reminder is something the agent is holding for you rather than acting on. It is not a task queue " +
      "and not a note to self: every row here is a thing that has to happen, that is not happening now, and " +
      "that somebody will be late for if nobody says anything. Most of them come out of something the agent " +
      "read — a thread, a set of terms, a capture — and the row keeps the line back to it.\n\n" +
      "The list is one screen and it is read against the clock: overdue first, then today, then the rest of " +
      "the week, then the ones with no date, then what is closed. That ordering, the words under 'when', the " +
      "mark on each row and the count in the header are all computed from the due date and the state at the " +
      "moment somebody looks. None of them is stored and none of them can be written, which is what makes " +
      "the list true at four in the afternoon as well as at nine in the morning.",
    guidance:
      "A reminder is open in one of three states — idle, waiting on the list; attention, asking for you; " +
      "running, being worked on — and closed in one of two: completed, or dismissed. Closing is a one-way " +
      "door. There is no re-opening write, because a thing that came back is a new reminder rather than the " +
      "old one undone.\n\n" +
      "Completing and dismissing are separate calls because they are separate facts. Both land it in " +
      "'Closed'; one says the thing was done and the other says it will not be, and six weeks later that is " +
      "the whole difference between a list you can trust and a list that was tidied.\n\n" +
      "While it is open it can be revised freely: the wording, the date, the pairs. Once it is closed it " +
      "cannot, because what it said is part of the record of what was done about it. Rescheduling is a " +
      "revision, not a close and a re-create — a new row would lose the trail and the evidence.\n\n" +
      "A reminder with no date is not a lesser reminder. It sits on 'Someday' and stays there until a date " +
      "arrives. Guessing one to get it into 'This week' makes the list wrong about what is overdue, which is " +
      "the only thing the list is really for.",
    shape: {
      singular: "reminder",
      spine: describeTable(s.reminders, {
        id: "The reminder's own id, and its id in the entity supertype it shares with everything citable.",
        title: "The thing to be done, phrased as a thing to do.",
        state:
          "Where it stands. 'idle', 'attention' and 'running' are the open ones; 'done' and 'cancelled' are " +
          "what closing it writes, and are not settable directly.",
        dueAt: "When you want to hear about it. Null is 'Someday' — on the list, with no date, deliberately.",
        // One timezone for the whole product (APP_TZ), nothing lets it vary,
        // and every timestamp crossing these tools is an ISO instant anyway.
        dueTz: null,
        allDay: "Whether the date is a day rather than a moment — a deadline, not an appointment.",
        setBy: "Who wanted it: the agent noticing something, or you asking for it.",
        setAt: "When it was set. Half of the 'Set by' pair, and the tie-break for the undated ones.",
        originKind: "What kind of thing it came out of. 'manual' means nothing in particular did.",
        originId: "The conversation, message, run or capture it came out of, when it came out of one.",
        originLabel:
          "What the row says it came from: 'from thread/9a44'. Absent reads as 'set by me'.",
        completedAt: "When it closed, either way. Its presence is what puts it in the 'Closed' bucket.",
        completedBy: "Who closed it.",
        completedReason:
          "The sentence about how it ended. Also written to the trail, which is where the detail pane " +
          "actually draws it.",
        // Nothing reads this and nothing here writes it: a documented column
        // the agent cannot use is an invitation to ask for a tool that does
        // not exist. Rescheduling is what a snooze is, and revise does that.
        snoozedUntil: null,
        decisionId:
          "The question open on it, when something has actually asked you one. Closing the reminder settles " +
          "it; nothing here opens one.",
        instructionId:
          "The standing rule this is an instance of — 'anything that commits money waits for me'. Shown on " +
          "the detail pane; written elsewhere.",
        // No recurrence anywhere in the product yet: no query reads it and no
        // write sets it. Describing it would promise a repeat that never comes.
        recurrenceRrule: null,
      }),
      related: [
        {
          label: "Why I set this, in your own words",
          fields: [
            { name: "blurb", type: "text", required: false, note: "The one line under the title in the list." },
            {
              name: "prose",
              type: "text, one entry per paragraph",
              required: false,
              note: "The account on the detail pane. Set through create and revise, replaced whole.",
            },
          ] satisfies FieldDoc[],
        },
        {
          label: "The pairs under 'This reminder'",
          fields: [
            { name: "label", type: "text", required: true, note: "'Invoices', 'Amount'." },
            { name: "value", type: "text", required: true, note: "'two', '£84 between them'." },
          ] satisfies FieldDoc[],
        },
        {
          label: "What I've done about it — the trail, oldest first",
          fields: [
            { name: "at", type: "timestamp", required: true },
            {
              name: "text",
              type: "text",
              required: true,
              note: "One line per thing done. Closing the reminder with a reason adds the last of them.",
            },
          ] satisfies FieldDoc[],
        },
        {
          label: "What it was formed from — read-only here",
          fields: [
            { name: "title", type: "text", required: false, note: "What the citation calls the source." },
            { name: "why", type: "text", required: false, note: "Why that one was kept, in one sentence." },
            { name: "quote", type: "text", required: false, note: "The clause that mattered, quoted exactly." },
          ] satisfies FieldDoc[],
        },
      ],
      derived: [
        {
          name: "group",
          type: "one of: Overdue | Today | This week | Later | Someday | Closed",
          note: "The bucket, read off dueAt against the clock. Closed wins over everything: something you finished is not overdue, however long ago it was due.",
        },
        {
          name: "when",
          type: "string",
          note: "'Yesterday 17:00', 'Today 16:30', 'Thu 09:00', 'No date'. The due date said in words, relative to now.",
        },
        {
          name: "mark",
          type: "one of: attention | running | done | idle",
          note: "The status mark, read off state. There are five states and four marks: something you called off shows as quiet, not as failed.",
        },
        {
          name: "source",
          type: "string",
          note: "The origin label, or 'set by me' when there is none.",
        },
        {
          name: "gated",
          type: "boolean",
          note: "Whether a decision is genuinely open on it, as opposed to the agent merely waiting. A gate has buttons; a nag has affordances.",
        },
      ] satisfies DerivedField[],
    },
    tools: [list, read, create, revise, complete, dismiss] as AgentTool[],
  });
}
