// What one chat turn can reach out of the agent loop, and how it stops.
//
// The Agent in ../core/rawAgent.ts is a batch runner: hand it a transcript, get
// a string back. A chat is not that. The screen has to see a tool call while it
// is happening, and a write has to STOP and wait for a person — mid-loop, with
// the model's turn half-finished and its transcript still open.
//
// Neither of those fits an argument to `run()`, because the thing that needs
// them is `invokeTool`, six frames down and inside a provider continuation. The
// options were to thread a context parameter through every protected method, or
// to keep it beside the call stack. This is the second: one AsyncLocalStorage,
// entered once per HTTP request, read wherever it is needed.
//
// The cost of the choice is stated plainly rather than hidden: code that reads
// `currentTurn()` outside `runChatTurn` gets `undefined`, and every caller here
// treats that as "not in a chat" rather than as an error. An agent invoked from
// a workflow has no screen to ask, and must not block waiting for one.
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The wire shape, from the one file both ends compile against.
 *
 * `ChatEvent` used to be declared here and again by hand in
 * web/src/app/chat.ts, with nothing to hold the two together — see the note on
 * it in ../shared/chat.ts for what that cost. Re-exported rather than merely
 * imported so that everything about one turn is still reachable from this file,
 * which is where the rest of the codebase looks for it.
 */
export type { ApprovalOutcome, ChatEvent, ChatFact } from "../shared/chat";
import type { ApprovalOutcome, ChatEvent } from "../shared/chat";

/** How an approval ended, and which decision it was. */
export interface ApprovalDecision {
  decisionId: string;
  outcome: ApprovalOutcome;
}

/** What a write tool needs a person to answer before it runs. */
export interface ApprovalRequest {
  tool: string;
  args: unknown;
  /** The group the tool came out of, for the facts under the ask. */
  group: string;
  /** What the tool itself says it does. The ask is written from this rather
   *  than from the tool's name, because a person answering "may I do this"
   *  deserves the sentence and not the identifier. */
  description: string;
  /** The run's deadline. An approval outlives no run: when this fires the
   *  decision expires rather than waiting for somebody who has gone. */
  signal?: AbortSignal;
}

export interface ChatTurn {
  /** The conversation this turn belongs to. */
  conversationId: string;
  emit(event: ChatEvent): void;
  /**
   * Stop and ask. Resolves when a person answers, when the turn's deadline
   * passes, or when the request is aborted.
   *
   * Never rejects on a decline — a refused write is an ordinary outcome the
   * model should hear about and work around, not an exception that ends the
   * conversation.
   */
  decide(request: ApprovalRequest): Promise<ApprovalDecision>;
  /**
   * What became of a call you allowed.
   *
   * The other half of the transcript's outcome line: "You said 'Go ahead',
   * 15:20." is written the moment you press the button, and this is the
   * sentence that can only be written once the call has returned.
   *
   * `error` is null when the call worked, and is the failure as the model was
   * told it otherwise. Null rather than "did the output start with 'Error: '" —
   * see `ToolOutcome` in ../core/rawAgent.ts for the record this was getting
   * wrong.
   */
  settled(decisionId: string, error: string | null, called: string): void;
}

const storage = new AsyncLocalStorage<ChatTurn>();

/** The turn in progress, or undefined outside one. See the header. */
export function currentTurn(): ChatTurn | undefined {
  return storage.getStore();
}

/** Run `fn` with `turn` visible to everything it calls, however deep. */
export function withTurn<T>(turn: ChatTurn, fn: () => Promise<T>): Promise<T> {
  return storage.run(turn, fn);
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * `reminders_create` → `reminders.create`.
 *
 * The design writes tool calls dotted — `memory.read okf:contact/ferris · 0.4s`
 * — and this codebase names them with an underscore because that is what the
 * function-calling APIs accept. One is the wire and one is the page.
 */
export function displayName(tool: string): string {
  const cut = tool.indexOf("_");
  return cut < 1 ? tool : `${tool.slice(0, cut)}.${tool.slice(cut + 1)}`;
}

/**
 * The one literal fact a call is about: `okf:contact/ferris`, `Ferris hold`.
 *
 * A guess, and it says so by staying out of the way when it has nothing — the
 * line reads `calendar.list · 0.2s` rather than inventing a subject for a call
 * that has none. Ids beat prose because they are what a person checks against.
 */
export function displayArg(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of ["id", "slug", "workflowSlug", "query", "title", "name", "text"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      const trimmed = value.trim();
      return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed;
    }
  }
  return null;
}

/** `0.4s`, `41ms`. The mono duration the design puts after the dot. */
export function displayDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * "4 tool calls · docs.read, web.form_walk, calendar.check".
 *
 * The ×2 collapse is the design's, and it is load-bearing rather than tidy: a
 * turn that read the archive twice and a turn that read it once are different
 * turns, and a list that deduplicated silently would show them the same.
 */
export function summarize(calls: readonly { name: string }[]): string | null {
  if (!calls.length) return null;
  const counts = new Map<string, number>();
  for (const call of calls) {
    const name = displayName(call.name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const named = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  return `${calls.length} tool call${calls.length === 1 ? "" : "s"} · ${named.join(", ")}`;
}
