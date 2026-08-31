// The wire shape of the Chat surface: GET /api/chat, and the SSE stream that
// POST /api/chat/messages answers with.
//
// Pure types and nothing else, for the same reason src/shared/home.ts is: the
// browser half compiles against this file and has no Bun types.
//
// One thing about the shape is worth saying out loud. A turn's tool calls and
// its approval are drawn from two different places at two different times — the
// stream, while it is happening, and this payload, once it is written down —
// and both have to produce the same bubble. So the live event in
// src/chat/turn.ts and the stored row here agree field for field on purpose;
// where they differ, the screen would draw a turn one way as it arrived and
// another way after a reload.

/** One completed tool call, as the design's mono line draws it:
 *  `memory.read okf:contact/ferris · 0.4s`. */
export interface ChatToolCall {
  /** Dotted, as the design writes it: `reminders.create`. */
  name: string;
  arg: string | null;
  duration: string;
  /** A read ran on its own; a write was put to you first. */
  kind: "read" | "write";
  ok: boolean;
}

/** One button. `id` is what the client posts back — never a boolean. */
export interface ChatChoice {
  id: string;
  label: string;
  stance: "affirm" | "neutral" | "quiet" | "danger" | "bare";
}

/** A `[label, value]` line of machine fact, as `attributes` stores it and as
 *  the approval bubble draws it under the ask. */
export type ChatFact = readonly [label: string, value: string];

/** How an approval ended. "expired" is the clock, not a person. */
export type ApprovalOutcome = "approved" | "declined" | "expired";

/** The approval a turn is sitting on, or the one it sat on and got answered. */
export interface ChatApproval {
  decisionId: string;
  /** The short reference the bubble prints: `ap/0824-2`. */
  ref: string;
  title: string;
  /** Why it is asking at all, in its own words. */
  why: string | null;
  /** What it has NOT done while waiting: "Filled and unsent. Nothing is
   *  committed." The useful half of the question, and the design's own field. */
  hold: string | null;
  /** The `[label, value]` machine facts under the ask. */
  facts: Array<[string, string]>;
  choices: ChatChoice[];
  /** "open" is the only one with live buttons. */
  state: "open" | "resolved" | "dismissed" | "expired" | "superseded";
  /** Which button was pressed, once one was. */
  chosenId: string | null;
  /** What followed, in the transcript's own words: "You said 'Go ahead', 15:20.
   *  Nothing was written." Null while open. */
  settled: string | null;
}

export interface ChatTurnRow {
  id: string;
  /** "user" or "agent" — the two halves of this conversation. Your words are
   *  drawn as a bubble and the agent's as prose, which is the design's way of
   *  saying which of you is speaking without labelling every line. */
  by: "user" | "agent";
  body: string;
  /** "09:39", "Thu 09:39" — read against the clock, never stored. */
  at: string;
  /** The mono line under the prose: "written to okf:policy/ferris-hold · rev 1". */
  note: string | null;
  /** "4 tool calls · docs.read, web.form_walk, calendar.check". */
  toolSummary: string | null;
  /** The calls behind the summary, once the run that made them is readable.
   *  Empty on a reload today: only the summary is stored. */
  calls: ChatToolCall[];
  approval: ChatApproval | null;
}

/** One row of the conversation list — the desktop's aside, the phone's screen. */
export interface ChatConversationRow {
  id: string;
  /** Six words of the first thing you said in it. Null until you say one. */
  title: string | null;
  /** The agent's line about where this one got to. */
  lede: string;
  /** "11:23", "Yesterday", "Aug 22". */
  when: string;
  /** The status mark beside it. "attention" means it is waiting on you. */
  state: "attention" | "running" | "done" | "failed" | "idle";
}

export interface ChatListPayload {
  /** Newest first, as the design draws them. */
  conversations: ChatConversationRow[];
  /** The agent's standing line for the list. */
  lede: string;
  /** What it has NOT done — "Nothing has gone out since 09:39". */
  restraint: string | null;
  /** How many are waiting on you, across all of them. */
  waiting: number;
}

export interface ChatPayload {
  conversationId: string;
  /** What this conversation is called. Null while nothing has been said. */
  title: string | null;
  /** The agent's standing line for the screen, from `surface_notes`. */
  lede: string;
  /** What it has NOT done — "Nothing has gone out since 09:39". */
  restraint: string | null;
  turns: ChatTurnRow[];
  /** Open approvals in this chat, whether or not this process is still holding
   *  the run behind them. A reload after a restart finds these and can say so
   *  rather than drawing live buttons that answer nothing. */
  waiting: number;
}

/**
 * Everything the screen learns while a turn runs — the frames
 * `POST /api/chat/:id/messages` streams.
 *
 * Here rather than in src/chat/turn.ts because BOTH ends of the wire are typed
 * from it: the server emits these (src/chat/turn.ts, src/http/routes/chat.ts)
 * and the browser folds them into the turn on screen (web/src/app/chat.ts).
 * They were two hand-maintained copies, and the client's fold switches
 * exhaustively over its own union — so a kind added on one side and not the
 * other type-checked cleanly on both and dropped the live turn off the screen
 * at runtime.
 *
 * Deliberately flat and JSON-only. `kind` is spelled out rather than imported
 * from src/core/tools.ts for the reason at the top of this file: the browser
 * half compiles against it and has no Bun types.
 */
export type ChatEvent =
  /** The model fetched a group's tools. The screen says so, because opening
   *  ten groups and opening one are very different turns to watch. */
  | { type: "opened"; group: string }
  /**
   * The agent said something on its way to doing something else.
   *
   * Separate from `message` because it is not the answer: it is the sentence
   * before the act, and the approval bubble underneath it is unreadable without
   * it. Not stored — only the turn's final prose is written down — so a reload
   * shows the outcome where the live stream showed the intent.
   */
  | { type: "say"; body: string }
  /** One completed tool call, as ToolCalls.tsx draws it. */
  | {
    type: "tool";
    name: string;
    kind: "read" | "write";
    arg: string | null;
    duration: string;
    ok: boolean;
  }
  /** A write is waiting on you. The turn is stopped until /decisions answers. */
  | {
    type: "approval";
    decisionId: string;
    /** The short reference the bubble prints: `ap/0824-2`. */
    ref: string;
    title: string;
    /** Why it is asking at all. The tool's own first sentence. */
    why: string | null;
    /** What it has not done while it waits. */
    hold: string | null;
    tool: string;
    facts: readonly ChatFact[];
    actions: readonly ChatChoice[];
  }
  /** How an approval ended — including "expired", which the screen would
   *  otherwise have to infer from a stream that simply stopped. */
  | { type: "settled"; decisionId: string; outcome: ApprovalOutcome }
  /** The turn's prose, once. */
  | {
    type: "message";
    messageId: string;
    body: string;
    note: string | null;
    toolSummary: string | null;
  }
  | { type: "error"; message: string };
