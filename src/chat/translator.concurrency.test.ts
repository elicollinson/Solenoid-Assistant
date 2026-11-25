// Tier 3 — Out-of-Order & Interleaving Races for AgUiToChatEventTranslator.
//
// Locks down concurrency & race invariants:
// 1. Concurrent read tools starting together (`call-1`, `call-2`, `call-3`) and
//    finishing out of order (`call-3`, `call-1`, `call-2`) pair strictly by `id`,
//    preserve exact args/duration/ok status, and match hydrated checkpoint order.
// 2. Consecutive back-to-back turns (user -> developer subagent onAutoTurn -> user,
//    plus recovery after RUN_ERROR, RUN_FINISHED(cancelled), and explicit reset())
//    leak zero `said`, `opened`, `streamingText`, `streamingReasoning`, `calls`,
//    `pending`, or `error` across turn boundaries.
// 3. Approval settlement races (duplicate `onApprovalSettled` for the same
//    `decisionId`, unknown `decisionId`, and deferred approval double-settle)
//    are strictly idempotent and never emit duplicate `settled` frames.
// 4. Streamed `TOOL_CALL_ARGS` split across arbitrary multi-chunk UTF-8 fragments
//    and interleaved across concurrent tool calls reassembles valid args before
//    `tool_start` and `tool_end`.
import { describe, expect, test } from "bun:test";
import { type AGUIEvent, EventType, type Message } from "@ag-ui/core";
import {
  APPROVAL_REASON,
  OPEN_TOOL_GROUP,
  SOLENOID_METADATA_KEY,
  applyEvent,
  type ToolResultMetadata,
} from "@elicollinson/solenoid-engine";
import type {
  ChatChoice,
  ChatEvent,
  ChatFact,
  ChatToolCall,
  SubagentStatusItem,
} from "../shared/chat";
import {
  AgUiToChatEventTranslator,
  hydrateTurnsFromThread,
  type TranslatorApprovalContext,
} from "./translator";

// ---------------------------------------------------------------------------
// Real browser reducer loader (web/src/app/chat.ts)
// ---------------------------------------------------------------------------

interface LiveTurn {
  turnId?: string;
  source?: "text" | "subagent";
  asked: string;
  said: string[];
  streamingText?: string;
  streamingReasoning?: string;
  calls: ChatToolCall[];
  opened: string[];
  pending: Extract<ChatEvent, { type: "approval" }> | null;
  deferredApprovals?: Array<Extract<ChatEvent, { type: "deferred_approval" }>>;
  activeSubagents?: SubagentStatusItem[];
  error: string | null;
}

interface WebChatModule {
  apply: (turn: LiveTurn, event: ChatEvent) => LiveTurn;
  EMPTY_LIVE_TURN: LiveTurn;
}

const WEB_CHAT_MODULE_URL = new URL("../../web/src/app/chat.ts", import.meta.url).href;
const webChat = (await import(WEB_CHAT_MODULE_URL)) as WebChatModule;
const { apply, EMPTY_LIVE_TURN } = webChat;

function freshLiveTurn(overrides: Partial<LiveTurn> = {}): LiveTurn {
  return {
    ...EMPTY_LIVE_TURN,
    said: [],
    calls: [],
    opened: [],
    deferredApprovals: [],
    activeSubagents: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Deterministic Event Helpers
// ---------------------------------------------------------------------------

const THREAD_ID = "thread-conc-1";
const FIXED_NOW = new Date("2026-11-24T17:00:00.000Z");

const runStarted = (runId: string): AGUIEvent => ({
  type: EventType.RUN_STARTED,
  threadId: THREAD_ID,
  runId,
});

const runFinishedSuccess = (runId: string): AGUIEvent => ({
  type: EventType.RUN_FINISHED,
  threadId: THREAD_ID,
  runId,
  outcome: { type: "success" },
});

const runFinishedCancelled = (runId: string): AGUIEvent => ({
  type: EventType.RUN_FINISHED,
  threadId: THREAD_ID,
  runId,
  outcome: { type: "cancelled" },
});

const runFinishedInterrupt = (
  runId: string,
  interruptId: string,
  toolCallId: string,
): AGUIEvent => ({
  type: EventType.RUN_FINISHED,
  threadId: THREAD_ID,
  runId,
  outcome: {
    type: "interrupt",
    interrupts: [
      {
        id: interruptId,
        reason: APPROVAL_REASON,
        message: "Allow write?",
        toolCallId,
        responseSchema: {
          type: "object",
          properties: { approved: { type: "boolean" } },
          required: ["approved"],
        },
      },
    ],
  },
});

const openingSeq = (
  messageId: string,
  role: "user" | "developer",
  text: string,
): AGUIEvent[] => [
  { type: EventType.TEXT_MESSAGE_START, messageId, role },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text },
  { type: EventType.TEXT_MESSAGE_END, messageId },
];

const toolStartSeq = (
  toolCallId: string,
  toolCallName: string,
  parentMessageId: string,
  args: Record<string, unknown>,
): AGUIEvent[] => [
  { type: EventType.TOOL_CALL_START, toolCallId, toolCallName, parentMessageId },
  { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args) },
  { type: EventType.TOOL_CALL_END, toolCallId },
];

const toolResult = (
  toolCallId: string,
  content: string,
  outcome: ToolResultMetadata,
): AGUIEvent => ({
  type: EventType.TOOL_CALL_RESULT,
  messageId: `${toolCallId}:result`,
  toolCallId,
  content,
  role: "tool",
  metadata: { [SOLENOID_METADATA_KEY]: outcome },
});

// ---------------------------------------------------------------------------
// 1. Out-of-Order Parallel Tool Completion
// ---------------------------------------------------------------------------

describe("Tier 3 — Out-of-order concurrent tool calls", () => {
  test("3 concurrent read tools starting together (call-1, call-2, call-3) and finishing out of order (call-3, call-1, call-2)", () => {
    const translator = new AgUiToChatEventTranslator({
      resolveToolKind: () => "read",
    });
    let thread: Message[] = [];
    const emitted: ChatEvent[] = [];
    let live: LiveTurn | null = null;

    const feed = (event: AGUIEvent): ChatEvent[] => {
      thread = applyEvent(thread, event);
      const out = translator.push(event);
      for (const ev of out) {
        emitted.push(ev);
        if (ev.type === "turn_start") {
          live = freshLiveTurn({ turnId: ev.turnId, asked: ev.asked, source: ev.source });
        } else if (ev.type !== "message") {
          live = apply(live ?? freshLiveTurn(), ev);
        }
      }
      return out;
    };

    feed(runStarted("run-ooo-1"));
    for (const ev of openingSeq("u-ooo", "user", "Check contacts, calendar, and messages.")) {
      feed(ev);
    }
    feed({ type: EventType.STEP_STARTED, stepName: "turn 1" });
    feed({ type: EventType.STEP_FINISHED, stepName: "turn 1" });

    // All 3 concurrent read tools start BEFORE any result arrives.
    for (const ev of toolStartSeq("call-1", "okf_read", "a-ooo-1", { id: "okf:contact/ferris" })) {
      feed(ev);
    }
    for (const ev of toolStartSeq("call-2", "calendar_list", "a-ooo-1", { query: "Thursday" })) {
      feed(ev);
    }
    for (const ev of toolStartSeq("call-3", "imessage_list_conversations", "a-ooo-1", {
      query: "unread",
    })) {
      feed(ev);
    }

    // All 3 are currently running in start order inside snapshot AND client live state.
    const snapAllRunning = translator.snapshot();
    expect(snapAllRunning?.calls.map((c) => ({ id: c.id, name: c.name, status: c.status }))).toEqual([
      { id: "call-1", name: "okf.read", status: "running" },
      { id: "call-2", name: "calendar.list", status: "running" },
      { id: "call-3", name: "imessage.list_conversations", status: "running" },
    ]);

    // Finish strictly out of order: call-3 (ok, 90ms) -> call-1 (error, 240ms) -> call-2 (ok, 1250ms).
    const end3 = feed(toolResult("call-3", '["thread-a"]', { durationMs: 90 }));
    expect(end3).toContainEqual({
      type: "tool_end",
      id: "call-3",
      name: "imessage.list_conversations",
      kind: "read",
      arg: "unread",
      duration: "90ms",
      ok: true,
    });

    // Mid-way check: call-3 is completed while call-1 and call-2 are still running in place.
    expect(translator.snapshot()?.calls.map((c) => ({ id: c.id, status: c.status }))).toEqual([
      { id: "call-1", status: "running" },
      { id: "call-2", status: "running" },
      { id: "call-3", status: "completed" },
    ]);

    const end1 = feed(
      toolResult("call-1", "Error: contact not found", {
        durationMs: 240,
        error: "contact not found",
      }),
    );
    expect(end1).toContainEqual({
      type: "tool_end",
      id: "call-1",
      name: "okf.read",
      kind: "read",
      arg: "okf:contact/ferris",
      duration: "240ms",
      ok: false,
    });

    const end2 = feed(toolResult("call-2", '["event-1"]', { durationMs: 1250 }));
    expect(end2).toContainEqual({
      type: "tool_end",
      id: "call-2",
      name: "calendar.list",
      kind: "read",
      arg: "Thursday",
      duration: "1.3s",
      ok: true,
    });

    // Complete step 2 prose + run finish.
    feed({ type: EventType.STEP_STARTED, stepName: "turn 2" });
    feed({ type: EventType.TEXT_MESSAGE_START, messageId: "a-ooo-2", role: "assistant" });
    feed({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "a-ooo-2",
      delta: "Checked all three sources.",
    });
    feed({ type: EventType.TEXT_MESSAGE_END, messageId: "a-ooo-2" });
    feed({ type: EventType.STEP_FINISHED, stepName: "turn 2" });
    feed(runFinishedSuccess("run-ooo-1"));

    // Verify every tool_start paired 1:1 with tool_end by id.
    const starts = emitted.filter(
      (e): e is Extract<ChatEvent, { type: "tool_start" }> => e.type === "tool_start",
    );
    const ends = emitted.filter(
      (e): e is Extract<ChatEvent, { type: "tool_end" }> => e.type === "tool_end",
    );
    expect(starts.map((s) => s.id)).toEqual(["call-1", "call-2", "call-3"]);
    expect(ends.map((e) => e.id)).toEqual(["call-3", "call-1", "call-2"]);

    // Verify client `apply()` updated calls in place in exact start order (no duplicates or swaps).
    const expectedCalls: Array<{
      name: string;
      arg: string | null;
      kind: "read" | "write";
      ok: boolean;
      duration: string;
    }> = [
      { name: "okf.read", arg: "okf:contact/ferris", kind: "read", ok: false, duration: "240ms" },
      { name: "calendar.list", arg: "Thursday", kind: "read", ok: true, duration: "1.3s" },
      {
        name: "imessage.list_conversations",
        arg: "unread",
        kind: "read",
        ok: true,
        duration: "90ms",
      },
    ];
    expect(
      (live as LiveTurn | null)?.calls.map((c) => ({
        name: c.name,
        arg: c.arg,
        kind: c.kind,
        ok: c.ok,
        duration: c.duration,
      })),
    ).toEqual(expectedCalls);

    // Verify exact match with checkpoint hydration order.
    const hydrated = hydrateTurnsFromThread(thread, {
      now: FIXED_NOW,
      resolveToolKind: () => "read",
    });
    expect(hydrated).toHaveLength(2);
    expect(
      hydrated[1]?.calls.map((c) => ({
        name: c.name,
        arg: c.arg,
        kind: c.kind,
        ok: c.ok,
        duration: c.duration,
      })),
    ).toEqual(expectedCalls);
    expect(hydrated[1]?.toolSummary).toBe(
      "3 tool calls · okf.read, calendar.list, imessage.list_conversations",
    );
  });

  test("concurrent open_tool_group + read tool finishing out of order still excludes open_tool_group from calls", () => {
    const translator = new AgUiToChatEventTranslator();
    let thread: Message[] = [];
    const emitted: ChatEvent[] = [];

    const feed = (event: AGUIEvent) => {
      thread = applyEvent(thread, event);
      emitted.push(...translator.push(event));
    };

    feed(runStarted("run-ooo-open"));
    for (const ev of openingSeq("u-oo", "user", "Open calendar and read contact.")) feed(ev);
    feed({ type: EventType.STEP_STARTED, stepName: "turn 1" });
    feed({ type: EventType.STEP_FINISHED, stepName: "turn 1" });
    for (const ev of toolStartSeq("tc-open", OPEN_TOOL_GROUP, "a-oo-1", { group: "calendar" })) {
      feed(ev);
    }
    for (const ev of toolStartSeq("tc-read", "okf_read", "a-oo-1", { id: "okf:contact/ada" })) {
      feed(ev);
    }
    // Read finishes BEFORE open_tool_group finishes.
    feed(toolResult("tc-read", "Ada", { durationMs: 55 }));
    feed(toolResult("tc-open", "Briefing: calendar", { durationMs: 80 }));
    feed({ type: EventType.STEP_STARTED, stepName: "turn 2" });
    feed({ type: EventType.TEXT_MESSAGE_START, messageId: "a-oo-2", role: "assistant" });
    feed({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a-oo-2", delta: "Done." });
    feed({ type: EventType.TEXT_MESSAGE_END, messageId: "a-oo-2" });
    feed({ type: EventType.STEP_FINISHED, stepName: "turn 2" });
    feed(runFinishedSuccess("run-ooo-open"));

    const msg = emitted.find(
      (e): e is Extract<ChatEvent, { type: "message" }> => e.type === "message",
    );
    expect(msg).toMatchObject({
      note: "opened calendar",
      toolSummary: "1 tool call · okf.read",
    });

    const hydrated = hydrateTurnsFromThread(thread, { now: FIXED_NOW });
    expect(hydrated[1]?.note).toBe("opened calendar");
    expect(hydrated[1]?.toolSummary).toBe("1 tool call · okf.read");
    expect(hydrated[1]?.calls).toHaveLength(1);
    expect(hydrated[1]?.calls[0]?.name).toBe("okf.read");
  });
});

// ---------------------------------------------------------------------------
// 2. Back-to-Back Turns on Same Translator Instance (Zero State Leakage)
// ---------------------------------------------------------------------------

describe("Tier 3 — Consecutive back-to-back turns & state isolation", () => {
  test("user turn -> developer subagent onAutoTurn -> user turn leaks zero said, opened, streamingText, or calls", () => {
    const translator = new AgUiToChatEventTranslator();

    const run = (events: AGUIEvent[]): ChatEvent[] => {
      const out: ChatEvent[] = [];
      for (const ev of events) out.push(...translator.push(ev));
      return out;
    };

    // Turn 1: user turn with opened group, reasoning, intermediate `say`, 2 tools, prose.
    const turn1 = run([
      runStarted("t1"),
      ...openingSeq("u-1", "user", "Check my reminders."),
      { type: EventType.STEP_STARTED, stepName: "turn 1" },
      { type: EventType.REASONING_START, messageId: "r-1" },
      { type: EventType.REASONING_MESSAGE_START, messageId: "r-1", role: "reasoning" },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r-1", delta: "Turn 1 thought" },
      { type: EventType.REASONING_MESSAGE_END, messageId: "r-1" },
      { type: EventType.REASONING_END, messageId: "r-1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "a-1-pre", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a-1-pre", delta: "Checking reminders." },
      { type: EventType.TEXT_MESSAGE_END, messageId: "a-1-pre" },
      { type: EventType.STEP_FINISHED, stepName: "turn 1" },
      ...toolStartSeq("tc-1-open", OPEN_TOOL_GROUP, "a-1-pre", { group: "reminders" }),
      ...toolStartSeq("tc-1-list", "reminders_list", "a-1-pre", { query: "all" }),
      toolResult("tc-1-open", "Briefing: reminders", { durationMs: 2 }),
      toolResult("tc-1-list", "[]", { durationMs: 45 }),
      { type: EventType.STEP_STARTED, stepName: "turn 2" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "a-1-fin", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a-1-fin", delta: "No reminders due." },
      { type: EventType.TEXT_MESSAGE_END, messageId: "a-1-fin" },
      { type: EventType.STEP_FINISHED, stepName: "turn 2" },
      runFinishedSuccess("t1"),
    ]);

    expect(translator.snapshot()).toBeNull();
    expect(turn1.find((e) => e.type === "message")).toMatchObject({
      body: "No reminders due.",
      note: "opened reminders",
      toolSummary: "1 tool call · reminders.list",
    });

    // Turn 2: immediate developer subagent auto-turn on SAME translator.
    const turn2Opening = run([
      runStarted("t2-auto"),
      ...openingSeq("dev-2", "developer", "Subagents finished: researcher (sa-1) done."),
    ]);
    expect(turn2Opening.find((e) => e.type === "turn_start")).toMatchObject({
      type: "turn_start",
      source: "subagent",
    });

    const snapDuringTurn2 = translator.snapshot();
    expect(snapDuringTurn2).not.toBeNull();
    expect(snapDuringTurn2!.source).toBe("subagent");
    expect(snapDuringTurn2!.said).toEqual([]);
    expect(snapDuringTurn2!.opened).toEqual([]);
    expect(snapDuringTurn2!.calls).toEqual([]);
    expect(snapDuringTurn2!.streamingText).toBe("");
    expect(snapDuringTurn2!.streamingReasoning).toBe("");
    expect(snapDuringTurn2!.pending).toBeNull();
    expect(snapDuringTurn2!.error).toBeNull();

    const turn2Rest = run([
      { type: EventType.STEP_STARTED, stepName: "turn 1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "a-2", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a-2", delta: "Researcher finished." },
      { type: EventType.TEXT_MESSAGE_END, messageId: "a-2" },
      { type: EventType.STEP_FINISHED, stepName: "turn 1" },
      runFinishedSuccess("t2-auto"),
    ]);

    expect(translator.snapshot()).toBeNull();
    expect(turn2Rest.find((e) => e.type === "message")).toMatchObject({
      messageId: "a-2",
      body: "Researcher finished.",
      note: null,
      toolSummary: null,
      source: "subagent",
    });

    // Turn 3: immediate third user turn with different group & tool.
    const turn3 = run([
      runStarted("t3"),
      ...openingSeq("u-3", "user", "What is on my calendar?"),
      { type: EventType.STEP_STARTED, stepName: "turn 1" },
      { type: EventType.STEP_FINISHED, stepName: "turn 1" },
      ...toolStartSeq("tc-3-open", OPEN_TOOL_GROUP, "a-3-1", { group: "calendar" }),
      ...toolStartSeq("tc-3-cal", "calendar_list", "a-3-1", { query: "tomorrow" }),
      toolResult("tc-3-open", "Briefing: calendar", { durationMs: 3 }),
      toolResult("tc-3-cal", "[]", { durationMs: 70 }),
      { type: EventType.STEP_STARTED, stepName: "turn 2" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "a-3-2", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a-3-2", delta: "Tomorrow is open." },
      { type: EventType.TEXT_MESSAGE_END, messageId: "a-3-2" },
      { type: EventType.STEP_FINISHED, stepName: "turn 2" },
      runFinishedSuccess("t3"),
    ]);

    expect(translator.snapshot()).toBeNull();
    expect(turn3.find((e) => e.type === "message")).toMatchObject({
      messageId: "a-3-2",
      body: "Tomorrow is open.",
      note: "opened calendar",
      toolSummary: "1 tool call · calendar.list",
    });
  });

  test("turn after RUN_ERROR, after RUN_FINISHED(cancelled), and after explicit reset() starts completely clean", () => {
    const translator = new AgUiToChatEventTranslator();

    // Failed turn via RUN_ERROR.
    for (const ev of [
      runStarted("err-1"),
      ...openingSeq("u-err", "user", "Broken request"),
      { type: EventType.STEP_STARTED, stepName: "turn 1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "a-err", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a-err", delta: "Partial before crash" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "a-err" },
      { type: EventType.STEP_FINISHED, stepName: "turn 1" },
      { type: EventType.RUN_ERROR, message: "Upstream 500" },
    ] satisfies AGUIEvent[]) {
      translator.push(ev);
    }

    // Subsequent healthy turn must carry zero error or partial text from failed turn.
    const healthyEvents: ChatEvent[] = [];
    for (const ev of [
      runStarted("ok-2"),
      ...openingSeq("u-ok", "user", "Try again"),
    ] satisfies AGUIEvent[]) {
      healthyEvents.push(...translator.push(ev));
    }
    const snap = translator.snapshot();
    expect(snap).not.toBeNull();
    expect(snap!.error).toBeNull();
    expect(snap!.streamingText).toBe("");
    expect(snap!.calls).toEqual([]);
    expect(snap!.opened).toEqual([]);

    // Cancel turn 2 mid-flight.
    translator.push(runFinishedCancelled("ok-2"));
    expect(translator.snapshot()).toBeNull();

    // Explicit reset() mid-turn clears all state.
    for (const ev of [
      runStarted("mid-3"),
      ...openingSeq("u-mid", "user", "Will be reset"),
      { type: EventType.STEP_STARTED, stepName: "turn 1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "a-mid", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a-mid", delta: "Halfway..." },
    ] satisfies AGUIEvent[]) {
      translator.push(ev);
    }
    expect(translator.snapshot()).not.toBeNull();
    translator.reset();
    expect(translator.snapshot()).toBeNull();

    // Turn 4 after reset() completes cleanly.
    const afterReset: ChatEvent[] = [];
    for (const ev of [
      runStarted("ok-4"),
      ...openingSeq("u-4", "user", "Fresh start"),
      { type: EventType.STEP_STARTED, stepName: "turn 1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "a-4", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a-4", delta: "All fresh." },
      { type: EventType.TEXT_MESSAGE_END, messageId: "a-4" },
      { type: EventType.STEP_FINISHED, stepName: "turn 1" },
      runFinishedSuccess("ok-4"),
    ] satisfies AGUIEvent[]) {
      afterReset.push(...translator.push(ev));
    }
    expect(afterReset.find((e) => e.type === "message")).toMatchObject({
      body: "All fresh.",
      note: null,
      toolSummary: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Approval Settlement Races & Idempotency
// ---------------------------------------------------------------------------

describe("Tier 3 — Approval settlement idempotency & race safety", () => {
  const choices: ChatChoice[] = [
    { id: "c-yes", label: "Go ahead", stance: "affirm" },
    { id: "c-no", label: "Not this one", stance: "quiet" },
  ];
  const facts: ChatFact[] = [["Call", "reminders.create"]];
  const approvalCtx: TranslatorApprovalContext = {
    decisionId: "dec-race-1",
    ref: "ap/1124-77",
    title: "Create a reminder?",
    why: "Create reminder",
    hold: "Nothing written yet.",
    tool: "reminders.create",
    facts,
    actions: choices,
  };

  test("duplicate onApprovalSettled for same decisionId (click vs expiry race) emits settled exactly once", () => {
    const translator = new AgUiToChatEventTranslator({
      resolveToolKind: (name) => (name === "reminders_create" ? "write" : "read"),
      resolveApproval: () => approvalCtx,
    });

    for (const ev of [
      runStarted("run-race-1"),
      ...openingSeq("u-race", "user", "Add a reminder"),
      { type: EventType.STEP_STARTED, stepName: "turn 1" },
      { type: EventType.STEP_FINISHED, stepName: "turn 1" },
      ...toolStartSeq("tc-race", "reminders_create", "a-race", { title: "Milk" }),
      runFinishedInterrupt("run-race-1", "approval:tc-race", "tc-race"),
    ] satisfies AGUIEvent[]) {
      translator.push(ev);
    }

    expect(translator.snapshot()?.pending?.decisionId).toBe("dec-race-1");

    // First settlement wins (user click arrives).
    const first = translator.onApprovalSettled("dec-race-1", "approved");
    expect(first).toEqual([
      { type: "settled", decisionId: "dec-race-1", outcome: "approved" },
    ]);
    expect(translator.snapshot()?.pending).toBeNull();

    // Concurrent expiry tick OR duplicate tab click for the exact same decisionId is a strict no-op!
    const racingExpiry = translator.onApprovalSettled("dec-race-1", "expired");
    expect(racingExpiry).toEqual([]);

    const duplicateApprove = translator.onApprovalSettled("dec-race-1", "approved");
    expect(duplicateApprove).toEqual([]);

    expect(translator.snapshot()?.pending).toBeNull();
  });

  test("onApprovalSettled for unknown decisionId is a no-op and never clears an unrelated pending approval", () => {
    const translator = new AgUiToChatEventTranslator({
      resolveToolKind: () => "write",
      resolveApproval: () => approvalCtx,
    });

    for (const ev of [
      runStarted("run-unk-1"),
      ...openingSeq("u-unk", "user", "Add a reminder"),
      { type: EventType.STEP_STARTED, stepName: "turn 1" },
      { type: EventType.STEP_FINISHED, stepName: "turn 1" },
      ...toolStartSeq("tc-unk", "reminders_create", "a-unk", { title: "Eggs" }),
      runFinishedInterrupt("run-unk-1", "approval:tc-unk", "tc-unk"),
    ] satisfies AGUIEvent[]) {
      translator.push(ev);
    }

    expect(translator.snapshot()?.pending?.decisionId).toBe("dec-race-1");
    expect(translator.onApprovalSettled("dec-never-existed", "declined")).toEqual([]);
    // Unrelated open approval MUST remain intact!
    expect(translator.snapshot()?.pending?.decisionId).toBe("dec-race-1");
  });

  test("duplicate onApprovalSettled for a deferred subagent approval emits settled once", () => {
    const translator = new AgUiToChatEventTranslator();
    for (const ev of [
      runStarted("run-def-race"),
      ...openingSeq("u-dr", "user", "Keep working"),
    ] satisfies AGUIEvent[]) {
      translator.push(ev);
    }

    const deferredEvent: Extract<ChatEvent, { type: "deferred_approval" }> = {
      type: "deferred_approval",
      decisionId: "dec-def-race",
      ref: "ap/1124-88",
      title: "Subagent wants to add a calendar hold.",
      why: "Add hold",
      hold: "Nothing written yet.",
      tool: "calendar.create",
      subagentName: "planner",
      facts: [["Call", "calendar.create"]],
      actions: choices,
    };

    expect(translator.onDeferredApproval(deferredEvent)).toEqual([deferredEvent]);
    expect(translator.snapshot()?.pending).toBeNull();
    expect(translator.snapshot()?.deferredApprovals).toEqual([deferredEvent]);

    expect(translator.onApprovalSettled("dec-def-race", "approved")).toEqual([
      { type: "settled", decisionId: "dec-def-race", outcome: "approved" },
    ]);
    // Second settlement for same deferred decisionId is idempotent (no duplicate frame).
    expect(translator.onApprovalSettled("dec-def-race", "approved")).toEqual([]);
    expect(translator.onApprovalSettled("dec-def-race", "expired")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Multi-Chunk UTF-8 & Interleaved TOOL_CALL_ARGS Reassembly
// ---------------------------------------------------------------------------

describe("Tier 3 — Multi-chunk UTF-8 TOOL_CALL_ARGS reassembly", () => {
  test("reassembles arbitrary multi-chunk UTF-8 and interleaved TOOL_CALL_ARGS before emitting tool_start / tool_end", () => {
    const translator = new AgUiToChatEventTranslator({
      resolveToolKind: () => "read",
    });
    let thread: Message[] = [];
    const emitted: ChatEvent[] = [];

    const feed = (event: AGUIEvent): ChatEvent[] => {
      thread = applyEvent(thread, event);
      const out = translator.push(event);
      emitted.push(...out);
      return out;
    };

    feed(runStarted("run-utf8"));
    for (const ev of openingSeq("u-utf8", "user", "Search café notes and open reminders.")) {
      feed(ev);
    }
    feed({ type: EventType.STEP_STARTED, stepName: "turn 1" });
    feed({ type: EventType.STEP_FINISHED, stepName: "turn 1" });

    // Interleave TOOL_CALL_START and tiny multi-chunk UTF-8 fragments across 3 tools (including open_tool_group)!
    const titleA = "Café résumé — 日本語 🚀";
    const jsonA = JSON.stringify({ title: titleA, note: 'quoted "value"\nline2' });
    const jsonB = JSON.stringify({ query: "Naïve façade — über" });
    const jsonOpen = JSON.stringify({ group: "reminders" });

    // Split into arbitrary ragged chunks (1..4 UTF-16 code units, splitting mid-key, mid-escape, and mid-emoji!).
    const splitRagged = (s: string): string[] => {
      const chunks: string[] = [];
      const sizes = [1, 2, 1, 3, 2, 4, 1, 2];
      let pos = 0;
      let step = 0;
      while (pos < s.length) {
        const size = sizes[step % sizes.length]!;
        chunks.push(s.slice(pos, pos + size));
        pos += size;
        step++;
      }
      return chunks;
    };

    const chunksA = splitRagged(jsonA);
    const chunksB = splitRagged(jsonB);
    const chunksOpen = splitRagged(jsonOpen);

    // Start all 3 calls before delivering chunks.
    expect(
      feed({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-a",
        toolCallName: "okf_read",
        parentMessageId: "a-utf8-1",
      }),
    ).toEqual([]);
    expect(
      feed({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-b",
        toolCallName: "mail_search",
        parentMessageId: "a-utf8-1",
      }),
    ).toEqual([]);
    expect(
      feed({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-open-chunked",
        toolCallName: OPEN_TOOL_GROUP,
        parentMessageId: "a-utf8-1",
      }),
    ).toEqual([]);

    // Interleave all arg chunks round-robin: zero premature tool_start frames before TOOL_CALL_END!
    const maxLen = Math.max(chunksA.length, chunksB.length, chunksOpen.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < chunksA.length) {
        expect(
          feed({ type: EventType.TOOL_CALL_ARGS, toolCallId: "tc-a", delta: chunksA[i]! }),
        ).toEqual([]);
      }
      if (i < chunksB.length) {
        expect(
          feed({ type: EventType.TOOL_CALL_ARGS, toolCallId: "tc-b", delta: chunksB[i]! }),
        ).toEqual([]);
      }
      if (i < chunksOpen.length) {
        expect(
          feed({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: "tc-open-chunked",
            delta: chunksOpen[i]!,
          }),
        ).toEqual([]);
      }
    }

    // End calls after interleaved UTF-8 chunks -> each emits with fully reassembled UTF-8 args!
    const startA = feed({ type: EventType.TOOL_CALL_END, toolCallId: "tc-a" });
    expect(startA).toContainEqual({
      type: "tool_start",
      id: "tc-a",
      name: "okf.read",
      kind: "read",
      arg: titleA,
    });

    const startB = feed({ type: EventType.TOOL_CALL_END, toolCallId: "tc-b" });
    expect(startB).toContainEqual({
      type: "tool_start",
      id: "tc-b",
      name: "mail.search",
      kind: "read",
      arg: "Naïve façade — über",
    });

    feed({ type: EventType.TOOL_CALL_END, toolCallId: "tc-open-chunked" });

    // Deliver results out of order & finish turn.
    const endB = feed(toolResult("tc-b", "ok", { durationMs: 40 }));
    expect(endB).toContainEqual({
      type: "tool_end",
      id: "tc-b",
      name: "mail.search",
      kind: "read",
      arg: "Naïve façade — über",
      duration: "40ms",
      ok: true,
    });
    const endA = feed(toolResult("tc-a", "ok", { durationMs: 30 }));
    expect(endA).toContainEqual({
      type: "tool_end",
      id: "tc-a",
      name: "okf.read",
      kind: "read",
      arg: titleA,
      duration: "30ms",
      ok: true,
    });
    feed(toolResult("tc-open-chunked", "Briefing: reminders", { durationMs: 2 }));

    feed({ type: EventType.STEP_STARTED, stepName: "turn 2" });
    feed({ type: EventType.TEXT_MESSAGE_START, messageId: "a-utf8-2", role: "assistant" });
    feed({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a-utf8-2", delta: "Found them." });
    feed({ type: EventType.TEXT_MESSAGE_END, messageId: "a-utf8-2" });
    feed({ type: EventType.STEP_FINISHED, stepName: "turn 2" });
    feed(runFinishedSuccess("run-utf8"));

    expect(emitted.some((e) => e.type === "opened" && e.group === "reminders")).toBe(true);
    expect(emitted.find((e) => e.type === "message")).toMatchObject({
      body: "Found them.",
      note: "opened reminders",
      toolSummary: "2 tool calls · okf.read, mail.search",
    });

    // Checkpoint hydration reassembles the exact same UTF-8 args and note!
    const hydrated = hydrateTurnsFromThread(thread, { now: FIXED_NOW });
    expect(hydrated[1]?.note).toBe("opened reminders");
    expect(hydrated[1]?.calls.map((c) => ({ name: c.name, arg: c.arg }))).toEqual([
      { name: "okf.read", arg: titleA },
      { name: "mail.search", arg: "Naïve façade — über" },
    ]);
  });
});
