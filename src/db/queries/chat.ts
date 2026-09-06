// The Chat surface: the transcript, and what is still waiting in it.
//
// Four tables and no domain of its own — a chat is a `conversations` row, its
// turns are `messages`, the sparse half of an agent turn is `agent_turns`, and
// an approval is a `decisions` row with its `actions` and its `attributes`.
// ../mutations/chat.ts argues why at the top; this is the reading side of the
// same claim, and its shape is the evidence: nothing below special-cases a chat
// against a text thread except the two joins a text thread has no rows for.
//
// The stamp is derived, like every other stamp in this directory. A stored
// "09:39" is right until midnight and then reads as this morning.
import { and, asc, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import type { Db } from "../index";
import * as s from "../schema";
import type { Surface } from "../../shared/surface";
import type {
  ChatApproval,
  ChatChoice,
  ChatConversationRow,
  ChatListPayload,
  ChatPayload,
  ChatTurnRow,
} from "../../shared/chat";
import { clock, dayKey, dayName, stampLong } from "./_format";
import { surfaceNote } from "./_surface";

export type * from "../../shared/chat";

/**
 * A conversation with YOU, as opposed to a workflow run's transcript.
 *
 * Both are `channel = 'agent_chat'` — see ../schema/conversations.ts, which
 * argues that a run's transcript is a conversation like any other and should
 * not get a stack of its own. That is right, and it means "every agent_chat
 * row" is the wrong list for this screen: the seeded database has five of them
 * and three are run transcripts, so the Chat list opened onto "contract-review
 * · run 3" and offered to continue it.
 *
 * What separates them is `workflow_runs.transcript_conversation_id`. A
 * conversation some run names is that run's record; everything else is you
 * talking to the agent.
 *
 * Exported because ../mutations/chat.ts needs exactly the same predicate to
 * answer "the latest one", and two spellings of this would disagree the first
 * time a run finished.
 */
export function yoursOnly(db: Db) {
  return and(
    eq(s.conversations.channel, "agent_chat"),
    notInArray(
      s.conversations.id,
      db
        .select({ id: s.workflowRuns.transcriptConversationId })
        .from(s.workflowRuns)
        .where(isNotNull(s.workflowRuns.transcriptConversationId)),
    ),
  );
}

/**
 * How an answered approval reads afterwards.
 *
 * The buttons are gone by then, and a bubble that just showed a greyed-out pair
 * would leave you working out which one you pressed. This is the transcript
 * saying it back — and it says it in the second person because the whole page
 * is the agent talking to you.
 */
function settledLine(
  state: ChatApproval["state"],
  written: readonly string[],
  chosen: { label: string; approves: boolean } | undefined,
): string | null {
  if (state === "open") return null;
  // What the agent actually wrote at the time, in one or two sentences — see
  // `noteApprovalOutcome` in ../mutations/chat.ts on why there can be two.
  if (written.length) return written.join(" ");
  // Nothing was written down, which happens for a decision settled from
  // somewhere other than a chat turn. Say what can still be known rather than
  // inventing an account of what followed.
  if (state === "expired") return "No answer — nothing was written.";
  if (!chosen) return "Settled elsewhere.";
  return chosen.approves ? `You said "${chosen.label}".` : `You said "${chosen.label}" — nothing was written.`;
}

/**
 * The conversation list — the desktop's aside, the phone's own screen.
 *
 * Three of the four columns are derived and none of them could be stored. The
 * stamp is a reading of the clock; the state is "is anything in it waiting on
 * you"; and the lede is the last thing the agent said in it, first sentence
 * only, because a list row is one line and the turn it comes from is four.
 */
export function loadConversations(
  db: Db,
  now = new Date(),
  surface: Surface = "desktop",
): ChatListPayload {
  const rows = db
    .select({
      id: s.conversations.id,
      title: s.conversations.title,
      lastMessageAt: s.conversations.lastMessageAt,
      startedAt: s.conversations.startedAt,
    })
    .from(s.conversations)
    .where(yoursOnly(db))
    .orderBy(desc(s.conversations.lastMessageAt))
    .all();

  if (!rows.length) {
    return {
      conversations: [],
      lede: surfaceNote(db, "chat", "line", surface),
      restraint: surfaceNote(db, "chat", "restraint", surface) || null,
      waiting: 0,
    };
  }

  const ids = rows.map((row) => row.id);

  // Which conversations have a blocking question open. One query for the lot
  // rather than one per row, because this list is drawn on every chat load.
  const waiting = new Set(
    db
      .select({ subjectId: s.decisions.subjectId })
      .from(s.decisions)
      .where(and(
        inArray(s.decisions.subjectId, ids),
        eq(s.decisions.state, "open"),
        eq(s.decisions.blocking, true),
      ))
      .all()
      .map((row) => row.subjectId)
      .filter((id): id is string => Boolean(id)),
  );

  // The last thing said in each, and by whom. `sentBy` matters: a conversation
  // whose final turn is yours is one the agent has not answered yet.
  const last = new Map<string, { body: string; by: string | null }>();
  for (const row of db
    .select({
      conversationId: s.messages.conversationId,
      body: s.messages.body,
      sentBy: s.messages.sentBy,
      seq: s.messages.seq,
    })
    .from(s.messages)
    .where(inArray(s.messages.conversationId, ids))
    .orderBy(asc(s.messages.seq))
    .all()) {
    last.set(row.conversationId, { body: row.body, by: row.sentBy });
  }

  const conversations: ChatConversationRow[] = rows.map((row): ChatConversationRow => {
    const tail = last.get(row.id);
    return {
      id: row.id,
      title: row.title,
      lede: ledeFor(tail),
      when: listStamp(row.lastMessageAt ?? row.startedAt ?? now, now),
      state: waiting.has(row.id) ? "attention" : tail ? "done" : "idle",
    };
  });

  return {
    conversations,
    lede: surfaceNote(db, "chat", "line", surface),
    restraint: surfaceNote(db, "chat", "restraint", surface) || null,
    waiting: waiting.size,
  };
}

/**
 * One line about where a conversation got to.
 *
 * The agent's last sentence, or yours if it has not answered yet — said as a
 * quotation in that case, because "Anything I need to look at?" sitting in a
 * list without quotes reads as the agent asking you.
 */
function ledeFor(tail: { body: string; by: string | null } | undefined): string {
  if (!tail) return "Nothing said yet.";
  const first = tail.body.trim().split(/(?<=[.!?])\s/)[0]?.trim() ?? tail.body.trim();
  const line = first.length > 110 ? `${first.slice(0, 109)}…` : first;
  return tail.by === "user" ? `You: ${line}` : line;
}

/** Everything one conversation draws. */
export function loadChat(
  db: Db,
  conversationId: string,
  now = new Date(),
  surface: Surface = "desktop",
): ChatPayload {
  const rows = db
    .select({
      id: s.messages.id,
      body: s.messages.body,
      sentAt: s.messages.sentAt,
      sentBy: s.messages.sentBy,
      direction: s.messages.direction,
      note: s.agentTurns.note,
      toolSummary: s.agentTurns.toolSummary,
      decisionId: s.agentTurns.decisionId,
    })
    .from(s.messages)
    .leftJoin(s.agentTurns, eq(s.agentTurns.messageId, s.messages.id))
    .where(eq(s.messages.conversationId, conversationId))
    .orderBy(asc(s.messages.seq))
    .all();

  const approvals = loadApprovals(
    db,
    rows.map((row) => row.decisionId).filter((id): id is string => Boolean(id)),
  );

  const turns: ChatTurnRow[] = rows.map((row) => ({
    id: row.id,
    // `direction` is the fallback rather than the source: `sentBy` is the
    // column that means "who wrote this", and inbound/outbound is about which
    // way it travelled, which is the same thing here and is not in email.
    by: row.sentBy ?? (row.direction === "inbound" ? "user" : "agent"),
    body: row.body,
    at: turnStamp(row.sentAt, now),
    note: row.note ?? null,
    toolSummary: row.toolSummary ?? null,
    // Only the summary is stored. The calls behind it are `run_steps`, which a
    // chat turn does not create yet — see ../schema/chat.ts on `runId`.
    calls: [],
    approval: row.decisionId ? approvals.get(row.decisionId) ?? null : null,
  }));

  const conversation = db
    .select({ title: s.conversations.title })
    .from(s.conversations)
    .where(eq(s.conversations.id, conversationId))
    .get();

  return {
    conversationId,
    title: conversation?.title ?? null,
    lede: surfaceNote(db, "chat", "line", surface),
    restraint: surfaceNote(db, "chat", "restraint", surface) || null,
    turns,
    waiting: turns.filter((turn) => turn.approval?.state === "open").length,
  };
}

/** Whether two instants fall on the same local day. */
const sameDay = (at: Date, now: Date) => dayKey(at) === dayKey(now);

/**
 * A turn's stamp: "09:38" today, "Aug 17, 09:18" before that.
 *
 * `stampLong` rather than `stamp`, which is the mid-sentence form and
 * lowercases the day — "aug 17, 09:18" is right inside "halted yesterday,
 * 21:04" and wrong as a label standing on its own.
 */
function turnStamp(at: Date, now: Date): string {
  return sameDay(at, now) ? clock(at) : stampLong(at, now);
}

/**
 * A list row's stamp: "11:23", "Yesterday", "Aug 22".
 *
 * No clock on anything but today, which is the design's own arrangement and is
 * right: the minute a conversation from March ended is not what you are
 * scanning the list for.
 */
function listStamp(at: Date, now: Date): string {
  return sameDay(at, now) ? clock(at) : dayName(at, now);
}

/** Every approval named by the transcript, in one pass rather than one per turn. */
function loadApprovals(db: Db, ids: readonly string[]): Map<string, ChatApproval> {
  const found = new Map<string, ChatApproval>();
  if (!ids.length) return found;

  const decisions = db
    .select({
      id: s.decisions.id,
      title: s.decisions.title,
      body: s.decisions.body,
      state: s.decisions.state,
      chosenActionId: s.decisions.chosenActionId,
    })
    .from(s.decisions)
    .where(inArray(s.decisions.id, [...ids]))
    .all();

  const buttons = db
    .select({
      id: s.actions.id,
      decisionId: s.actions.decisionId,
      label: s.actions.label,
      stance: s.actions.stance,
      effect: s.actions.effect,
    })
    .from(s.actions)
    .where(inArray(s.actions.decisionId, [...ids]))
    .orderBy(asc(s.actions.ordinal))
    .all();

  const facts = db
    .select({
      subjectId: s.attributes.subjectId,
      label: s.attributes.label,
      value: s.attributes.value,
    })
    .from(s.attributes)
    .where(and(inArray(s.attributes.subjectId, [...ids]), eq(s.attributes.groupSlot, "effect")))
    .orderBy(asc(s.attributes.ordinal))
    .all();

  // The short reference the bubble prints, and the two prose slots either side
  // of the buttons: what it has not done while waiting, and what followed.
  const refs = db
    .select({ subjectId: s.attributes.subjectId, value: s.attributes.value })
    .from(s.attributes)
    .where(and(
      inArray(s.attributes.subjectId, [...ids]),
      eq(s.attributes.groupSlot, "meta"),
      eq(s.attributes.label, "ref"),
    ))
    .all();

  const prose = db
    .select({
      subjectId: s.narratives.subjectId,
      slot: s.narratives.slot,
      ordinal: s.narratives.ordinal,
      text: s.narratives.text,
    })
    .from(s.narratives)
    .where(and(
      inArray(s.narratives.subjectId, [...ids]),
      inArray(s.narratives.slot, ["restraint", "outcome"]),
    ))
    .orderBy(asc(s.narratives.ordinal))
    .all();

  for (const decision of decisions) {
    const mine = buttons.filter((button) => button.decisionId === decision.id);
    const chosenRow = mine.find((button) => button.id === decision.chosenActionId);
    const chosen = chosenRow
      ? { label: chosenRow.label, approves: (chosenRow.effect as { approves?: unknown }).approves === true }
      : undefined;
    const mineProse = (slot: string) =>
      prose.filter((line) => line.subjectId === decision.id && line.slot === slot).map((line) => line.text);
    found.set(decision.id, {
      decisionId: decision.id,
      ref: refs.find((row) => row.subjectId === decision.id)?.value ?? "",
      title: decision.title,
      why: decision.body ?? null,
      hold: mineProse("restraint").join(" ") || null,
      facts: facts
        .filter((fact) => fact.subjectId === decision.id)
        .map((fact) => [fact.label, fact.value] as [string, string]),
      choices: mine.map((button): ChatChoice => ({
        id: button.id,
        label: button.label,
        stance: button.stance,
      })),
      state: decision.state,
      chosenId: decision.chosenActionId ?? null,
      settled: settledLine(decision.state, mineProse("outcome"), chosen),
    });
  }
  return found;
}
