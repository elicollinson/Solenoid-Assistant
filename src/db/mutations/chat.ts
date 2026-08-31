// Writing down a conversation with the agent.
//
// There is no chat table and there is not going to be one. A chat is a
// `conversations` row with `channel = 'agent_chat'` and its turns are
// `messages`, because the design draws a text from Fenwick Heating and a turn
// from the agent with the same stamp, the same body and the same order — see
// ../schema/conversations.ts, which argues it at length.
//
// What is here that a text message has no counterpart for is the approval. When
// the agent is about to write something it stops and puts it to you, and that
// pause has to survive a page reload, appear in Activity beside everything else
// waiting, and still read correctly in the transcript a month later. So it is a
// real `decisions` row with real `actions`, not a promise held in memory — the
// promise in ../../chat/session.ts is only how THIS process notices the answer.
//
// There are many of them. The design draws a conversation LIST on both frames —
// the desktop's aside, the phone's own screen — each row a title, a line and a
// status mark, newest first. So a chat is started rather than opened, and it
// names itself from the first thing you say to it, because a conversation you
// have to name before you can have it is a form.
//
// The write order below is the one ../schema/entities.ts requires and cannot be
// rearranged for readability: foreign keys are not deferrable in SQLite, so the
// `entities` row exists before the row that reuses its id, and the decision
// exists before the actions that name it.
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { ApprovalOutcome } from "../../shared/chat";
import { ulid, type Db } from "../index";
import * as s from "../schema";
import { clearSlot, narrate, touch, writePairs, type Pair, type Tx } from "./_shared";
import { yoursOnly } from "../queries/chat";

/** Thrown when an id names no open decision — HTTP 404 or 409. */
export class NoSuchDecisionError extends Error {
  constructor(id: string) {
    super(`No open decision with id ${id}`);
    this.name = "NoSuchDecisionError";
  }
}

/** Thrown when an id names no chat — HTTP 404. */
export class NoSuchConversationError extends Error {
  constructor(id: string) {
    super(`No conversation with id ${id}`);
    this.name = "NoSuchConversationError";
  }
}

/**
 * A conversation's name, taken from the first thing said in it.
 *
 * Six words, which is the design's own rule and is longer than it sounds: "Can
 * the Latham review move to Monday?" becomes "Can the Latham review move to…",
 * and that is enough to find it again in a list a fortnight later.
 *
 * Named from your words rather than summarised by the model on purpose. A title
 * that took a round trip would arrive after the row was already on screen, and
 * a list that renames itself under you is worse than one that quotes you.
 */
export function nameFrom(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 6).join(" ") + (words.length > 6 ? "…" : "");
}

/**
 * Start one, and answer with its id.
 *
 * Untitled until something is said in it — `appendUserMessage` names it. An
 * empty conversation is a real row rather than a pending intention because the
 * design has a screen for exactly that: "New conversation", sitting at the top
 * of the list with "Nothing said yet" under it.
 */
export function startConversation(db: Db, now = new Date()): string {
  return db.transaction((tx) => {
    const id = ulid();
    tx.insert(s.entities).values({ id, kind: "conversation", createdAt: now, updatedAt: now }).run();
    tx.insert(s.conversations)
      .values({
        id,
        channel: "agent_chat",
        counterpartyLabel: "Solenoid",
        startedAt: now,
        lastMessageAt: now,
        // Nothing else in the product is trusted at this level, and nothing
        // else should be: this is the only conversation whose other half is us.
        trustState: "trusted",
        safetyState: "clean",
      })
      .run();
    return id;
  });
}

/**
 * The most recent chat, started if there is none.
 *
 * What a client that has not said which one it wants gets. Not a singleton —
 * `startConversation` is always free to make another, and the list is what the
 * screens actually navigate.
 */
export function latestConversation(db: Db, now = new Date()): string {
  const existing = db
    .select({ id: s.conversations.id })
    .from(s.conversations)
    // The same predicate the list uses, and it has to be: a run transcript is
    // also an agent_chat row, so "the most recent one" would otherwise hand you
    // a workflow's record to type into.
    .where(yoursOnly(db))
    .orderBy(desc(s.conversations.lastMessageAt))
    .limit(1)
    .get();
  return existing?.id ?? startConversation(db, now);
}

/** The next position in a conversation. */
function nextSeq(tx: Tx, conversationId: string): number {
  const last = tx
    .select({ seq: s.messages.seq })
    .from(s.messages)
    .where(eq(s.messages.conversationId, conversationId))
    .orderBy(desc(s.messages.seq))
    .limit(1)
    .get();
  return (last?.seq ?? 0) + 1;
}

/** One message row, plus the counters on the conversation that describe it. */
function append(
  tx: Tx,
  conversationId: string,
  values: { direction: "inbound" | "outbound"; body: string; sentBy: "user" | "agent" },
  now: Date,
): string {
  const id = ulid();
  tx.insert(s.entities).values({ id, kind: "message", createdAt: now, updatedAt: now }).run();
  tx.insert(s.messages)
    .values({
      id,
      conversationId,
      seq: nextSeq(tx, conversationId),
      direction: values.direction,
      sentAt: now,
      body: values.body,
      sentBy: values.sentBy,
      // Both halves of this conversation are screened, and neither is screened
      // here: what you type goes through ../../core/rawAgent.ts as `operator`
      // and what the agent says went through it as model output. Recording
      // "clean" would be claiming a result this function never saw.
      safetyState: "unscreened",
    })
    .run();
  tx.update(s.conversations)
    .set({ lastMessageAt: now, messageCount: sql`${s.conversations.messageCount} + 1` })
    .where(eq(s.conversations.id, conversationId))
    .run();
  touch(tx, conversationId, now);
  return id;
}

/**
 * What you said — and, if it is the first thing, what this conversation is now
 * called.
 *
 * Named here rather than at `startConversation` because that is the only moment
 * the name can be honest: an untitled row is a conversation nobody has had yet,
 * and the design draws it as exactly that.
 */
export function appendUserMessage(db: Db, conversationId: string, body: string, now = new Date()): string {
  const text = body.trim();
  if (!text) throw new Error("A chat message needs something in it");
  return db.transaction((tx) => {
    const existing = tx
      .select({ title: s.conversations.title })
      .from(s.conversations)
      .where(eq(s.conversations.id, conversationId))
      .get();
    if (!existing) throw new NoSuchConversationError(conversationId);
    if (!existing.title) {
      tx.update(s.conversations)
        .set({ title: nameFrom(text) })
        .where(eq(s.conversations.id, conversationId))
        .run();
    }
    return append(tx, conversationId, { direction: "inbound", body: text, sentBy: "user" }, now);
  });
}

/** The sparse half of an agent turn — see ../schema/chat.ts. */
export interface AgentTurn {
  /** "written to okf:policy/ferris-hold · rev 1". The mono line under the prose. */
  note?: string | null;
  /** "4 tool calls · docs.read, web.form_walk, calendar.check". */
  toolSummary?: string | null;
  decisionId?: string | null;
  runId?: string | null;
}

/**
 * What the agent said.
 *
 * The `agent_turns` row is written only when there is something to put in it,
 * which is what makes it a sparse extension rather than four nullable columns
 * on `messages`: most turns are prose and nothing else.
 */
export function appendAgentMessage(
  db: Db,
  conversationId: string,
  body: string,
  turn: AgentTurn = {},
  now = new Date(),
): string {
  return db.transaction((tx) => {
    const id = append(tx, conversationId, { direction: "outbound", body, sentBy: "agent" }, now);
    const sparse = turn.note || turn.toolSummary || turn.decisionId || turn.runId;
    if (sparse) {
      tx.insert(s.agentTurns)
        .values({
          messageId: id,
          ...(turn.decisionId ? { decisionId: turn.decisionId } : {}),
          ...(turn.runId ? { runId: turn.runId } : {}),
          ...(turn.toolSummary ? { toolSummary: turn.toolSummary } : {}),
          ...(turn.note ? { note: turn.note } : {}),
        })
        .run();
    }
    return id;
  });
}

export interface ApprovalDraft {
  conversationId: string;
  /** The sentence the buttons answer. */
  title: string;
  /** Why this is being asked at all, in the agent's words. `decisions.body`. */
  why?: string | null;
  /**
   * What it has NOT done while it waits: "Filled and unsent. Nothing is
   * committed."
   *
   * A `restraint` narrative, which is the slot the whole product uses for this
   * — see ../schema/spine.ts. It matters more here than anywhere: the person is
   * being asked to allow something, and the useful half of that question is
   * what is currently true if they say nothing.
   */
  hold?: string | null;
  /** The machine facts under the ask: the tool, and what it was called with. */
  facts: readonly Pair[];
  /** The two buttons, in the order they are drawn. */
  choices: ReadonlyArray<{ label: string; stance: (typeof s.ACTION_STANCE)[number]; approves: boolean }>;
}

export interface OpenedApproval {
  decisionId: string;
  /** The short human reference the bubble prints: `ap/0824-2`. */
  ref: string;
  messageId: string;
  actions: ReadonlyArray<{ id: string; label: string; stance: (typeof s.ACTION_STANCE)[number] }>;
}

/**
 * Stop, and write down that you were asked.
 *
 * `blocking` is true because it is: a run is sitting on this one, which is what
 * separates it from a suggestion waiting in the feed, and what the "needs you"
 * count on every screen is indexed for.
 *
 * The actions hang off the DECISION rather than off the conversation. They have
 * to: `actions` is unique on (subject, ordinal), so a second approval in the
 * same chat would collide on ordinal 0 with the first one's affirm button.
 */
/**
 * `ap/0824-2` — the short reference the bubble prints in its top-right corner.
 *
 * A ULID is the id and is unanswerable out loud. This is the one you can read
 * back to somebody, and it is dated so that two of them from different weeks
 * never collide in conversation. Counted within the day rather than globally,
 * which is what makes the second half a small number instead of a serial.
 */
function nextRef(tx: Tx, now: Date): string {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: s.APP_TZ,
    month: "2-digit",
    day: "2-digit",
  }).format(now).replace("-", "");
  const since = new Date(now.getTime() - 36 * 3600_000);
  const today = tx
    .select({ openedAt: s.decisions.openedAt })
    .from(s.decisions)
    .where(gte(s.decisions.openedAt, since))
    .all();
  const sameDay = today.filter((row) => day ===
    new Intl.DateTimeFormat("en-CA", { timeZone: s.APP_TZ, month: "2-digit", day: "2-digit" })
      .format(row.openedAt).replace("-", "")).length;
  return `ap/${day}-${sameDay + 1}`;
}

export function openApproval(db: Db, draft: ApprovalDraft, now = new Date()): OpenedApproval {
  return db.transaction((tx) => {
    const decisionId = ulid();
    tx.insert(s.entities).values({ id: decisionId, kind: "decision", createdAt: now, updatedAt: now }).run();
    tx.insert(s.decisions)
      .values({
        id: decisionId,
        subjectId: draft.conversationId,
        title: draft.title,
        ...(draft.why ? { body: draft.why } : {}),
        state: "open",
        blocking: true,
        openedAt: now,
      })
      .run();

    writePairs(tx, decisionId, "effect", draft.facts);
    if (draft.hold?.trim()) narrate(tx, decisionId, "restraint", draft.hold.trim(), now);

    // Stored rather than re-derived: the count it is taken from moves every
    // time another decision opens, so a ref computed at read time would change
    // under a bubble that had already printed it.
    const ref = nextRef(tx, now);
    tx.insert(s.attributes)
      .values({ id: ulid(), subjectId: decisionId, groupSlot: "meta", ordinal: 0, label: "ref", value: ref })
      .run();

    const actions = draft.choices.map((choice, ordinal) => {
      const id = ulid();
      tx.insert(s.actions)
        .values({
          id,
          subjectId: decisionId,
          decisionId,
          ordinal,
          label: choice.label,
          stance: choice.stance,
          // "resolve" rather than "tool_call". The effect a tool_call action
          // describes is one the CLIENT fires; this one is already loaded in a
          // suspended agent loop, and the button's whole job is to let it go.
          // Writing it as tool_call would invite a second, unheld call.
          effectKind: "resolve",
          effect: { approves: choice.approves },
          destructive: choice.stance === "danger",
          createdAt: now,
        })
        .run();
      return { id, label: choice.label, stance: choice.stance };
    });

    const messageId = append(
      tx,
      draft.conversationId,
      { direction: "outbound", body: draft.title, sentBy: "agent" },
      now,
    );
    tx.insert(s.agentTurns).values({ messageId, decisionId }).run();

    return { decisionId, ref, messageId, actions };
  });
}

export type { ApprovalOutcome } from "../../shared/chat";

/**
 * Close an approval, and say who closed it.
 *
 * Answers with the outcome so the caller has one source of truth for it. Two
 * tabs answering the same bubble is ordinary, not exceptional: the second one
 * finds the decision already out of `open` and gets NoSuchDecisionError, which
 * the route turns into a 409 and the screen turns into a re-read.
 */
export function settleApproval(
  db: Db,
  decisionId: string,
  settlement: { actionId?: string; outcome: ApprovalOutcome; said?: string },
  now = new Date(),
): ApprovalOutcome {
  return db.transaction((tx) => {
    const open = tx
      .select({ id: s.decisions.id })
      .from(s.decisions)
      .where(and(eq(s.decisions.id, decisionId), eq(s.decisions.state, "open")))
      .get();
    if (!open) throw new NoSuchDecisionError(decisionId);

    tx.update(s.decisions)
      .set({
        // A decline is an answer, not an absence: it resolves. Only the clock
        // running out leaves it unanswered.
        state: settlement.outcome === "expired" ? "expired" : "resolved",
        resolvedAt: now,
        resolvedBy: settlement.outcome === "expired" ? "timeout" : "user",
        ...(settlement.actionId ? { chosenActionId: settlement.actionId } : {}),
      })
      .where(eq(s.decisions.id, decisionId))
      .run();

    if (settlement.actionId) {
      tx.update(s.actions)
        .set({ invokedAt: now, invokedBy: "user", invokeState: "ok" })
        .where(eq(s.actions.id, settlement.actionId))
        .run();
    }
    // The bubble's closing line, in the `outcome` slot the whole product uses
    // for "what followed once a decision was settled". Written now with what is
    // certainly true — who chose what, and when — and appended to by
    // `noteApprovalOutcome` once the call it released has actually run.
    if (settlement.said) {
      clearSlot(tx, decisionId, "outcome");
      narrate(tx, decisionId, "outcome", settlement.said, now);
    }
    touch(tx, decisionId, now);
    return settlement.outcome;
  });
}

/**
 * Whether a button approves, and which decision it belongs to.
 *
 * The client sends the action id it drew, never a boolean — a screen that could
 * post `{approved: true}` for a button labelled "Not this one" is a screen that
 * can write the wrong answer into a record of what you chose.
 */
export function readChoice(
  db: Db,
  actionId: string,
): { decisionId: string; approves: boolean; label: string } | undefined {
  const row = db
    .select({ decisionId: s.actions.decisionId, effect: s.actions.effect, label: s.actions.label })
    .from(s.actions)
    .where(eq(s.actions.id, actionId))
    .get();
  if (!row?.decisionId) return undefined;
  const effect = row.effect as { approves?: unknown };
  return { decisionId: row.decisionId, approves: effect.approves === true, label: row.label };
}

/**
 * Finish the outcome line, once the thing you allowed has actually happened.
 *
 * Two sentences in the design and two writes here, deliberately: "You said
 * renew it, 11:23." is true the instant you press the button, and "Paid £84 and
 * filed the confirmation." is not true until the call returns. Writing both at
 * settle time would have the transcript claim an outcome it was still waiting
 * on — which is the exact failure the approval exists to prevent.
 */
export function noteApprovalOutcome(db: Db, decisionId: string, followed: string, now = new Date()): void {
  const said = followed.trim();
  if (!said) return;
  db.transaction((tx) => {
    const existing = tx
      .select({ text: s.narratives.text, ordinal: s.narratives.ordinal })
      .from(s.narratives)
      .where(and(eq(s.narratives.subjectId, decisionId), eq(s.narratives.slot, "outcome")))
      .orderBy(desc(s.narratives.ordinal))
      .limit(1)
      .get();
    narrate(tx, decisionId, "outcome", said, now, (existing?.ordinal ?? -1) + 1);
    touch(tx, decisionId, now);
  });
}
