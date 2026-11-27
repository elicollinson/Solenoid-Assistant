// The Chat surface: the transcript, and what is still waiting in it.
//
// Checkpoint-backed chats hydrate their full turns (including completed tool
// calls, ×N toolSummary collapse, opened-group notes, voice/subagent provenance,
// and blocking + deferred approvals) directly from the latest AG-UI thread
// checkpoint in `chat_checkpoints`, joined with relational `decisions`/`actions`.
// Legacy conversations without checkpoints fall back cleanly to `messages` +
// `agent_turns`.
//
// The stamp is derived, like every other stamp in this directory. A stored
// "09:39" is right until midnight and then reads as this morning.
import type { Message } from "@ag-ui/core";
import type { ChatMessage, PendingInterrupt } from "@elicollinson/solenoid-engine";
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import type { Db } from "../index";
import * as s from "../schema";
import { APPROVAL_META_LABEL, parseApprovalMeta } from "../chatCheckpoints";
import { hydrateTurnsFromThread } from "../../chat/translator";
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

function tailFromCheckpoint(
  transcript: readonly ChatMessage[] | null | undefined,
  thread: readonly Message[] | null | undefined,
): { body: string; by: string | null } | undefined {
  if (transcript?.length) {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const m = transcript[i];
      if (!m) continue;
      if ((m.role === "assistant" || m.role === "user") && typeof m.content === "string" && m.content.trim()) {
        return { body: m.content, by: m.role === "user" ? "user" : "agent" };
      }
    }
  }
  if (thread?.length) {
    for (let i = thread.length - 1; i >= 0; i--) {
      const m = thread[i];
      if (!m) continue;
      if ((m.role === "assistant" || m.role === "user") && typeof m.content === "string" && m.content.trim()) {
        return { body: m.content, by: m.role === "user" ? "user" : "agent" };
      }
    }
  }
  return undefined;
}

/**
 * The conversation list — the desktop's aside, the phone's own screen.
 *
 * Three of the four columns are derived and none of them could be stored. The
 * stamp is a reading of the clock; the state is "is anything in it waiting on
 * you" (blocking OR deferred subagent approvals, or a running checkpoint); and
 * the lede is the last thing the agent said in it, first sentence only,
 * because a list row is one line and the turn it comes from is four.
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
      model: s.conversations.model,
      voiceInvoked: s.conversations.voiceInvoked,
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

  // Conversations with ANY open approval — blocking turn gates OR deferred
  // subagent approvals — need the user's attention.
  const waiting = new Set(
    db
      .select({ subjectId: s.decisions.subjectId })
      .from(s.decisions)
      .where(and(inArray(s.decisions.subjectId, ids), eq(s.decisions.state, "open")))
      .all()
      .map((row) => row.subjectId)
      .filter((id): id is string => Boolean(id)),
  );

  // Join top-level `chat_sessions` with their latest `chat_checkpoints` row in one pass.
  const checkpointRows = db
    .select({
      sessionId: s.chatSessions.id,
      title: s.chatSessions.title,
      status: s.chatSessions.status,
      updatedAt: s.chatSessions.updatedAt,
      transcript: s.chatCheckpoints.transcript,
      thread: s.chatCheckpoints.thread,
    })
    .from(s.chatSessions)
    .leftJoin(
      s.chatCheckpoints,
      and(
        eq(s.chatCheckpoints.sessionId, s.chatSessions.id),
        eq(s.chatCheckpoints.seq, s.chatSessions.lastSeq),
      ),
    )
    .where(and(inArray(s.chatSessions.id, ids), isNull(s.chatSessions.parentId)))
    .all();
  const checkpointById = new Map(checkpointRows.map((row) => [row.sessionId, row]));

  // Fallback to legacy `messages` only for conversations without a checkpoint.
  const legacyIds = ids.filter((id) => !checkpointById.has(id));
  const last = new Map<string, { body: string; by: string | null }>();
  if (legacyIds.length) {
    for (const row of db
      .select({
        conversationId: s.messages.conversationId,
        body: s.messages.body,
        sentBy: s.messages.sentBy,
        seq: s.messages.seq,
      })
      .from(s.messages)
      .where(inArray(s.messages.conversationId, legacyIds))
      .orderBy(asc(s.messages.seq))
      .all()) {
      last.set(row.conversationId, { body: row.body, by: row.sentBy });
    }
  }

  const conversations: ChatConversationRow[] = rows.map((row): ChatConversationRow => {
    const cp = checkpointById.get(row.id);
    const tail = cp ? tailFromCheckpoint(cp.transcript, cp.thread) : last.get(row.id);
    const cpTitle = cp?.title && cp.title !== "Untitled session" ? cp.title : null;
    const stampAt =
      row.lastMessageAt ?? (cp?.updatedAt ? new Date(cp.updatedAt) : null) ?? row.startedAt ?? now;
    const isWaiting = waiting.has(row.id) || cp?.status === "waiting_approval";

    let state: ChatConversationRow["state"];
    if (isWaiting) {
      state = "attention";
    } else if (cp?.status === "running") {
      state = "running";
    } else if (cp?.status === "failed") {
      state = "failed";
    } else if (tail) {
      state = "done";
    } else {
      state = "idle";
    }

    return {
      id: row.id,
      title: row.title ?? cpTitle,
      lede: ledeFor(tail),
      when: listStamp(stampAt, now),
      state,
      model: row.model ?? null,
      voiceInvoked: Boolean(row.voiceInvoked),
    };
  });

  return {
    conversations,
    lede: surfaceNote(db, "chat", "line", surface),
    restraint: surfaceNote(db, "chat", "restraint", surface) || null,
    waiting: conversations.filter((c) => c.state === "attention").length,
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

function extractPendingInterrupts(pending: unknown): PendingInterrupt[] {
  if (!pending || typeof pending !== "object") return [];
  const list = (pending as { interrupts?: unknown }).interrupts;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item): item is PendingInterrupt =>
      Boolean(item) && typeof item === "object" && typeof (item as { toolCallId?: unknown }).toolCallId === "string",
  );
}

/** Everything one conversation draws. */
export function loadChat(
  db: Db,
  conversationId: string,
  now = new Date(),
  surface: Surface = "desktop",
): ChatPayload {
  const conversation = db
    .select({
      title: s.conversations.title,
      model: s.conversations.model,
      voiceInvoked: s.conversations.voiceInvoked,
    })
    .from(s.conversations)
    .where(eq(s.conversations.id, conversationId))
    .get();

  const latestCheckpoint = db
    .select({
      thread: s.chatCheckpoints.thread,
      pending: s.chatCheckpoints.pending,
    })
    .from(s.chatCheckpoints)
    .where(eq(s.chatCheckpoints.sessionId, conversationId))
    .orderBy(desc(s.chatCheckpoints.seq))
    .limit(1)
    .get();

  if (latestCheckpoint) {
    const sessionRow = db
      .select({ title: s.chatSessions.title })
      .from(s.chatSessions)
      .where(eq(s.chatSessions.id, conversationId))
      .get();

    const conversationDecisions = db
      .select({ id: s.decisions.id })
      .from(s.decisions)
      .where(eq(s.decisions.subjectId, conversationId))
      .orderBy(asc(s.decisions.openedAt))
      .all();

    const pendingInterrupts = extractPendingInterrupts(latestCheckpoint.pending);
    const interruptToolCallByApprovalId = new Map<string, string>();
    const allDecisionIds: string[] = [];
    const seenIds = new Set<string>();

    for (const row of conversationDecisions) {
      seenIds.add(row.id);
      allDecisionIds.push(row.id);
    }
    for (const interrupt of pendingInterrupts) {
      if (interrupt.approvalId) {
        interruptToolCallByApprovalId.set(interrupt.approvalId, interrupt.toolCallId);
        if (!seenIds.has(interrupt.approvalId)) {
          seenIds.add(interrupt.approvalId);
          allDecisionIds.push(interrupt.approvalId);
        }
      }
    }

    const loadedApprovals = loadApprovalsWithMeta(db, allDecisionIds);
    const approvalsByToolCallId = new Map<string, ChatApproval>();
    const deferredApprovals: ChatApproval[] = [];

    for (const id of allDecisionIds) {
      const entry = loadedApprovals.get(id);
      if (!entry) continue;
      if (entry.blocking) {
        const toolCallId = entry.toolCallId ?? interruptToolCallByApprovalId.get(id);
        if (toolCallId) {
          approvalsByToolCallId.set(toolCallId, entry.approval);
        }
      } else {
        deferredApprovals.push(entry.approval);
      }
    }
    for (const interrupt of pendingInterrupts) {
      if (!interrupt.approvalId) continue;
      const entry = loadedApprovals.get(interrupt.approvalId);
      if (entry && !approvalsByToolCallId.has(interrupt.toolCallId)) {
        approvalsByToolCallId.set(interrupt.toolCallId, entry.approval);
      }
    }

    const turns = hydrateTurnsFromThread(latestCheckpoint.thread, {
      now,
      approvalsByToolCallId,
      deferredApprovals,
    });

    const waiting = [...loadedApprovals.values()].filter(
      (entry) => entry.approval.state === "open",
    ).length;

    const sessionTitle =
      sessionRow?.title && sessionRow.title !== "Untitled session" ? sessionRow.title : null;

    return {
      conversationId,
      title: conversation?.title ?? sessionTitle,
      model: conversation?.model ?? null,
      voiceInvoked:
        Boolean(conversation?.voiceInvoked) || turns.some((turn) => turn.source === "voice"),
      lede: surfaceNote(db, "chat", "line", surface),
      restraint: surfaceNote(db, "chat", "restraint", surface) || null,
      turns,
      waiting,
    };
  }

  // Legacy path for conversations without checkpoints (direct `messages` + `agent_turns`).
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

  const turnDecisionIds = rows
    .map((row) => row.decisionId)
    .filter((id): id is string => Boolean(id));
  const approvals = loadApprovals(db, turnDecisionIds);

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

  const turnDecisionSet = new Set(turnDecisionIds);
  const extraOpenDecisions = db
    .select({ id: s.decisions.id })
    .from(s.decisions)
    .where(and(eq(s.decisions.subjectId, conversationId), eq(s.decisions.state, "open")))
    .all()
    .filter((row) => !turnDecisionSet.has(row.id));

  return {
    conversationId,
    title: conversation?.title ?? null,
    model: conversation?.model ?? null,
    voiceInvoked: Boolean(conversation?.voiceInvoked),
    lede: surfaceNote(db, "chat", "line", surface),
    restraint: surfaceNote(db, "chat", "restraint", surface) || null,
    turns,
    waiting: turns.filter((turn) => turn.approval?.state === "open").length + extraOpenDecisions.length,
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

interface LoadedApprovalEntry {
  approval: ChatApproval;
  blocking: boolean;
  toolCallId?: string;
}

/** Every approval named by a conversation/transcript, in one pass with metadata. */
function loadApprovalsWithMeta(
  db: Db,
  ids: readonly string[],
): Map<string, LoadedApprovalEntry> {
  const found = new Map<string, LoadedApprovalEntry>();
  if (!ids.length) return found;

  const decisions = db
    .select({
      id: s.decisions.id,
      title: s.decisions.title,
      body: s.decisions.body,
      state: s.decisions.state,
      blocking: s.decisions.blocking,
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
      effectKind: s.actions.effectKind,
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

  const metaAttrs = db
    .select({
      subjectId: s.attributes.subjectId,
      label: s.attributes.label,
      value: s.attributes.value,
    })
    .from(s.attributes)
    .where(
      and(
        inArray(s.attributes.subjectId, [...ids]),
        eq(s.attributes.groupSlot, "meta"),
        inArray(s.attributes.label, ["ref", APPROVAL_META_LABEL]),
      ),
    )
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
      ? {
          label: chosenRow.label,
          approves:
            (chosenRow.effect as { approves?: unknown }).approves === true ||
            chosenRow.effectKind === "tool_call",
        }
      : undefined;
    const mineProse = (slot: string) =>
      prose.filter((line) => line.subjectId === decision.id && line.slot === slot).map((line) => line.text);

    const ref =
      metaAttrs.find((row) => row.subjectId === decision.id && row.label === "ref")?.value ?? "";
    const meta = parseApprovalMeta(
      metaAttrs.find((row) => row.subjectId === decision.id && row.label === APPROVAL_META_LABEL)
        ?.value,
    );
    const isDeferred = meta?.mode === "deferred" || !decision.blocking;
    const subagentName =
      typeof meta?.scope?.subagentName === "string" ? meta.scope.subagentName : null;
    const toolCallId =
      typeof meta?.scope?.toolCallId === "string" ? meta.scope.toolCallId : undefined;

    const approval: ChatApproval = {
      decisionId: decision.id,
      ref,
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
      ...(isDeferred ? { deferred: true, subagentName } : {}),
    };

    found.set(decision.id, {
      approval,
      blocking: !isDeferred,
      ...(toolCallId ? { toolCallId } : {}),
    });
  }
  return found;
}

/** Every approval named by the transcript, in one pass rather than one per turn. */
function loadApprovals(db: Db, ids: readonly string[]): Map<string, ChatApproval> {
  const withMeta = loadApprovalsWithMeta(db, ids);
  const plain = new Map<string, ChatApproval>();
  for (const [id, entry] of withMeta) {
    plain.set(id, entry.approval);
  }
  return plain;
}
