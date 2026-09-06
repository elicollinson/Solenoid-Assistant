// One turn of the conversation, from the moment you press send.
//
// This is where the three halves meet: the agent in ../agents/chat.ts, which
// knows how to stop; the tables in ../db/mutations/chat.ts, which know how to
// write it down; and an HTTP response that has to stay open across both.
//
// The shape is an async generator because that is what an approval demands. A
// turn is not request/response — it is "some tool calls, then a question, then
// silence until a person answers, then more tool calls" — and the only thing
// that models that honestly is a stream the server can leave half-finished.
//
// ## The pending map, and why it is in a module
//
// The run waiting for an approval and the request answering it are two
// different HTTP requests. The first is suspended inside a promise; the second
// arrives on a different connection and has to find that promise. A module-level
// map is what connects them, and it carries the one real limitation of this
// design out loud: IT IS THIS PROCESS ONLY. Restart the server with an approval
// open and the run behind it is gone — the `decisions` row survives, so the
// screen can still say a question was asked and never answered, but nothing can
// resume it. Two servers would need this in the database with a lease. One
// server is what this product runs, so this is a map.
import { log } from "../core/logger";
import { clock } from "../db/queries/_format";
import type { ChatAgent } from "../agents/chat";
import type { Db } from "../db";
import type { ChatMessage } from "../core/providers";
import { loadChat } from "../db/queries/chat";
import {
  NoSuchDecisionError,
  appendAgentMessage,
  appendUserMessage,
  noteApprovalOutcome,
  openApproval,
  readChoice,
  settleApproval,
} from "../db/mutations/chat";
import {
  displayName,
  summarize,
  withTurn,
  type ApprovalDecision,
  type ApprovalOutcome,
  type ApprovalRequest,
  type ChatEvent,
  type ChatFact,
} from "./turn";

/**
 * What is true while an approval waits.
 *
 * A constant because it is: this gate sits in front of the call, so at the
 * moment it is drawn nothing has run and nothing has changed. The design's own
 * examples are richer — "Filled and unsent. Nothing is committed." — because
 * there the agent had already walked a form. When a tool can report how far it
 * got before stopping, this becomes its sentence rather than ours.
 */
const HOLD = "Nothing has been written. I stopped before the call.";

/** How long a question waits for you before it gives up. */
export const DEFAULT_APPROVAL_MS = 10 * 60_000;

/**
 * How many turns of the past go back to the model.
 *
 * A cap rather than the lot, and a blunt one. What it is protecting is not cost
 * but the injection screen: everything of one origin is concatenated before it
 * is looked at, so an unbounded transcript eventually becomes a single very
 * long string to scan on every turn.
 */
const HISTORY_TURNS = 40;

interface Pending {
  answer(outcome: ApprovalOutcome): void;
}

const pending = new Map<string, Pending>();

/** Whether a run in this process is still holding the question open. */
export function isHeld(decisionId: string): boolean {
  return pending.has(decisionId);
}

export class NotWaitingError extends Error {
  constructor(decisionId: string) {
    super(
      `Decision ${decisionId} is not being held by this process. The run that ` +
        "asked has ended — restarted, timed out, or already answered.",
    );
    this.name = "NotWaitingError";
  }
}

/**
 * Answer an approval, from the other request.
 *
 * Writes the settlement first and releases the run second. That order is the
 * one that survives a crash between the two: a decision recorded as resolved
 * with nothing released reads correctly on the next page load, where the
 * reverse — a write let through and never recorded — does not.
 */
export function answerApproval(db: Db, actionId: string, now = new Date()): {
  decisionId: string;
  outcome: ApprovalOutcome;
} {
  const choice = readChoice(db, actionId);
  if (!choice) throw new NoSuchDecisionError(actionId);
  const outcome: ApprovalOutcome = choice.approves ? "approved" : "declined";
  // The first half of the outcome line, and all of it that is certainly true
  // right now. The second half — what the call actually did — is appended by
  // `noteApprovalOutcome` once it has returned.
  settleApproval(
    db,
    choice.decisionId,
    { actionId, outcome, said: `You said "${choice.label}", ${clock(now)}.` },
    now,
  );

  const held = pending.get(choice.decisionId);
  if (!held) throw new NotWaitingError(choice.decisionId);
  held.answer(outcome);
  return { decisionId: choice.decisionId, outcome };
}

export interface ChatTurnOptions {
  now?: Date;
  approvalMs?: number;
}

/**
 * Say something, and watch what happens.
 *
 * Yields until the turn is finished. Nothing here throws: a failure becomes an
 * `error` event, because the caller is an open HTTP stream that has already
 * sent a 200 and cannot go back and make it a 500.
 */
export async function* runChatTurn(
  db: Db,
  agent: ChatAgent,
  conversationId: string,
  text: string,
  options: ChatTurnOptions = {},
): AsyncGenerator<ChatEvent> {
  const now = options.now ?? new Date();
  const approvalMs = options.approvalMs ?? DEFAULT_APPROVAL_MS;

  // Everything the run produces lands here; the loop below drains it. One
  // buffer and one waiter rather than a stream library: `emit` is called from
  // deep inside the agent and must never be able to block it.
  const queue: ChatEvent[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  const emit = (event: ChatEvent) => {
    queue.push(event);
    wake?.();
    wake = undefined;
  };

  const calls: Array<{ name: string }> = [];
  const opened = new Set<string>();
  // The last thing the agent said before it acted. This is the ask: the model
  // is told to say what it is about to do before doing it, and that sentence is
  // written for a person, where the tool's own description is written for a
  // model. "Put something on the list and answer with the id it minted" is
  // accurate and completely unanswerable.
  let said: string | undefined;

  appendUserMessage(db, conversationId, text, now);
  const history = transcript(db, conversationId, now);

  const turn = {
    conversationId,
    emit(event: ChatEvent) {
      // The two running tallies the closing message needs. Kept here rather
      // than recounted at the end because the events are the only record: a
      // tool call is not written down anywhere on its own.
      if (event.type === "tool") calls.push({ name: event.name });
      if (event.type === "opened") opened.add(event.group);
      if (event.type === "say") said = event.body;
      emit(event);
    },
    decide: (request: ApprovalRequest) => ask(db, conversationId, request, said, emit, approvalMs),
    settled(decisionId: string, error: string | null, called: string) {
      noteApprovalOutcome(
        db,
        decisionId,
        error
          ? `${called} was allowed and failed: ${error}`
          : `${called} ran and finished.`,
      );
    },
  };

  // Started INSIDE withTurn, not before it. An AsyncLocalStorage context is
  // entered by the call, so a promise created outside `withTurn` and merely
  // awaited within it never sees the store — `currentTurn()` would be undefined
  // six frames down and every gate would silently open.
  const running = withTurn(turn, async () => {
    const body = await agent.runMessages(history);
    const toolSummary = summarize(calls);
    const note = noteFor(opened);
    const messageId = appendAgentMessage(db, conversationId, body, { toolSummary, note }, new Date());
    emit({ type: "message", messageId, body, note, toolSummary });
  })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log.error("chat turn failed", { conversationId, error: message });
      emit({ type: "error", message });
    })
    .finally(() => {
      finished = true;
      wake?.();
      wake = undefined;
    });

  while (true) {
    while (queue.length) yield queue.shift()!;
    if (finished) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  await running;
}

/**
 * Put one write to the person and wait.
 *
 * The decision is written before the question is asked, so a screen that
 * reloads mid-wait finds it and can draw the same buttons. Whatever ends the
 * wait, the `finally` takes this out of the pending map — a run that timed out
 * must not leave an entry a later answer could resolve into nothing.
 */
async function ask(
  db: Db,
  conversationId: string,
  request: ApprovalRequest,
  said: string | undefined,
  emit: (event: ChatEvent) => void,
  approvalMs: number,
): Promise<ApprovalDecision> {
  const title = askTitle(request, said);
  const facts = factsFor(request);
  const opened = openApproval(db, {
    conversationId,
    title,
    // What the tool says it does, as the reason this is being asked at all. It
    // is the one sentence available that explains the ACT rather than the
    // intent, and the intent is already the title.
    why: whyFor(request),
    // The design's own field, and the useful half of the question: what is
    // true right now, while it waits. Nothing has run, so nothing has changed.
    hold: HOLD,
    facts,
    choices: [
      // The agent's own words, per ../db/schema/decisions.ts: never "Confirm",
      // never "OK". The affirm reads as the act itself, so the button and the
      // sentence above it are saying the same thing.
      { label: "Go ahead", stance: "affirm", approves: true },
      { label: "Not this one", stance: "quiet", approves: false },
    ],
  });

  emit({
    type: "approval",
    decisionId: opened.decisionId,
    ref: opened.ref,
    title,
    why: whyFor(request),
    hold: HOLD,
    tool: displayName(request.tool),
    facts,
    actions: opened.actions,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abandon: (() => void) | undefined;
  try {
    // Three ways this ends, and only one of them is a person: they answer, the
    // question's own clock runs out, or the run it belongs to is abandoned.
    // The last two are the same outcome — nobody said anything.
    const outcome = await new Promise<ApprovalOutcome>((resolve) => {
      let settled = false;
      const once = (result: ApprovalOutcome) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      pending.set(opened.decisionId, { answer: once });
      timer = setTimeout(() => once("expired"), approvalMs);
      abandon = () => once("expired");
      request.signal?.addEventListener("abort", abandon, { once: true });
    });

    // An answer wrote itself down in answerApproval, on the request that
    // carried it. An expiry has nobody to write it down, so it is done here.
    if (outcome === "expired") {
      try {
        settleApproval(db, opened.decisionId, { outcome: "expired" });
      } catch (error) {
        // The answer and the clock raced and the answer won. Its settlement
        // stands; ours would overwrite a real choice with "no answer".
        if (!(error instanceof NoSuchDecisionError)) throw error;
      }
    }
    emit({ type: "settled", decisionId: opened.decisionId, outcome });
    return { decisionId: opened.decisionId, outcome };
  } finally {
    clearTimeout(timer);
    if (abandon) request.signal?.removeEventListener("abort", abandon);
    // Unconditionally: an entry left behind is one a later answer could resolve
    // into a run that is no longer listening.
    pending.delete(opened.decisionId);
  }
}

/**
 * The sentence the two buttons answer.
 *
 * The agent's own words where it wrote any, which is the usual case: the system
 * prompt asks it to say what it is about to do before it does it, precisely so
 * that this line exists. A tool description is the fallback and a poor one —
 * it is written to instruct a model, and reads to a person as a fragment of
 * somebody else's manual — so it is prefixed into a sentence that at least
 * admits what it is.
 */
function askTitle(request: ApprovalRequest, said: string | undefined): string {
  const spoken = said?.trim();
  if (spoken) return cap(spoken, 240);
  const first = request.description.split(/(?<=[.!?])\s/)[0]?.trim() ?? request.description;
  return cap(`I'd like to write to your ${request.group.replace(/_/g, " ")}. ${first}`, 240);
}

const cap = (text: string, at: number) => (text.length > at ? `${text.slice(0, at - 1)}…` : text);

/**
 * Why it is asking, as opposed to what it is about to do.
 *
 * The title is the agent's intent — "I'll put a hold on Thursday". This is the
 * act underneath it, in the tool's own first sentence, so the person can tell
 * "move one thing on my calendar" from "write to everyone on the invitation".
 * Left out entirely when the title already IS the description, which happens
 * when the model said nothing before acting.
 */
function whyFor(request: ApprovalRequest): string | null {
  const first = request.description.split(/(?<=[.!?])\s/)[0]?.trim();
  return first ? cap(first, 220) : null;
}

/**
 * The machine facts under the ask: the call, and what it was called with.
 *
 * Everything is stringified and capped. A person checking an approval is
 * checking an id against one they know, not reading a payload — and an
 * unbounded value here would put a tool's entire prose argument into a
 * label/value row built for "Ferris hold".
 */
function factsFor(request: ApprovalRequest): ChatFact[] {
  const facts: ChatFact[] = [["Call", displayName(request.tool)]];
  const args = request.args;
  if (args && typeof args === "object") {
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      if (value === undefined || value === null || value === "") continue;
      // A list of prose paragraphs is the commonest non-scalar argument in
      // this codebase, and `["User asked for a reminder."]` reads as a bug to
      // anybody who is not a programmer.
      const rendered = typeof value === "string"
        ? value
        : Array.isArray(value) && value.every((item) => typeof item === "string")
          ? value.join(" · ")
          : JSON.stringify(value);
      facts.push([key, rendered.length > 120 ? `${rendered.slice(0, 119)}…` : rendered]);
      if (facts.length >= 8) break;
    }
  }
  return facts;
}

/** "opened reminders, calendar" — the mono line under a turn that fetched tools. */
function noteFor(opened: ReadonlySet<string>): string | null {
  return opened.size ? `opened ${[...opened].join(", ")}` : null;
}

/**
 * The conversation as the model should see it.
 *
 * Prose only. The tool results from previous turns are deliberately absent: the
 * agent re-reads what it needs, and a transcript that carried every past tool
 * result would grow without bound and would put text a stranger wrote back into
 * the loop on every subsequent turn, long after it was screened.
 *
 * The origins are the whole point of the shape — see ../safety/trust.ts. What
 * you typed is `operator`; what the agent said is `agent`; neither aborts the
 * run on a flag, and both are still looked at and recorded.
 */
function transcript(db: Db, conversationId: string, now: Date): ChatMessage[] {
  const chat = loadChat(db, conversationId, now);
  return chat.turns.slice(-HISTORY_TURNS).map((row): ChatMessage => {
    if (row.by === "user") return { role: "user", content: row.body, origin: "operator" };
    // An answered approval reads back as one line, so the agent knows it asked
    // and knows what it was told, without a second round trip to find out.
    const settled = row.approval?.settled;
    return {
      role: "assistant",
      content: settled ? `${row.body}\n(${settled})` : row.body,
      origin: "agent",
    };
  });
}
