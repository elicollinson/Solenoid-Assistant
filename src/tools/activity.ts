// The activity feed, read.
//
// What an activity item IS, and why this group has no write tools, are in
// `purpose` and `guidance` at the foot of this file rather than up here: that
// prose is worth more to the model than to us, the briefing is the only place
// the model ever reads it, and a second copy in a comment would be a second
// copy to drift.
//
// The short of it, for whoever is reading the source: an activity item is
// DERIVED. Every row the seed writes names a workflow and one run of that
// workflow, and refuses to be written when the run is missing. The narration on
// the row is authored — the title, the badge, the account, the tool summary —
// but what it is narration OF happened somewhere else, and the thing that did
// the work is what owes the feed its entry. So there is no `activity_post`
// here: a tool that minted a feed row would be minting a record of an event
// that did not happen, in front of a person who reads that feed to find out
// what was done in their name.
//
// There is one write, and it is the other thing entirely. Annotating an entry
// appends a note to the trail under it — a remark about an event that already
// happened, rather than a claim that one did. See ../db/mutations/activity.ts
// for why that line is the whole distinction.
//
// A factory rather than module-level singletons, for the same reason
// ./recommendations.ts is one: the database handle is bound at construction.
// Nothing the model says can redirect these at another database.
//
// What this group deliberately cannot do:
//
//   * post, edit or delete a feed entry, or rewrite the account under one. See
//     above, and `guidance`. Notes are appended and never edited away.
//   * mark an item read, or dismiss it. Those two columns are the reader's own
//     gestures on their own feed; an agent dismissing an entry would be hiding
//     its own record from the person the record is for.
//   * filter by screen. There is no screen on an activity item — see the last
//     paragraph of `guidance`.
import { and, asc, desc, eq, gte, isNull, lte, type SQL } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "../core/tools";
import { defineToolGroup, type FieldDoc, type ToolGroup } from "../core/toolGroups";
import type { Db } from "../db";
import * as s from "../db/schema";
import { annotateActivityItem } from "../db/mutations/activity";
import { describeTable } from "../db/schemaDoc";
import { narrativeBySubject, narrativeLines } from "../db/queries/_narrative";
import type { ToolGroupContext } from "./groups";
import { instant, iso, limit } from "./_shared";

/* ── small shared pieces ────────────────────────────────────────────────── */

const idSchema = z
  .string()
  .min(1)
  .describe("The feed entry's id, as returned by activity_list.");

/** The two progress columns as the one thing they are, or nothing. A step
 *  count with only half of it filled in is not a progress bar. */
function progressOf(item: { progressValue: number | null; progressTotal: number | null }) {
  return item.progressValue != null && item.progressTotal != null
    ? { value: item.progressValue, total: item.progressTotal }
    : null;
}


/** The buttons under one entry, in the order they are drawn. */
function buttonsFor(db: Db, subjectId: string) {
  return db
    .select()
    .from(s.actions)
    .where(eq(s.actions.subjectId, subjectId))
    .orderBy(asc(s.actions.ordinal))
    .all()
    .map((a) => ({
      id: a.id,
      label: a.label,
      stance: a.stance,
      effectKind: a.effectKind,
      effect: a.effect,
      destructive: a.destructive,
      enabled: a.enabled,
      invokedAt: iso(a.invokedAt),
      invokedBy: a.invokedBy,
      invokeState: a.invokeState,
    }));
}

/* ── the shape, as the agent is told it ─────────────────────────────────── */

const spine: FieldDoc[] = describeTable(s.activityItems, {
  id: "The entry's own id. It is an entity, so it can be cited and linked like anything else.",
  occurredAt:
    "When the thing happened — not when the entry was written. A running entry is dated from when it started, which is why the surface says 'since 06:12' rather than a time in the future.",
  state:
    "The mark drawn beside it. 'attention' means it is stopped waiting on a person, 'running' that it is still going, 'idle' that it is worth saying and worth nothing more.",
  title: "The entry itself, in the agent's voice: 'Reply to the Ferris contract amendment'.",
  badge: "The small right-hand aside: 'running · step 6/11', 'needs you'. Often null.",
  prominence:
    "How loud the entry is. The phone draws at most two prominent entries and collapses the rest to a title and a time. An editorial call somebody made, not a rank you can recompute.",
  framed: "Desktop only: a tinted card rather than a bare row in the flow.",
  sourceId:
    "The thing this entry is an account OF. Usually the same run as `runId`; it is the general pointer, and the three below are the ones the surface joins on.",
  workflowId: "The workflow the entry is about, when there is one.",
  runId:
    "The single run this narrates. The run carries the trace, the log and the tool calls; the entry carries only the narration of them.",
  decisionId:
    "The open question this entry raises, when it raises one. This is what puts the entry's buttons in front of a person and counts it as something waiting on them.",
  toolSummary:
    "What was called, phrased rather than counted: '4 tool calls · gmail.draft, memory.read ×2, calendar.check'. Derivable from the run's steps, but the ×2 collapse is a writing decision.",
  progressValue: "Steps done, for a running entry. Meaningless without `progressTotal`.",
  progressTotal: "Steps expected. Both columns or neither.",
  readAt: "When the person read it. Null means they have not.",
  dismissedAt:
    "When the person cleared it from the feed. A dismissed entry is hidden from Home and from the rail's count, and left out of activity_list unless you ask for it. The row is kept: dismissing is not deleting.",
});

const accountShape: FieldDoc[] = describeTable(s.narratives, {
  id: null,
  subjectId: null,
  slot: "For a feed entry this is always 'account' — the paragraph under the title saying what was done and what was left undone.",
  surface:
    "'any' for almost everything. The phone and the desktop keep separate copy where the design writes it twice.",
  ordinal: "Paragraph order. The account is the one slot that regularly runs past one.",
  text: "The prose itself, exactly as it was written.",
  authoredBy: "Who wrote it. Almost always the agent.",
  model: null,
  generatedAt: "When it was written, which is not necessarily when the entry occurred.",
});

const buttonShape: FieldDoc[] = describeTable(s.actions, {
  id: null,
  subjectId: null,
  decisionId:
    "The question this button settles. A button without one is a plain affordance — 'Open workflow', 'Trace'.",
  ordinal: "Left to right, as drawn.",
  label:
    "The agent's own words, carrying the specific thing being agreed to: 'Send it', 'Not this one'. Never 'Submit' or 'OK'.",
  stance: "How it is drawn. 'affirm' is the one that goes ahead; 'bare' is the way out.",
  effectKind:
    "What pressing it does. Its arguments ride alongside as `effect` — { tool, args } for a tool_call, { view, id, tab } for a navigate — and activity_read hands those over with the button.",
  effect:
    "The arguments the press carries, shaped by `effectKind`: { tool, args } for a tool_call, " +
    "{ view, id, tab } for a navigate. Empty when the label is the whole of it.",
  enabled: null,
  destructive: "Pressing it cannot be taken back.",
  requiresConfirmation: null,
  idempotencyKey: null,
  authoredBy: null,
  createdAt: null,
  invokedAt: "When it was pressed. Null means the question is still open.",
  invokedBy: "Who pressed it.",
  invokeState: "How the press went.",
  invokeResult: null,
  invokeError: null,
});

const noteShape: FieldDoc[] = describeTable(s.subjectEvents, {
  id: null,
  subjectId: null,
  at: "When the note was made, which is what puts it after the entry rather than in it.",
  actor: "Who made it. A note you add is yours, and says so.",
  eventKind: "'note' for anything you add here. Other kinds are written by the things that do the work.",
  text: "The note itself.",
  data: null,
  runId: "The run it came out of, when it came out of one.",
});

/* ── the group ──────────────────────────────────────────────────────────── */

/** The trail under an entry, oldest first — the order it was written in. */
function notesFor(db: Db, subjectId: string) {
  return db
    .select()
    .from(s.subjectEvents)
    .where(eq(s.subjectEvents.subjectId, subjectId))
    .orderBy(asc(s.subjectEvents.at))
    .all()
    .map((note) => ({
      at: iso(note.at),
      actor: note.actor,
      kind: note.eventKind,
      text: note.text,
      runId: note.runId,
    }));
}

export function activityGroup(context: ToolGroupContext): ToolGroup {
  const { db } = context;

  const list = defineTool({
    name: "activity_list",
    kind: "read",
    description:
      "Read the feed of what has been done, newest first: one entry per thing that happened, each with the " +
      "account written under it at the time. Use it to answer 'what have you been doing', to find the entry " +
      "behind a run before you say anything about that run, and to check whether something has already been " +
      "reported — the feed is the record a person actually reads, so a thing said twice on it reads as two " +
      "separate events. Filter by `state` for what is stopped waiting on them, or by `since`/`until` for a " +
      "window. Do NOT reach for this as a log or a trace: it carries the narration of a run, not its steps, " +
      "and a question about what a run actually did is a question for the workflow tools. Dismissed entries " +
      "are left out unless you ask for them.",
    schema: z.object({
      state: z
        .enum(s.STATE)
        .optional()
        .describe(
          "Only entries carrying this mark. 'attention' is the one worth asking for on its own — it is what " +
            "is stopped waiting on a person. Omit for every state.",
        ),
      prominence: z
        .enum(s.PROMINENCE)
        .optional()
        .describe("Only the loud entries, or only the quiet ones. Rarely what you want; omit for both."),
      workflowId: z
        .string()
        .optional()
        .describe("Only entries about this workflow. The whole feed is small, so filter by time first."),
      since: instant
        .optional()
        .describe("ISO 8601. Only entries that occurred at or after this moment — 'what has happened today'."),
      until: instant
        .optional()
        .describe("ISO 8601. Only entries that occurred at or before this moment."),
      unreadOnly: z
        .boolean()
        .default(false)
        .describe("Only entries the person has not read yet. This tells you what they have seen, not what is undone."),
      includeDismissed: z
        .boolean()
        .default(false)
        .describe(
          "Include entries the person cleared from their feed. They cleared them on purpose, so leave this " +
            "false unless you are specifically looking back over what was cleared.",
        ),
      limit: limit({ keeps: "the newest" }),
    }),
    execute: ({ state, prominence, workflowId, since, until, unreadOnly, includeDismissed, limit }) => {
      const where: SQL[] = [];
      if (!includeDismissed) where.push(isNull(s.activityItems.dismissedAt));
      if (unreadOnly) where.push(isNull(s.activityItems.readAt));
      if (state) where.push(eq(s.activityItems.state, state));
      if (prominence) where.push(eq(s.activityItems.prominence, prominence));
      if (workflowId) where.push(eq(s.activityItems.workflowId, workflowId));
      if (since) where.push(gte(s.activityItems.occurredAt, new Date(since)));
      if (until) where.push(lte(s.activityItems.occurredAt, new Date(until)));

      const items = db
        .select()
        .from(s.activityItems)
        .where(and(...where))
        .orderBy(desc(s.activityItems.occurredAt))
        .limit(limit)
        .all();

      // One read for the whole page rather than one per row, the same bargain
      // ../db/queries/home.ts strikes. The list carries the first paragraph;
      // activity_read carries the rest.
      const accounts = narrativeBySubject(db, "account", "desktop", items.map((item) => item.id));

      return {
        count: items.length,
        rows: items.map((item) => ({
          id: item.id,
          occurredAt: iso(item.occurredAt),
          state: item.state,
          title: item.title,
          badge: item.badge,
          account: accounts.get(item.id) ?? null,
          prominence: item.prominence,
          framed: item.framed,
          toolSummary: item.toolSummary,
          progress: progressOf(item),
          workflowId: item.workflowId,
          runId: item.runId,
          decisionId: item.decisionId,
          read: item.readAt != null,
          dismissed: item.dismissedAt != null,
        })),
      };
    },
  });

  const read = defineTool({
    name: "activity_read",
    kind: "read",
    description:
      "Read one feed entry in full, together with what it points at: the whole account rather than its first " +
      "paragraph, the workflow and the run it narrates, the tool calls that run made, the question it raised " +
      "and the buttons offered against that question. Use it when the one-line entry from activity_list is " +
      "not enough to answer with — before telling somebody what was done in their name, and before saying " +
      "anything about whether a question on the feed has been settled, since the buttons carry who pressed " +
      "what and when. Do NOT call it on every row of a list: it reads five tables, and the list already " +
      "carries what a summary needs.",
    schema: z.object({ id: idSchema }),
    execute: ({ id }) => {
      const [item] = db.select().from(s.activityItems).where(eq(s.activityItems.id, id)).limit(1).all();
      if (!item) return { error: `No activity item with id ${id}` };

      const [workflow] = item.workflowId
        ? db
            .select({
              id: s.workflows.id,
              slug: s.workflows.slug,
              name: s.workflows.name,
              triggerKind: s.workflows.triggerKind,
              enabled: s.workflows.enabled,
            })
            .from(s.workflows)
            .where(eq(s.workflows.id, item.workflowId))
            .limit(1)
            .all()
        : [];

      const [run] = item.runId
        ? db.select().from(s.workflowRuns).where(eq(s.workflowRuns.id, item.runId)).limit(1).all()
        : [];

      // The entry's `toolSummary` is the agent's phrasing of exactly this list,
      // so both are handed over: one is what was said, the other is what happened.
      const toolCalls = item.runId
        ? db
            .select()
            .from(s.runSteps)
            .where(and(eq(s.runSteps.runId, item.runId), eq(s.runSteps.isTool, true)))
            .orderBy(asc(s.runSteps.ordinal))
            .all()
            .map((step) => ({
              name: step.toolName ?? step.name,
              detail: step.detail,
              note: step.note,
              state: step.state,
              durationMs: step.durationMs,
            }))
        : [];

      const [decision] = item.decisionId
        ? db.select().from(s.decisions).where(eq(s.decisions.id, item.decisionId)).limit(1).all()
        : [];

      return {
        id: item.id,
        occurredAt: iso(item.occurredAt),
        state: item.state,
        title: item.title,
        badge: item.badge,
        account: narrativeLines(db, item.id, "account"),
        prominence: item.prominence,
        framed: item.framed,
        toolSummary: item.toolSummary,
        progress: progressOf(item),
        read: item.readAt != null,
        readAt: iso(item.readAt),
        dismissed: item.dismissedAt != null,
        dismissedAt: iso(item.dismissedAt),
        sourceId: item.sourceId,
        workflow: workflow ?? null,
        run: run
          ? {
              id: run.id,
              ordinal: run.ordinal,
              state: run.state,
              trigger: run.trigger,
              triggeredBy: run.triggeredBy,
              startedAt: iso(run.startedAt),
              endedAt: iso(run.endedAt),
              durationMs: run.durationMs,
              stepIndex: run.stepIndex,
              stepTotal: run.stepTotal,
              error: run.error,
            }
          : null,
        toolCalls,
        decision: decision
          ? {
              id: decision.id,
              title: decision.title,
              body: decision.body,
              state: decision.state,
              blocking: decision.blocking,
              openedAt: iso(decision.openedAt),
              dueAt: iso(decision.dueAt),
              resolvedAt: iso(decision.resolvedAt),
              resolvedBy: decision.resolvedBy,
              chosenActionId: decision.chosenActionId,
            }
          : null,
        buttons: buttonsFor(db, item.id),
        notes: notesFor(db, item.id),
      };
    },
  });

  const annotate = defineTool({
    name: "activity_annotate",
    kind: "write",
    description:
      "Add a note to the trail under an entry that already exists — what you found out afterwards, why " +
      "something you reported turned out differently, a correction, a piece of context somebody reading " +
      "this later will need. This is the ONE thing you may write here, and it is not posting: the entry " +
      "and the event behind it stand as they are, and your note hangs under them with the time you made " +
      "it. Use it when what changed is your understanding rather than the world — when the world changed, " +
      "the record belongs where the work happened. " +
      "Notes are appended and can never be edited or removed, including by you, so write one you would be " +
      "content to have read back. Do not use it to restate the account, to talk to the person (nothing " +
      "here is a message), or to log routine progress: a trail of your own footsteps buries the one note " +
      "that mattered.",
    schema: z.object({
      id: z
        .string()
        .min(1)
        .describe("The entry's id, as returned by activity_list or activity_read. It must already exist."),
      note: z
        .string()
        .min(1)
        .describe(
          "The note itself, in your own voice and in one or two sentences: 'The vendor replied an hour " +
            "after this ran; the figure here is superseded by the one in the Thursday run.'",
        ),
      runId: z
        .string()
        .optional()
        .describe("The run this came out of, when it came out of one. Omit when it did not."),
    }),
    execute: ({ id, note, runId }) => ({
      id,
      noteId: annotateActivityItem(db, id, note, { by: "agent", ...(runId ? { runId } : {}) }),
    }),
  });

  return defineToolGroup({
    name: "activity",
    summary:
      "The feed of what has already been done — one written entry per thing that happened, with the account " +
      "of it that was put in front of the person at the time.",
    purpose:
      "An activity item is one line of the running account this product keeps of its own work: 'Reply to " +
      "the Ferris contract amendment', 'Q3 vendor reconciliation', with a paragraph underneath saying what " +
      "was done and, more usefully, what was left undone and why. It is what somebody sees when they open " +
      "Home, and it is the record they will hold you to.\n\n" +
      "It is not a task, not a reminder and not a log. A reminder is something still to do; a log is the " +
      "machine-side line-by-line, and lives on the run. A feed entry is the narration of something that " +
      "already happened, written for somebody who is not going to read the trace. Every entry points at " +
      "what it is about — a workflow, one run of that workflow, and often a question that is still open — " +
      "and it is those pointers, not the prose, that make it a record rather than a claim.",
    guidance:
      "You can add a note to an entry and you cannot make one, and the gap between those is the main thing " +
      "to understand here. An activity item " +
      "is derived: it exists because a run ran or a decision opened, and the thing that actually did the " +
      "work is what owes the feed its entry. The title and the account are authored prose, but what they " +
      "are prose ABOUT is a row in another table. A tool that let you post an entry directly would let you " +
      "write the record of an event that never happened, and because entries carry a decision and its " +
      "buttons, that record would arrive in front of a person with something to press. So if you have just " +
      "done something worth the feed, say it where the work happened — the entry follows from the run, not " +
      "from your account of it.\n\n" +
      "Annotating is the other thing, and it is allowed for the same reason posting is not. A note does " +
      "not assert that an event occurred; it hangs under an entry that already stands, carrying the time " +
      "you wrote it and your name. So it is right for what you learned afterwards — a figure superseded, a " +
      "reply that arrived late, a correction to something you reported — and wrong for anything the entry " +
      "itself should have said. Notes are appended and never edited or removed, by anybody including you: " +
      "a trail somebody can quietly revise is not a trail. Write few of them.\n\n" +
      "The same reasoning covers the two columns that look like yours to set. `readAt` and `dismissedAt` " +
      "are the reader's gestures on their own feed; an agent marking its own entry read, or clearing it " +
      "away, would be hiding its record from the person that record is for. Read them, and read what they " +
      "tell you — an unread entry is not the same as an unfinished one.\n\n" +
      "Entries are ordered by `occurredAt`, newest first, and a running entry is dated from when it started " +
      "rather than from when it will end. `prominence` and `framed` are editorial calls somebody made about " +
      "how loud an entry should be; they are not a rank you can recompute, so do not read a quiet entry as " +
      "an unimportant one.\n\n" +
      "There is no screen on an entry. The rail routes to nine screens and Activity is one of them, but the " +
      "feed itself is not divided per screen: the per-screen, per-day line the agent writes lives in " +
      "`surface_notes`, which is a different structure and not in this group. Filter by state and by time " +
      "window instead.",
    shape: {
      singular: "activity item",
      spine,
      related: [
        { label: "The account written under it", fields: accountShape },
        { label: "The buttons offered on it", fields: buttonShape },
        { label: "Notes added afterwards, oldest first", fields: noteShape },
      ],
    },
    tools: [list, read, annotate],
  });
}
