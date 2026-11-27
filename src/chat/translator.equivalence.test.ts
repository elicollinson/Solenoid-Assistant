// Tier 1 — Golden Replay & Checkpoint Equivalence for AgUiToChatEventTranslator.
//
// Proves two core contracts:
// 1. Compile-time + runtime exhaustiveness across every `@ag-ui/core` EventType
//    and every `solenoid-engine` CUSTOM_EVENTS discriminator.
// 2. Exact field-for-field equivalence between:
//      (a) live SSE translation (`AgUiToChatEventTranslator` -> `web/src/app/chat.ts` `apply()`), and
//      (b) checkpoint hydration (`solenoid-engine` `applyEvent()` -> `hydrateTurnsFromThread()`),
//    across all 9 golden scenarios.
import { describe, expect, test } from "bun:test";
import { type AGUIEvent, EventType, type Message } from "@ag-ui/core";
import {
  APPROVAL_REASON,
  CUSTOM_EVENTS,
  OPEN_SKILL,
  OPEN_TOOL_GROUP,
  SOLENOID_METADATA_KEY,
  applyEvent,
  type CustomEventName,
  type ToolResultMetadata,
} from "@elicollinson/solenoid-engine";
import type {
  ApprovalOutcome,
  ChatApproval,
  ChatChoice,
  ChatEvent,
  ChatFact,
  ChatToolCall,
  ChatTurnRow,
  SubagentStatusItem,
} from "../shared/chat";
import {
  AgUiToChatEventTranslator,
  hydrateTurnsFromThread,
  type HydrateTurnsOptions,
  type TranslatorApprovalContext,
  type TranslatorOptions,
} from "./translator";

// ---------------------------------------------------------------------------
// Real browser reducer loader (web/src/app/chat.ts)
// ---------------------------------------------------------------------------
// Loaded dynamically via a runtime URL so root Bun-only `tsconfig.json`
// (`lib: ["ESNext"]`, excluding `web/`) stays free of DOM globals from React
// hooks in `web/src/app/chat.ts`, while `bun test` executes the exact real
// `apply()` and `EMPTY_LIVE_TURN` exported by `web/src/app/chat.ts`.

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
  echoed: (chat: { stored: readonly ChatTurnRow[]; live: LiveTurn | null }) => boolean;
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
// Deterministic AG-UI 1.0 Event Builders (matching solenoid-engine TurnEncoder)
// ---------------------------------------------------------------------------

const THREAD_ID = "thread-eq-1";
const FIXED_NOW = new Date("2026-11-24T15:30:00.000Z");

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
  message: string,
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
        message,
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

const runError = (message: string, code?: string): AGUIEvent => ({
  type: EventType.RUN_ERROR,
  message,
  ...(code ? { code } : {}),
});

const textStart = (messageId: string, role: "user" | "assistant" | "developer"): AGUIEvent => ({
  type: EventType.TEXT_MESSAGE_START,
  messageId,
  role,
});

const textDelta = (messageId: string, delta: string): AGUIEvent => ({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId,
  delta,
});

const textEnd = (messageId: string): AGUIEvent => ({
  type: EventType.TEXT_MESSAGE_END,
  messageId,
});

const stepStarted = (stepName: string): AGUIEvent => ({
  type: EventType.STEP_STARTED,
  stepName,
});

const stepFinished = (stepName: string): AGUIEvent => ({
  type: EventType.STEP_FINISHED,
  stepName,
});

const reasoningEvents = (messageId: string, chunks: readonly string[]): AGUIEvent[] => [
  { type: EventType.REASONING_START, messageId },
  { type: EventType.REASONING_MESSAGE_START, messageId, role: "reasoning" },
  ...chunks.map(
    (delta): AGUIEvent => ({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId,
      delta,
    }),
  ),
  { type: EventType.REASONING_MESSAGE_END, messageId },
  { type: EventType.REASONING_END, messageId },
];

const openingMessage = (
  messageId: string,
  role: "user" | "developer",
  text: string,
): AGUIEvent[] => [textStart(messageId, role), textDelta(messageId, text), textEnd(messageId)];

const toolCallStartSeq = (
  toolCallId: string,
  toolCallName: string,
  parentMessageId: string,
  args: unknown,
): AGUIEvent[] => [
  {
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName,
    parentMessageId,
  },
  {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId,
    delta: typeof args === "string" ? args : JSON.stringify(args),
  },
  {
    type: EventType.TOOL_CALL_END,
    toolCallId,
  },
];

const toolCallResult = (
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

const customRetry = (error: string, delayMs: number): AGUIEvent => ({
  type: EventType.CUSTOM,
  name: CUSTOM_EVENTS.retry,
  value: { error, delayMs },
});

const customRouteAdvanced = (
  from: { provider: string; model: string },
  to: { provider: string; model: string },
  error: string,
): AGUIEvent => ({
  type: EventType.CUSTOM,
  name: CUSTOM_EVENTS.routeAdvanced,
  value: { from, to, error },
});

// ---------------------------------------------------------------------------
// Simultaneous Golden Replay Harness
// ---------------------------------------------------------------------------

type TimelineStep =
  | { kind: "agui"; event: AGUIEvent }
  | { kind: "settle"; decisionId: string; outcome: ApprovalOutcome }
  | { kind: "deferred"; event: Extract<ChatEvent, { type: "deferred_approval" }> }
  /** Captures a snapshot of the live thread length at this exact point for rollback fixtures. */
  | { kind: "mark"; label: string }
  /** Emits a genuine `MESSAGES_SNAPSHOT` slicing the accumulated thread to a prior mark. */
  | { kind: "snapshot_to"; label: string };

interface NormalizedCall {
  name: string;
  arg: string | null;
  kind: "read" | "write";
  ok: boolean;
  duration: string;
}

interface NormalizedApproval {
  decisionId: string;
  ref: string;
  title: string;
  why: string | null;
  hold: string | null;
  facts: Array<[string, string]>;
  choices: ChatChoice[];
  state: ChatApproval["state"];
  deferred?: boolean;
  subagentName?: string | null;
}

interface NormalizedTurn {
  by: "user" | "agent";
  body: string;
  source: "text" | "voice" | "subagent";
  note: string | null;
  toolSummary: string | null;
  calls: NormalizedCall[];
  approval: NormalizedApproval | null;
  deferredApprovals: NormalizedApproval[];
}

function outcomeToApprovalState(outcome: ApprovalOutcome | null): ChatApproval["state"] {
  if (outcome === "approved") return "resolved";
  if (outcome === "declined") return "dismissed";
  if (outcome === "expired") return "expired";
  return "open";
}

function normalizeApproval(a: ChatApproval): NormalizedApproval {
  return {
    decisionId: a.decisionId,
    ref: a.ref,
    title: a.title,
    why: a.why,
    hold: a.hold,
    facts: a.facts.map(([k, v]) => [k, v]),
    choices: a.choices.map((c) => ({ id: c.id, label: c.label, stance: c.stance })),
    state: a.state,
    ...(a.deferred ? { deferred: true } : {}),
    ...(a.subagentName !== undefined ? { subagentName: a.subagentName } : {}),
  };
}

function normalizeHydratedTurn(row: ChatTurnRow): NormalizedTurn {
  return {
    by: row.by,
    body: row.body,
    source: row.source ?? "text",
    note: row.note,
    toolSummary: row.toolSummary,
    calls: row.calls.map((c) => ({
      name: c.name,
      arg: c.arg,
      kind: c.kind,
      ok: c.ok,
      duration: c.duration,
    })),
    approval: row.approval ? normalizeApproval(row.approval) : null,
    deferredApprovals: (row.deferredApprovals ?? []).map(normalizeApproval),
  };
}

interface ReplayResult {
  emitted: ChatEvent[];
  liveTurns: NormalizedTurn[];
  hydratedTurns: NormalizedTurn[];
  finalLive: LiveTurn | null;
  finalSnapshot: ReturnType<AgUiToChatEventTranslator["snapshot"]>;
  thread: Message[];
  observedLiveStates: Array<{ event: ChatEvent; live: LiveTurn | null }>;
}

function replayAndCompare(
  steps: readonly TimelineStep[],
  options: {
    translator?: TranslatorOptions;
    hydrate?: HydrateTurnsOptions;
  } = {},
): ReplayResult {
  const translator = new AgUiToChatEventTranslator(options.translator);
  let thread: Message[] = [];
  const marks = new Map<string, number>();

  const emitted: ChatEvent[] = [];
  const observedLiveStates: Array<{ event: ChatEvent; live: LiveTurn | null }> = [];
  const liveTurns: NormalizedTurn[] = [];
  let live: LiveTurn | null = null;
  let turnApproval: {
    event: Extract<ChatEvent, { type: "approval" }>;
    outcome: ApprovalOutcome | null;
  } | null = null;
  let turnDeferred: Array<Extract<ChatEvent, { type: "deferred_approval" }>> = [];
  const deferredOutcomes = new Map<string, ApprovalOutcome>();

  const foldEvent = (ev: ChatEvent): void => {
    emitted.push(ev);
    if (ev.type === "turn_start") {
      live = freshLiveTurn({
        turnId: ev.turnId,
        asked: ev.asked,
        source: ev.source,
      });
      turnApproval = null;
      turnDeferred = [];
    } else if (ev.type === "snapshot") {
      live = ev.live ? freshLiveTurn({ ...ev.live }) : null;
    } else if (ev.type === "message") {
      const source = ev.source ?? live?.source ?? "text";
      if (source !== "subagent" && live && live.asked) {
        liveTurns.push({
          by: "user",
          body: live.asked,
          source: "text",
          note: null,
          toolSummary: null,
          calls: [],
          approval: null,
          deferredApprovals: [],
        });
      }
      const approvalRecord: NormalizedApproval | null = turnApproval
        ? {
            decisionId: turnApproval.event.decisionId,
            ref: turnApproval.event.ref,
            title: turnApproval.event.title,
            why: turnApproval.event.why,
            hold: turnApproval.event.hold,
            facts: turnApproval.event.facts.map(([k, v]) => [k, v]),
            choices: turnApproval.event.actions.map((c) => ({
              id: c.id,
              label: c.label,
              stance: c.stance,
            })),
            state: outcomeToApprovalState(turnApproval.outcome),
          }
        : null;
      const deferredRecords: NormalizedApproval[] = turnDeferred.map((d) => ({
        decisionId: d.decisionId,
        ref: d.ref,
        title: d.title,
        why: d.why,
        hold: d.hold,
        facts: d.facts.map(([k, v]) => [k, v]),
        choices: d.actions.map((c) => ({ id: c.id, label: c.label, stance: c.stance })),
        state: outcomeToApprovalState(deferredOutcomes.get(d.decisionId) ?? null),
        deferred: true,
        subagentName: d.subagentName,
      }));
      liveTurns.push({
        by: "agent",
        body: ev.body,
        source,
        note: ev.note,
        toolSummary: ev.toolSummary,
        calls: (live?.calls ?? []).map((c) => ({
          name: c.name,
          arg: c.arg,
          kind: c.kind,
          ok: c.ok,
          duration: c.duration,
        })),
        approval: approvalRecord,
        deferredApprovals: deferredRecords,
      });
      live = null;
      turnApproval = null;
      turnDeferred = [];
    } else if (ev.type === "cancelled") {
      if (live) live = apply(live, ev);
      live = null;
    } else {
      if (ev.type === "approval") {
        turnApproval = { event: ev, outcome: null };
      } else if (ev.type === "deferred_approval") {
        turnDeferred.push(ev);
      } else if (ev.type === "settled") {
        if (turnApproval && turnApproval.event.decisionId === ev.decisionId) {
          turnApproval.outcome = ev.outcome;
        }
        deferredOutcomes.set(ev.decisionId, ev.outcome);
      }
      live = apply(live ?? freshLiveTurn(), ev);
    }
    observedLiveStates.push({
      event: ev,
      live: live
        ? {
            ...live,
            said: [...live.said],
            calls: live.calls.map((c) => ({ ...c })),
            opened: [...live.opened],
            deferredApprovals: [...(live.deferredApprovals ?? [])],
          }
        : null,
    });
  };

  for (const step of steps) {
    if (step.kind === "mark") {
      marks.set(step.label, thread.length);
      continue;
    }
    if (step.kind === "snapshot_to") {
      const length = marks.get(step.label);
      if (length === undefined) throw new Error(`Unknown mark "${step.label}"`);
      const snapshotEvent: AGUIEvent = {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: thread.slice(0, length),
      };
      thread = applyEvent(thread, snapshotEvent);
      for (const ev of translator.push(snapshotEvent)) foldEvent(ev);
      continue;
    }
    if (step.kind === "agui") {
      thread = applyEvent(thread, step.event);
      for (const ev of translator.push(step.event)) foldEvent(ev);
    } else if (step.kind === "settle") {
      for (const ev of translator.onApprovalSettled(step.decisionId, step.outcome)) {
        foldEvent(ev);
      }
    } else if (step.kind === "deferred") {
      for (const ev of translator.onDeferredApproval(step.event)) {
        foldEvent(ev);
      }
    }
  }

  const hydratedRaw = hydrateTurnsFromThread(thread, {
    now: FIXED_NOW,
    resolveToolKind: options.translator?.resolveToolKind,
    ...options.hydrate,
  });
  const hydratedTurns = hydratedRaw.map(normalizeHydratedTurn);

  return {
    emitted,
    liveTurns,
    hydratedTurns,
    finalLive: live,
    finalSnapshot: translator.snapshot(),
    thread,
    observedLiveStates,
  };
}

// ---------------------------------------------------------------------------
// Compile-time & Runtime Exhaustiveness Checks
// ---------------------------------------------------------------------------

/** Compile-time exhaustive check across all `@ag-ui/core` EventType members. */
function classifyEventType(type: EventType): string {
  switch (type) {
    case EventType.TEXT_MESSAGE_START:
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_END:
    case EventType.TEXT_MESSAGE_CHUNK:
      return "text";
    case EventType.TOOL_CALL_START:
    case EventType.TOOL_CALL_ARGS:
    case EventType.TOOL_CALL_END:
    case EventType.TOOL_CALL_CHUNK:
    case EventType.TOOL_CALL_RESULT:
      return "tool";
    case EventType.STATE_SNAPSHOT:
    case EventType.STATE_DELTA:
    case EventType.MESSAGES_SNAPSHOT:
      return "state";
    case EventType.ACTIVITY_SNAPSHOT:
    case EventType.ACTIVITY_DELTA:
      return "activity";
    case EventType.RAW:
    case EventType.CUSTOM:
      return "extension";
    case EventType.RUN_STARTED:
    case EventType.RUN_FINISHED:
    case EventType.RUN_ERROR:
    case EventType.STEP_STARTED:
    case EventType.STEP_FINISHED:
      return "lifecycle";
    case EventType.REASONING_START:
    case EventType.REASONING_MESSAGE_START:
    case EventType.REASONING_MESSAGE_CONTENT:
    case EventType.REASONING_MESSAGE_END:
    case EventType.REASONING_MESSAGE_CHUNK:
    case EventType.REASONING_END:
    case EventType.REASONING_ENCRYPTED_VALUE:
      return "reasoning";
    case EventType.SUBAGENT_STARTED:
    case EventType.SUBAGENT_FINISHED:
    case EventType.SUBAGENT_ERROR:
      return "subagent";
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

/** Compile-time exhaustive check across all `solenoid-engine` CUSTOM_EVENTS. */
function classifyCustomEvent(name: CustomEventName): string {
  switch (name) {
    case CUSTOM_EVENTS.retry:
      return "retry";
    case CUSTOM_EVENTS.routeAdvanced:
      return "route_advanced";
    case CUSTOM_EVENTS.guardrail:
      return "guardrail";
    default: {
      const _exhaustive: never = name;
      return _exhaustive;
    }
  }
}

const ALL_EVENT_FIXTURES: Record<EventType, AGUIEvent> = {
  [EventType.RUN_STARTED]: runStarted("run-ex"),
  [EventType.RUN_FINISHED]: runFinishedSuccess("run-ex"),
  [EventType.RUN_ERROR]: runError("synthetic failure", "SYNTHETIC"),
  [EventType.STEP_STARTED]: stepStarted("turn 1"),
  [EventType.STEP_FINISHED]: stepFinished("turn 1"),
  [EventType.TEXT_MESSAGE_START]: textStart("msg-ex", "assistant"),
  [EventType.TEXT_MESSAGE_CONTENT]: textDelta("msg-ex", "hello"),
  [EventType.TEXT_MESSAGE_END]: textEnd("msg-ex"),
  [EventType.TEXT_MESSAGE_CHUNK]: {
    type: EventType.TEXT_MESSAGE_CHUNK,
    messageId: "msg-chunk",
    role: "assistant",
    delta: "chunk",
  },
  [EventType.TOOL_CALL_START]: {
    type: EventType.TOOL_CALL_START,
    toolCallId: "tc-ex",
    toolCallName: "okf_read",
    parentMessageId: "msg-ex",
  },
  [EventType.TOOL_CALL_ARGS]: {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: "tc-ex",
    delta: '{"id":"okf:note/1"}',
  },
  [EventType.TOOL_CALL_END]: {
    type: EventType.TOOL_CALL_END,
    toolCallId: "tc-ex",
  },
  [EventType.TOOL_CALL_CHUNK]: {
    type: EventType.TOOL_CALL_CHUNK,
    toolCallId: "tc-chunk",
    toolCallName: "okf_read",
    parentMessageId: "msg-ex",
    delta: "{}",
  },
  [EventType.TOOL_CALL_RESULT]: toolCallResult("tc-ex", "ok", { durationMs: 12 }),
  [EventType.STATE_SNAPSHOT]: {
    type: EventType.STATE_SNAPSHOT,
    snapshot: { phase: "idle" },
  },
  [EventType.STATE_DELTA]: {
    type: EventType.STATE_DELTA,
    delta: [{ op: "replace", path: "/phase", value: "running" }],
  },
  [EventType.MESSAGES_SNAPSHOT]: {
    type: EventType.MESSAGES_SNAPSHOT,
    messages: [],
  },
  [EventType.ACTIVITY_SNAPSHOT]: {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: "act-1",
    activityType: "chart",
    content: { series: [1, 2, 3] },
    replace: true,
  },
  [EventType.ACTIVITY_DELTA]: {
    type: EventType.ACTIVITY_DELTA,
    messageId: "act-1",
    activityType: "chart",
    patch: [{ op: "add", path: "/title", value: "Metrics" }],
  },
  [EventType.RAW]: {
    type: EventType.RAW,
    event: { raw: true },
    source: "provider",
  },
  [EventType.CUSTOM]: {
    type: EventType.CUSTOM,
    name: CUSTOM_EVENTS.guardrail,
    value: { boundary: "user_input", decision: "allow" },
  },
  [EventType.REASONING_START]: {
    type: EventType.REASONING_START,
    messageId: "r-ex",
  },
  [EventType.REASONING_MESSAGE_START]: {
    type: EventType.REASONING_MESSAGE_START,
    messageId: "r-ex",
    role: "reasoning",
  },
  [EventType.REASONING_MESSAGE_CONTENT]: {
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId: "r-ex",
    delta: "thinking",
  },
  [EventType.REASONING_MESSAGE_END]: {
    type: EventType.REASONING_MESSAGE_END,
    messageId: "r-ex",
  },
  [EventType.REASONING_MESSAGE_CHUNK]: {
    type: EventType.REASONING_MESSAGE_CHUNK,
    messageId: "r-chunk",
    delta: "chunk",
  },
  [EventType.REASONING_END]: {
    type: EventType.REASONING_END,
    messageId: "r-ex",
  },
  [EventType.REASONING_ENCRYPTED_VALUE]: {
    type: EventType.REASONING_ENCRYPTED_VALUE,
    subtype: "message",
    entityId: "r-ex",
    encryptedValue: "opaque-blob",
  },
  [EventType.SUBAGENT_STARTED]: {
    type: EventType.SUBAGENT_STARTED,
    subagentRunId: "sa-run-1",
    name: "researcher",
    description: "Looking up flights",
  },
  [EventType.SUBAGENT_FINISHED]: {
    type: EventType.SUBAGENT_FINISHED,
    subagentRunId: "sa-run-1",
    outcome: { type: "success" },
  },
  [EventType.SUBAGENT_ERROR]: {
    type: EventType.SUBAGENT_ERROR,
    subagentRunId: "sa-run-1",
    message: "subagent failed",
  },
};

const ALL_CUSTOM_FIXTURES: Record<CustomEventName, AGUIEvent> = {
  [CUSTOM_EVENTS.retry]: customRetry("503 upstream", 250),
  [CUSTOM_EVENTS.routeAdvanced]: customRouteAdvanced(
    { provider: "omlx", model: "local-1" },
    { provider: "openrouter", model: "fallback-1" },
    "stall timeout",
  ),
  [CUSTOM_EVENTS.guardrail]: {
    type: EventType.CUSTOM,
    name: CUSTOM_EVENTS.guardrail,
    value: { boundary: "tool_output", decision: "observe", score: 0.12 },
  },
};

describe("Tier 1 — Exhaustiveness across @ag-ui/core EventType & solenoid-engine CUSTOM_EVENTS", () => {
  test("real web/src/app/chat.ts reducer exports apply() and EMPTY_LIVE_TURN", () => {
    expect(typeof apply).toBe("function");
    expect(EMPTY_LIVE_TURN).toBeDefined();
    expect(Array.isArray(EMPTY_LIVE_TURN.calls)).toBe(true);
  });

  test("covers every @ag-ui/core EventType and solenoid-engine CUSTOM_EVENTS without throwing", () => {
    const allEventTypes = Object.values(EventType);
    expect(Object.keys(ALL_EVENT_FIXTURES).sort()).toEqual([...allEventTypes].sort());

    const allCustomNames = Object.values(CUSTOM_EVENTS);
    expect(Object.keys(ALL_CUSTOM_FIXTURES).sort()).toEqual([...allCustomNames].sort());

    for (const eventType of allEventTypes) {
      expect(classifyEventType(eventType).length).toBeGreaterThan(0);
      const translator = new AgUiToChatEventTranslator();
      const emitted = translator.push(ALL_EVENT_FIXTURES[eventType]);
      expect(Array.isArray(emitted)).toBe(true);
      let live = freshLiveTurn();
      for (const chatEvent of emitted) {
        live = apply(live, chatEvent);
        expect(live).toBeDefined();
      }
    }

    for (const customName of allCustomNames) {
      expect(classifyCustomEvent(customName).length).toBeGreaterThan(0);
      const translator = new AgUiToChatEventTranslator();
      const emitted = translator.push(ALL_CUSTOM_FIXTURES[customName]);
      expect(Array.isArray(emitted)).toBe(true);
    }

    // Forward-compatibility: unknown CUSTOM event names are safely ignored without throwing.
    const translator = new AgUiToChatEventTranslator();
    const unknownCustom: AGUIEvent = {
      type: EventType.CUSTOM,
      name: "solenoid.future_unreleased_event",
      value: { hello: "world" },
    };
    expect(translator.push(unknownCustom)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Golden Replay & Checkpoint Equivalence — All 9 Scenarios
// ---------------------------------------------------------------------------

describe("Tier 1 — Golden Replay & Checkpoint Equivalence", () => {
  test("Scenario 1: plain prose streaming (TEXT_MESSAGE_START/CONTENT/END)", () => {
    const steps: TimelineStep[] = [
      { kind: "agui", event: runStarted("run-1") },
      ...openingMessage("u-1", "user", "What is the capital of France?").map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: textStart("a-1", "assistant") },
      { kind: "agui", event: textDelta("a-1", "The capital ") },
      { kind: "agui", event: textDelta("a-1", "of France is ") },
      { kind: "agui", event: textDelta("a-1", "Paris.") },
      { kind: "agui", event: textEnd("a-1") },
      { kind: "agui", event: stepFinished("turn 1") },
      { kind: "agui", event: runFinishedSuccess("run-1") },
    ];

    const result = replayAndCompare(steps);

    // Live delta stream accumulated smoothly before message committed.
    const deltas = result.emitted.filter(
      (e): e is Extract<ChatEvent, { type: "delta" }> => e.type === "delta",
    );
    expect(deltas.map((d) => d.text).join("")).toBe("The capital of France is Paris.");

    const preMessageState = result.observedLiveStates.findLast(
      (s) => s.event.type === "delta",
    )?.live;
    expect(preMessageState?.streamingText).toBe("The capital of France is Paris.");

    const msg = result.emitted.find(
      (e): e is Extract<ChatEvent, { type: "message" }> => e.type === "message",
    );
    expect(msg).toMatchObject({
      type: "message",
      messageId: "a-1",
      body: "The capital of France is Paris.",
      note: null,
      toolSummary: null,
    });

    expect(result.finalSnapshot).toBeNull();
    expect(result.finalLive).toBeNull();

    // Exact field-for-field equivalence between live rendering and checkpoint hydration.
    expect(result.liveTurns).toEqual(result.hydratedTurns);
    expect(result.hydratedTurns).toEqual([
      {
        by: "user",
        body: "What is the capital of France?",
        source: "text",
        note: null,
        toolSummary: null,
        calls: [],
        approval: null,
        deferredApprovals: [],
      },
      {
        by: "agent",
        body: "The capital of France is Paris.",
        source: "text",
        note: null,
        toolSummary: null,
        calls: [],
        approval: null,
        deferredApprovals: [],
      },
    ]);
  });

  test("Scenario 2: reasoning + prose + tool calls with ×2 collapse and multi-underscore names", () => {
    const steps: TimelineStep[] = [
      { kind: "agui", event: runStarted("run-2") },
      ...openingMessage("u-2", "user", "Check unread threads and Ferris notes.").map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepStarted("turn 1") },
      ...reasoningEvents("r-1", ["Need to check iMessage ", "and OKF contact card."]).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: textStart("a-1", "assistant") },
      { kind: "agui", event: textDelta("a-1", "Checking your messages and notes.") },
      { kind: "agui", event: textEnd("a-1") },
      { kind: "agui", event: stepFinished("turn 1") },
      ...toolCallStartSeq("tc-1", "imessage_list_conversations", "a-1", { query: "Ferris" }).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      ...toolCallStartSeq("tc-2", "imessage_list_conversations", "a-1", { query: "unread" }).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      ...toolCallStartSeq("tc-3", "okf_read", "a-1", { id: "okf:contact/ferris" }).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: toolCallResult("tc-1", '{"count":1}', { durationMs: 240 }) },
      { kind: "agui", event: toolCallResult("tc-2", '{"count":2}', { durationMs: 180 }) },
      { kind: "agui", event: toolCallResult("tc-3", '{"name":"Ferris"}', { durationMs: 1450 }) },
      { kind: "agui", event: stepStarted("turn 2") },
      ...reasoningEvents("r-2", ["Ready to summarize."]).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: textStart("a-2", "assistant") },
      { kind: "agui", event: textDelta("a-2", "You have 2 unread threads from Ferris.") },
      { kind: "agui", event: textEnd("a-2") },
      { kind: "agui", event: stepFinished("turn 2") },
      { kind: "agui", event: runFinishedSuccess("run-2") },
    ];

    const result = replayAndCompare(steps, {
      translator: { resolveToolKind: () => "read" },
    });

    // Reasoning deltas streamed and folded into live state, never leaking into final prose.
    const reasoningDeltas = result.emitted.filter(
      (e): e is Extract<ChatEvent, { type: "reasoning_delta" }> => e.type === "reasoning_delta",
    );
    expect(reasoningDeltas.length).toBeGreaterThanOrEqual(3);
    expect(reasoningDeltas.map((r) => r.text).join("")).toContain("Need to check iMessage");

    const preStep1EndReasoning = result.observedLiveStates.find(
      (s) => s.event.type === "reasoning_delta" && s.event.text.includes("OKF"),
    )?.live;
    expect(preStep1EndReasoning?.streamingReasoning).toContain("Need to check iMessage");

    // Tool starts and ends paired cleanly.
    const starts = result.emitted.filter((e) => e.type === "tool_start");
    const ends = result.emitted.filter((e) => e.type === "tool_end");
    expect(starts).toHaveLength(3);
    expect(ends).toHaveLength(3);

    // Exact field-for-field equivalence (including ×2 collapse & no double-dotting of imessage.list_conversations).
    expect(result.liveTurns).toEqual(result.hydratedTurns);
    expect(result.hydratedTurns).toHaveLength(2);
    expect(result.hydratedTurns[1]).toEqual({
      by: "agent",
      body: "You have 2 unread threads from Ferris.",
      source: "text",
      note: null,
      toolSummary: "3 tool calls · imessage.list_conversations ×2, okf.read",
      calls: [
        {
          name: "imessage.list_conversations",
          arg: "Ferris",
          kind: "read",
          ok: true,
          duration: "240ms",
        },
        {
          name: "imessage.list_conversations",
          arg: "unread",
          kind: "read",
          ok: true,
          duration: "180ms",
        },
        {
          name: "okf.read",
          arg: "okf:contact/ferris",
          kind: "read",
          ok: true,
          duration: "1.5s",
        },
      ],
      approval: null,
      deferredApprovals: [],
    });
  });

  test("Scenario 3: open_tool_group emits opened, sets note, and is excluded from calls & toolSummary", () => {
    const steps: TimelineStep[] = [
      { kind: "agui", event: runStarted("run-3") },
      ...openingMessage("u-3", "user", "Check reminders and calendar.").map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: stepFinished("turn 1") },
      ...toolCallStartSeq("tc-open-1", OPEN_TOOL_GROUP, "a-1", { group: "reminders" }).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      ...toolCallStartSeq("tc-open-2", OPEN_TOOL_GROUP, "a-1", { group: "calendar" }).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: toolCallResult("tc-open-1", "Briefing: reminders", { durationMs: 4 }) },
      { kind: "agui", event: toolCallResult("tc-open-2", "Briefing: calendar", { durationMs: 3 }) },
      { kind: "agui", event: stepStarted("turn 2") },
      { kind: "agui", event: stepFinished("turn 2") },
      // Re-opening reminders a second time must not duplicate "reminders" in note.
      ...toolCallStartSeq("tc-open-3", OPEN_TOOL_GROUP, "a-2", { group: "reminders" }).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      ...toolCallStartSeq("tc-rem", "reminders_list", "a-2", { query: "today" }).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      ...toolCallStartSeq("tc-cal", "calendar_list", "a-2", {}).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: toolCallResult("tc-open-3", "Already open.", { durationMs: 1 }) },
      { kind: "agui", event: toolCallResult("tc-rem", "[]", { durationMs: 120 }) },
      { kind: "agui", event: toolCallResult("tc-cal", "[]", { durationMs: 85 }) },
      { kind: "agui", event: stepStarted("turn 3") },
      { kind: "agui", event: textStart("a-3", "assistant") },
      { kind: "agui", event: textDelta("a-3", "Nothing due on reminders or calendar today.") },
      { kind: "agui", event: textEnd("a-3") },
      { kind: "agui", event: stepFinished("turn 3") },
      { kind: "agui", event: runFinishedSuccess("run-3") },
    ];

    const result = replayAndCompare(steps);

    const openedEvents = result.emitted.filter(
      (e): e is Extract<ChatEvent, { type: "opened" }> => e.type === "opened",
    );
    expect(openedEvents.map((e) => e.group)).toContain("reminders");
    expect(openedEvents.map((e) => e.group)).toContain("calendar");

    // open_tool_group MUST NEVER emit tool_start / tool_end / tool frames.
    const toolEvents = result.emitted.filter(
      (e) => e.type === "tool_start" || e.type === "tool_end" || e.type === "tool",
    );
    for (const te of toolEvents) {
      if ("name" in te) {
        expect(te.name).not.toContain("open");
      }
    }

    expect(result.liveTurns).toEqual(result.hydratedTurns);
    expect(result.hydratedTurns[1]).toMatchObject({
      by: "agent",
      body: "Nothing due on reminders or calendar today.",
      note: "opened reminders, calendar",
      toolSummary: "2 tool calls · reminders.list, calendar.list",
      calls: [
        { name: "reminders.list", arg: "today", kind: "read", ok: true, duration: "120ms" },
        { name: "calendar.list", arg: null, kind: "read", ok: true, duration: "85ms" },
      ],
    });
  });

  test("Scenario 4: retry mid-step (solenoid.retry + MESSAGES_SNAPSHOT) emits step reset and discards partial step only", () => {
    const steps: TimelineStep[] = [
      { kind: "agui", event: runStarted("run-4") },
      ...openingMessage("u-4", "user", "Summarize my inbox.").map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      // Step 1 succeeds: opens mail group and lists inbox.
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: stepFinished("turn 1") },
      ...toolCallStartSeq("tc-open-mail", OPEN_TOOL_GROUP, "a-1", { group: "mail" }).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      ...toolCallStartSeq("tc-mail-list", "mail_list", "a-1", { query: "inbox" }).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: toolCallResult("tc-open-mail", "Briefing: mail", { durationMs: 2 }) },
      { kind: "agui", event: toolCallResult("tc-mail-list", '["m1","m2"]', { durationMs: 200 }) },
      // Mark exact stepStart before Step 2 begins.
      { kind: "mark", label: "step2Start" },
      // Step 2 attempt 1 streams corrupt partial output, then retries!
      { kind: "agui", event: stepStarted("turn 2") },
      ...reasoningEvents("r-bad", ["Bad truncated thought..."]).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: textStart("a-2-bad", "assistant") },
      { kind: "agui", event: textDelta("a-2-bad", "Half-written corrupt ") },
      { kind: "agui", event: textEnd("a-2-bad") },
      { kind: "agui", event: stepFinished("turn 2") },
      { kind: "agui", event: customRetry("503 upstream timeout", 250) },
      { kind: "snapshot_to", label: "step2Start" },
      // Step 2 attempt 2 succeeds cleanly.
      { kind: "agui", event: stepStarted("turn 2") },
      { kind: "agui", event: textStart("a-2-good", "assistant") },
      { kind: "agui", event: textDelta("a-2-good", "You have 2 emails waiting.") },
      { kind: "agui", event: textEnd("a-2-good") },
      { kind: "agui", event: stepFinished("turn 2") },
      { kind: "agui", event: runFinishedSuccess("run-4") },
    ];

    const result = replayAndCompare(steps);

    const resetEvent = result.emitted.find(
      (e): e is Extract<ChatEvent, { type: "reset" }> => e.type === "reset",
    );
    expect(resetEvent).toBeDefined();
    expect(resetEvent!.scope).toBe("step");
    expect(resetEvent!.reason.length).toBeGreaterThan(0);
    // Discarded Step 2 partial text & reasoning are wiped; Step 1's opened + calls survive.
    expect(resetEvent!.live.streamingText).toBe("");
    expect(resetEvent!.live.streamingReasoning).toBe("");
    expect(resetEvent!.live.opened).toEqual(["mail"]);
    expect(resetEvent!.live.calls.map((c) => c.name)).toEqual(["mail.list"]);

    // Verify client `apply()` applied the reset cleanly too.
    const postResetLive = result.observedLiveStates.find((s) => s.event.type === "reset")?.live;
    expect(postResetLive?.streamingText).toBe("");
    expect(postResetLive?.streamingReasoning).toBe("");
    expect(postResetLive?.opened).toEqual(["mail"]);
    expect(postResetLive?.calls).toHaveLength(1);

    // Final message has ZERO trace of discarded partial text.
    expect(result.liveTurns).toEqual(result.hydratedTurns);
    expect(result.hydratedTurns[1]).toEqual({
      by: "agent",
      body: "You have 2 emails waiting.",
      source: "text",
      note: "opened mail",
      toolSummary: "1 tool call · mail.list",
      calls: [{ name: "mail.list", arg: "inbox", kind: "read", ok: true, duration: "200ms" }],
      approval: null,
      deferredApprovals: [],
    });
  });

  test("Scenario 5: route fallback (solenoid.route_advanced + MESSAGES_SNAPSHOT) rolls back whole failed attempt without bleeding prior turns", () => {
    const steps: TimelineStep[] = [
      // Prior completed Turn 0 to verify snapshot slicing isolates Turn 1 cleanly.
      { kind: "agui", event: runStarted("run-5-t0") },
      ...openingMessage("u-5-0", "user", "Ping?").map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: textStart("a-5-0", "assistant") },
      { kind: "agui", event: textDelta("a-5-0", "Pong.") },
      { kind: "agui", event: textEnd("a-5-0") },
      { kind: "agui", event: stepFinished("turn 1") },
      { kind: "agui", event: runFinishedSuccess("run-5-t0") },

      // Turn 1 starts on Route 1, does work, then stalls and falls back to Route 2.
      { kind: "agui", event: runStarted("run-5-t1") },
      ...openingMessage("u-5-1", "user", "Check weather and notes.").map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "mark", label: "turn1Start" },
      // Route 1 Step 1: opens weather, speaks intermediate prose, calls weather_get.
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: textStart("a-r1-1", "assistant") },
      { kind: "agui", event: textDelta("a-r1-1", "Trying route 1 weather lookup.") },
      { kind: "agui", event: textEnd("a-r1-1") },
      { kind: "agui", event: stepFinished("turn 1") },
      ...toolCallStartSeq("tc-r1-open", OPEN_TOOL_GROUP, "a-r1-1", { group: "weather" }).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      ...toolCallStartSeq("tc-r1-wx", "weather_get", "a-r1-1", { query: "NYC" }).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: toolCallResult("tc-r1-open", "Briefing: weather", { durationMs: 3 }) },
      { kind: "agui", event: toolCallResult("tc-r1-wx", "72F", { durationMs: 300 }) },
      // Route 1 Step 2 starts streaming then fails -> route_advanced + MESSAGES_SNAPSHOT to turn1Start!
      { kind: "agui", event: stepStarted("turn 2") },
      { kind: "agui", event: textStart("a-r1-2", "assistant") },
      { kind: "agui", event: textDelta("a-r1-2", "Broken partial from route 1") },
      { kind: "agui", event: textEnd("a-r1-2") },
      { kind: "agui", event: stepFinished("turn 2") },
      {
        kind: "agui",
        event: customRouteAdvanced(
          { provider: "omlx", model: "local-qwen" },
          { provider: "openrouter", model: "claude-fallback" },
          "first byte stall timeout",
        ),
      },
      { kind: "snapshot_to", label: "turn1Start" },

      // Route 2 executes cleanly from scratch with different tool.
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: stepFinished("turn 1") },
      ...toolCallStartSeq("tc-r2-okf", "okf_read", "a-r2-1", { id: "okf:note/today" }).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: toolCallResult("tc-r2-okf", "Clear schedule", { durationMs: 110 }) },
      { kind: "agui", event: stepStarted("turn 2") },
      { kind: "agui", event: textStart("a-r2-2", "assistant") },
      { kind: "agui", event: textDelta("a-r2-2", "Your notes are clear today.") },
      { kind: "agui", event: textEnd("a-r2-2") },
      { kind: "agui", event: stepFinished("turn 2") },
      { kind: "agui", event: runFinishedSuccess("run-5-t1") },
    ];

    const result = replayAndCompare(steps);

    const resetEvent = result.emitted.find(
      (e): e is Extract<ChatEvent, { type: "reset" }> => e.type === "reset",
    );
    expect(resetEvent).toBeDefined();
    expect(resetEvent!.scope).toBe("attempt");
    expect(resetEvent!.live.asked).toBe("Check weather and notes.");
    expect(resetEvent!.live.calls).toEqual([]);
    expect(resetEvent!.live.opened).toEqual([]);
    expect(resetEvent!.live.said).toEqual([]);
    expect(resetEvent!.live.streamingText).toBe("");
    expect(resetEvent!.live.streamingReasoning).toBe("");

    // Exact equivalence across BOTH turns: Turn 0 intact, Turn 1 has ONLY Route 2's work.
    expect(result.liveTurns).toEqual(result.hydratedTurns);
    expect(result.hydratedTurns).toHaveLength(4);
    expect(result.hydratedTurns[0]?.body).toBe("Ping?");
    expect(result.hydratedTurns[1]?.body).toBe("Pong.");
    expect(result.hydratedTurns[2]?.body).toBe("Check weather and notes.");
    expect(result.hydratedTurns[3]).toEqual({
      by: "agent",
      body: "Your notes are clear today.",
      source: "text",
      note: null,
      toolSummary: "1 tool call · okf.read",
      calls: [{ name: "okf.read", arg: "okf:note/today", kind: "read", ok: true, duration: "110ms" }],
      approval: null,
      deferredApprovals: [],
    });
  });

  test("Scenario 6: approval interrupt + settlement + resume + write completion", () => {
    const choices: ChatChoice[] = [
      { id: "act-allow", label: "Go ahead", stance: "affirm" },
      { id: "act-deny", label: "Not this one", stance: "quiet" },
    ];
    const facts: ChatFact[] = [
      ["Call", "reminders.create"],
      ["title", "Call the plumber"],
    ];
    const approvalContext: TranslatorApprovalContext = {
      decisionId: "dec-6",
      ref: "ap/1124-1",
      title: "I'll create a reminder to call the plumber.",
      why: "Create a new reminder on your default list.",
      hold: "Nothing has been written. I stopped before the call.",
      tool: "reminders.create",
      facts,
      actions: choices,
    };
    const hydratedApproval: ChatApproval = {
      decisionId: "dec-6",
      ref: "ap/1124-1",
      title: "I'll create a reminder to call the plumber.",
      why: "Create a new reminder on your default list.",
      hold: "Nothing has been written. I stopped before the call.",
      facts: facts.map(([k, v]) => [k, v]),
      choices,
      state: "resolved",
      chosenId: "act-allow",
      settled: 'You said "Go ahead", 15:30. reminders.create ran and finished.',
    };

    const steps: TimelineStep[] = [
      { kind: "agui", event: runStarted("run-6-a") },
      ...openingMessage("u-6", "user", "Remind me to call the plumber.").map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: textStart("a-6-1", "assistant") },
      { kind: "agui", event: textDelta("a-6-1", "I'll create a reminder to call the plumber.") },
      { kind: "agui", event: textEnd("a-6-1") },
      { kind: "agui", event: stepFinished("turn 1") },
      ...toolCallStartSeq("tc-rem-write", "reminders_create", "a-6-1", {
        title: "Call the plumber",
      }).map((event): TimelineStep => ({ kind: "agui", event })),
      {
        kind: "agui",
        event: runFinishedInterrupt(
          "run-6-a",
          "approval:tc-rem-write",
          "tc-rem-write",
          "Allow reminders_create?",
        ),
      },
      // Person presses "Go ahead" -> settles approval -> session opens run-6-b to resume!
      { kind: "settle", decisionId: "dec-6", outcome: "approved" },
      { kind: "agui", event: runStarted("run-6-b") },
      {
        kind: "agui",
        event: toolCallResult("tc-rem-write", '{"id":"rem-99"}', { durationMs: 320 }),
      },
      { kind: "agui", event: stepStarted("turn 2") },
      { kind: "agui", event: textStart("a-6-2", "assistant") },
      { kind: "agui", event: textDelta("a-6-2", "Done — your reminder is saved.") },
      { kind: "agui", event: textEnd("a-6-2") },
      { kind: "agui", event: stepFinished("turn 2") },
      { kind: "agui", event: runFinishedSuccess("run-6-b") },
    ];

    const resolveToolKind = (name: string): "read" | "write" =>
      name === "reminders_create" ? "write" : "read";

    const result = replayAndCompare(steps, {
      translator: {
        resolveToolKind,
        resolveApproval: (interruptId, toolCallId) =>
          interruptId === "approval:tc-rem-write" && toolCallId === "tc-rem-write"
            ? approvalContext
            : undefined,
      },
      hydrate: {
        resolveToolKind,
        approvalsByToolCallId: new Map([["tc-rem-write", hydratedApproval]]),
      },
    });

    // Verify exact ordering: approval -> settled -> tool_end -> message.
    const types = result.emitted.map((e) => e.type);
    const approvalIdx = types.indexOf("approval");
    const settledIdx = types.indexOf("settled");
    const toolEndIdx = types.indexOf("tool_end");
    const messageIdx = types.indexOf("message");
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(settledIdx).toBeGreaterThan(approvalIdx);
    expect(toolEndIdx).toBeGreaterThan(settledIdx);
    expect(messageIdx).toBeGreaterThan(toolEndIdx);

    // While paused on interrupt, client live state held pending approval; after settle it cleared.
    const duringWait = result.observedLiveStates[approvalIdx]?.live;
    expect(duringWait?.pending?.decisionId).toBe("dec-6");
    const afterSettle = result.observedLiveStates[settledIdx]?.live;
    expect(afterSettle?.pending).toBeNull();

    // Resumed RUN_STARTED did NOT emit a second turn_start.
    expect(result.emitted.filter((e) => e.type === "turn_start")).toHaveLength(1);

    // Exact field-for-field equivalence including write call and approval card.
    expect(result.liveTurns).toEqual(result.hydratedTurns);
    expect(result.hydratedTurns[1]).toMatchObject({
      by: "agent",
      body: "Done — your reminder is saved.",
      note: null,
      toolSummary: "1 tool call · reminders.create",
      calls: [
        {
          name: "reminders.create",
          arg: "Call the plumber",
          kind: "write",
          ok: true,
          duration: "320ms",
        },
      ],
      approval: {
        decisionId: "dec-6",
        ref: "ap/1124-1",
        state: "resolved",
      },
    });
  });

  test("Scenario 7: subagent spawn + parent turn end + async onAutoTurn (developer opening -> source: 'subagent')", () => {
    const steps: TimelineStep[] = [
      // Turn 1: parent user turn spawns subagent and finishes cleanly.
      { kind: "agui", event: runStarted("run-7-parent") },
      ...openingMessage("u-7", "user", "Research flights NYC to SFO in the background.").map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: stepFinished("turn 1") },
      ...toolCallStartSeq("tc-spawn", "spawn_subagent", "a-7-1", {
        name: "flights",
        task: "Search nonstop NYC to SFO flights",
      }).map((event): TimelineStep => ({ kind: "agui", event })),
      {
        kind: "agui",
        event: toolCallResult("tc-spawn", '{"id":"sa-1","status":"running"}', { durationMs: 12 }),
      },
      { kind: "agui", event: stepStarted("turn 2") },
      { kind: "agui", event: textStart("a-7-2", "assistant") },
      { kind: "agui", event: textDelta("a-7-2", "Started a background researcher on flights.") },
      { kind: "agui", event: textEnd("a-7-2") },
      { kind: "agui", event: stepFinished("turn 2") },
      { kind: "agui", event: runFinishedSuccess("run-7-parent") },

      // Turn 2: async onAutoTurn opens with a `developer` message on the same session/translator.
      { kind: "agui", event: runStarted("run-7-auto") },
      ...openingMessage(
        "dev-7",
        "developer",
        "Subagents finished: flights (sa-1) done.\n\nflights (sa-1) answered:\nCheapest nonstop is $289.",
      ).map((event): TimelineStep => ({ kind: "agui", event })),
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: textStart("a-7-syn", "assistant") },
      { kind: "agui", event: textDelta("a-7-syn", "The flight researcher finished: ") },
      { kind: "agui", event: textDelta("a-7-syn", "cheapest nonstop NYC to SFO is $289.") },
      { kind: "agui", event: textEnd("a-7-syn") },
      { kind: "agui", event: stepFinished("turn 1") },
      { kind: "agui", event: runFinishedSuccess("run-7-auto") },
    ];

    const result = replayAndCompare(steps);

    const turnStarts = result.emitted.filter(
      (e): e is Extract<ChatEvent, { type: "turn_start" }> => e.type === "turn_start",
    );
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts[0]?.source).toBe("text");
    expect(turnStarts[1]?.source).toBe("subagent");

    const messages = result.emitted.filter(
      (e): e is Extract<ChatEvent, { type: "message" }> => e.type === "message",
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      type: "message",
      messageId: "a-7-syn",
      body: "The flight researcher finished: cheapest nonstop NYC to SFO is $289.",
      note: null,
      toolSummary: null,
      source: "subagent",
    });

    // Exact equivalence: 3 rows total (user, parent agent, subagent synthesis agent) — NO fake user row for `developer`.
    expect(result.liveTurns).toEqual(result.hydratedTurns);
    expect(result.hydratedTurns.map((t) => ({ by: t.by, source: t.source }))).toEqual([
      { by: "user", source: "text" },
      { by: "agent", source: "text" },
      { by: "agent", source: "subagent" },
    ]);
    expect(result.hydratedTurns[2]).toEqual({
      by: "agent",
      body: "The flight researcher finished: cheapest nonstop NYC to SFO is $289.",
      source: "subagent",
      note: null,
      toolSummary: null,
      calls: [],
      approval: null,
      deferredApprovals: [],
    });
  });

  test("Scenario 8: deferred subagent approval arrives mid-stream without setting blocking pending", () => {
    const choices: ChatChoice[] = [
      { id: "def-allow", label: "Go ahead", stance: "affirm" },
      { id: "def-deny", label: "Not this one", stance: "quiet" },
    ];
    const facts: ChatFact[] = [
      ["Call", "reminders.create"],
      ["title", "Buy filters"],
    ];
    const deferredEvent: Extract<ChatEvent, { type: "deferred_approval" }> = {
      type: "deferred_approval",
      decisionId: "dec-def-8",
      ref: "ap/1124-9",
      title: "Background subagent wants to add a reminder.",
      why: "Create a new reminder on your default list.",
      hold: "Deferred by subagent — nothing has been written.",
      tool: "reminders.create",
      subagentName: "errands-helper",
      facts,
      actions: choices,
    };
    const hydratedDeferred: ChatApproval = {
      decisionId: "dec-def-8",
      ref: "ap/1124-9",
      title: "Background subagent wants to add a reminder.",
      why: "Create a new reminder on your default list.",
      hold: "Deferred by subagent — nothing has been written.",
      facts: facts.map(([k, v]) => [k, v]),
      choices,
      state: "open",
      chosenId: null,
      settled: null,
      deferred: true,
      subagentName: "errands-helper",
    };

    const steps: TimelineStep[] = [
      { kind: "agui", event: runStarted("run-8") },
      ...openingMessage("u-8", "user", "What else is on my plate?").map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: textStart("a-8", "assistant") },
      { kind: "agui", event: textDelta("a-8", "Your afternoon is ") },
      // Mid-stream deferred approval from background subagent!
      { kind: "deferred", event: deferredEvent },
      { kind: "agui", event: textDelta("a-8", "completely clear.") },
      { kind: "agui", event: textEnd("a-8") },
      { kind: "agui", event: stepFinished("turn 1") },
      { kind: "agui", event: runFinishedSuccess("run-8") },
    ];

    const result = replayAndCompare(steps, {
      hydrate: { deferredApprovals: [hydratedDeferred] },
    });

    const atDeferred = result.observedLiveStates.find(
      (s) => s.event.type === "deferred_approval",
    )?.live;
    expect(atDeferred).toBeDefined();
    // Critical UX invariant: deferred subagent approval MUST NOT lock the composer via `pending`.
    expect(atDeferred?.pending).toBeNull();
    expect(atDeferred?.deferredApprovals).toEqual([deferredEvent]);
    expect(atDeferred?.streamingText).toBe("Your afternoon is ");

    // Exact equivalence with hydrated deferred approvals (and blocking `approval` stays null).
    expect(result.liveTurns).toEqual(result.hydratedTurns);
    expect(result.hydratedTurns[1]?.approval).toBeNull();
    expect(result.hydratedTurns[1]?.deferredApprovals).toHaveLength(1);
    expect(result.hydratedTurns[1]?.deferredApprovals[0]).toMatchObject({
      decisionId: "dec-def-8",
      deferred: true,
      subagentName: "errands-helper",
      state: "open",
    });
  });

  describe("Scenario 9: quarantined output, malformed args, declined write, user cancel, and fatal RUN_ERROR", () => {
    test("9a: quarantined tool output sets responseQuarantined: true and ok: false", () => {
      const steps: TimelineStep[] = [
        { kind: "agui", event: runStarted("run-9a") },
        ...openingMessage("u-9a", "user", "Fetch that untrusted page.").map(
          (event): TimelineStep => ({ kind: "agui", event }),
        ),
        { kind: "agui", event: stepStarted("turn 1") },
        { kind: "agui", event: stepFinished("turn 1") },
        ...toolCallStartSeq("tc-q", "web_fetch", "a-9a-1", {
          query: "https://untrusted.example",
        }).map((event): TimelineStep => ({ kind: "agui", event })),
        {
          kind: "agui",
          event: toolCallResult("tc-q", "[output quarantined]", {
            durationMs: 410,
            quarantined: true,
          }),
        },
        { kind: "agui", event: stepStarted("turn 2") },
        { kind: "agui", event: textStart("a-9a-2", "assistant") },
        { kind: "agui", event: textDelta("a-9a-2", "That page's content was quarantined.") },
        { kind: "agui", event: textEnd("a-9a-2") },
        { kind: "agui", event: stepFinished("turn 2") },
        { kind: "agui", event: runFinishedSuccess("run-9a") },
      ];

      const result = replayAndCompare(steps);

      const toolEnd = result.emitted.find(
        (e): e is Extract<ChatEvent, { type: "tool_end" }> => e.type === "tool_end",
      );
      expect(toolEnd).toMatchObject({
        type: "tool_end",
        id: "tc-q",
        name: "web.fetch",
        kind: "read",
        ok: false,
        duration: "410ms",
        responseQuarantined: true,
      });

      expect(result.liveTurns).toEqual(result.hydratedTurns);
      expect(result.hydratedTurns[1]?.calls).toEqual([
        {
          name: "web.fetch",
          arg: "https://untrusted.example",
          kind: "read",
          ok: false,
          duration: "410ms",
        },
      ]);
    });

    test("9b: malformed tool args (unparseable JSON + malformed metadata) never throw and report ok: false", () => {
      const steps: TimelineStep[] = [
        { kind: "agui", event: runStarted("run-9b") },
        ...openingMessage("u-9b", "user", "Schedule something broken.").map(
          (event): TimelineStep => ({ kind: "agui", event }),
        ),
        { kind: "agui", event: stepStarted("turn 1") },
        { kind: "agui", event: stepFinished("turn 1") },
        ...toolCallStartSeq("tc-bad", "calendar_create", "a-9b-1", "{not valid json!!!").map(
          (event): TimelineStep => ({ kind: "agui", event }),
        ),
        {
          kind: "agui",
          event: toolCallResult("tc-bad", "Invalid arguments: expected object", {
            durationMs: 2,
            error: "Invalid arguments: expected object",
            malformed: true,
          }),
        },
        { kind: "agui", event: stepStarted("turn 2") },
        { kind: "agui", event: textStart("a-9b-2", "assistant") },
        { kind: "agui", event: textDelta("a-9b-2", "I need a valid date to schedule that.") },
        { kind: "agui", event: textEnd("a-9b-2") },
        { kind: "agui", event: stepFinished("turn 2") },
        { kind: "agui", event: runFinishedSuccess("run-9b") },
      ];

      const resolveToolKind = (name: string): "read" | "write" =>
        name === "calendar_create" ? "write" : "read";

      const result = replayAndCompare(steps, {
        translator: { resolveToolKind },
        hydrate: { resolveToolKind },
      });

      const toolEnd = result.emitted.find(
        (e): e is Extract<ChatEvent, { type: "tool_end" }> => e.type === "tool_end",
      );
      expect(toolEnd).toMatchObject({
        type: "tool_end",
        id: "tc-bad",
        name: "calendar.create",
        arg: null,
        kind: "write",
        ok: false,
        duration: "2ms",
      });

      expect(result.liveTurns).toEqual(result.hydratedTurns);
    });

    test("9c: declined write settles as declined, marks tool ok: false, and matches hydration", () => {
      const choices: ChatChoice[] = [
        { id: "act-yes", label: "Go ahead", stance: "affirm" },
        { id: "act-no", label: "Not this one", stance: "quiet" },
      ];
      const facts: ChatFact[] = [
        ["Call", "reminders.create"],
        ["title", "Cancel gym"],
      ];
      const approvalContext: TranslatorApprovalContext = {
        decisionId: "dec-9c",
        ref: "ap/1124-2",
        title: "Create a reminder to cancel the gym.",
        why: "Create a new reminder.",
        hold: "Nothing has been written.",
        tool: "reminders.create",
        facts,
        actions: choices,
      };
      const hydratedDeclined: ChatApproval = {
        decisionId: "dec-9c",
        ref: "ap/1124-2",
        title: "Create a reminder to cancel the gym.",
        why: "Create a new reminder.",
        hold: "Nothing has been written.",
        facts: facts.map(([k, v]) => [k, v]),
        choices,
        state: "dismissed",
        chosenId: "act-no",
        settled: 'You said "Not this one" — nothing was written.',
      };

      const steps: TimelineStep[] = [
        { kind: "agui", event: runStarted("run-9c-1") },
        ...openingMessage("u-9c", "user", "Remind me to cancel the gym.").map(
          (event): TimelineStep => ({ kind: "agui", event }),
        ),
        { kind: "agui", event: stepStarted("turn 1") },
        { kind: "agui", event: stepFinished("turn 1") },
        ...toolCallStartSeq("tc-decl", "reminders_create", "a-9c-1", { title: "Cancel gym" }).map(
          (event): TimelineStep => ({ kind: "agui", event }),
        ),
        {
          kind: "agui",
          event: runFinishedInterrupt(
            "run-9c-1",
            "approval:tc-decl",
            "tc-decl",
            "Allow reminders_create?",
          ),
        },
        { kind: "settle", decisionId: "dec-9c", outcome: "declined" },
        { kind: "agui", event: runStarted("run-9c-2") },
        {
          kind: "agui",
          event: toolCallResult("tc-decl", "The user declined reminders_create.", {
            durationMs: 5,
            declined: true,
          }),
        },
        { kind: "agui", event: stepStarted("turn 2") },
        { kind: "agui", event: textStart("a-9c-2", "assistant") },
        { kind: "agui", event: textDelta("a-9c-2", "Understood — I didn't create that reminder.") },
        { kind: "agui", event: textEnd("a-9c-2") },
        { kind: "agui", event: stepFinished("turn 2") },
        { kind: "agui", event: runFinishedSuccess("run-9c-2") },
      ];

      const resolveToolKind = (name: string): "read" | "write" =>
        name === "reminders_create" ? "write" : "read";

      const result = replayAndCompare(steps, {
        translator: {
          resolveToolKind,
          resolveApproval: () => approvalContext,
        },
        hydrate: {
          resolveToolKind,
          approvalsByToolCallId: new Map([["tc-decl", hydratedDeclined]]),
        },
      });

      expect(result.emitted.find((e) => e.type === "settled")).toEqual({
        type: "settled",
        decisionId: "dec-9c",
        outcome: "declined",
      });
      expect(result.liveTurns).toEqual(result.hydratedTurns);
      expect(result.hydratedTurns[1]).toMatchObject({
        by: "agent",
        body: "Understood — I didn't create that reminder.",
        calls: [
          { name: "reminders.create", arg: "Cancel gym", kind: "write", ok: false, duration: "5ms" },
        ],
        approval: { decisionId: "dec-9c", state: "dismissed" },
      });
    });

    test("9d: user cancel (RUN_FINISHED(cancelled)) emits cancelled, omits message, and closes snapshot", () => {
      const steps: TimelineStep[] = [
        { kind: "agui", event: runStarted("run-9d") },
        ...openingMessage("u-9d", "user", "Do a long search.").map(
          (event): TimelineStep => ({ kind: "agui", event }),
        ),
        { kind: "agui", event: stepStarted("turn 1") },
        { kind: "agui", event: textStart("a-9d", "assistant") },
        { kind: "agui", event: textDelta("a-9d", "Starting search...") },
        { kind: "agui", event: textEnd("a-9d") },
        { kind: "agui", event: stepFinished("turn 1") },
        ...toolCallStartSeq("tc-cancel", "web_search", "a-9d", { query: "long query" }).map(
          (event): TimelineStep => ({ kind: "agui", event }),
        ),
        // TurnEncoder.cancel() closes open calls with error: "not run", then emits cancelled.
        {
          kind: "agui",
          event: toolCallResult("tc-cancel", "Not run: the turn ended first.", {
            error: "not run",
          }),
        },
        { kind: "agui", event: runFinishedCancelled("run-9d") },
      ];

      const result = replayAndCompare(steps);

      expect(result.emitted.some((e) => e.type === "cancelled")).toBe(true);
      expect(result.emitted.some((e) => e.type === "message")).toBe(false);
      expect(result.finalSnapshot).toBeNull();
    });

    test("9e: fatal RUN_ERROR emits error, sets live.error via apply(), and leaves no running tools or open approvals", () => {
      const steps: TimelineStep[] = [
        { kind: "agui", event: runStarted("run-9e") },
        ...openingMessage("u-9e", "user", "Run impossible request.").map(
          (event): TimelineStep => ({ kind: "agui", event }),
        ),
        { kind: "agui", event: stepStarted("turn 1") },
        { kind: "agui", event: textStart("a-9e", "assistant") },
        { kind: "agui", event: textDelta("a-9e", "Attempting...") },
        { kind: "agui", event: textEnd("a-9e") },
        { kind: "agui", event: stepFinished("turn 1") },
        ...toolCallStartSeq("tc-err", "okf_read", "a-9e", { id: "okf:x" }).map(
          (event): TimelineStep => ({ kind: "agui", event }),
        ),
        {
          kind: "agui",
          event: toolCallResult("tc-err", "Not run: the turn ended first.", { error: "not run" }),
        },
        { kind: "agui", event: runError("All model routes exhausted", "ROUTE_EXHAUSTED") },
      ];

      const result = replayAndCompare(steps);

      const errorEvent = result.emitted.find(
        (e): e is Extract<ChatEvent, { type: "error" }> => e.type === "error",
      );
      expect(errorEvent).toEqual({
        type: "error",
        message: "All model routes exhausted",
      });
      expect(result.emitted.some((e) => e.type === "message")).toBe(false);
      expect(result.finalLive?.error).toBe("All model routes exhausted");

      // Snapshot must either be cleared (null) or hold terminal error with no dangling running tools/pending approval.
      if (result.finalSnapshot !== null) {
        expect(result.finalSnapshot.error).toBe("All model routes exhausted");
        expect(result.finalSnapshot.pending).toBeNull();
        expect(result.finalSnapshot.calls.some((c) => c.status === "running")).toBe(false);
      }
    });
  });

  test("Voice metadata provenance: hydrateTurnsFromThread stamps source: 'voice' from solenoid metadata", () => {
    const voiceThread: Message[] = [
      {
        id: "vu-1",
        role: "user",
        content: "Set a timer for five minutes.",
        metadata: { [SOLENOID_METADATA_KEY]: { source: "voice" } },
      } as Message,
      {
        id: "va-1",
        role: "assistant",
        content: "Timer set for five minutes.",
        metadata: { [SOLENOID_METADATA_KEY]: { source: "voice" } },
      } as Message,
    ];

    const hydrated = hydrateTurnsFromThread(voiceThread, { now: FIXED_NOW });
    expect(hydrated).toHaveLength(2);
    expect(hydrated[0]).toMatchObject({
      by: "user",
      body: "Set a timer for five minutes.",
      source: "voice",
    });
    expect(hydrated[1]).toMatchObject({
      by: "agent",
      body: "Timer set for five minutes.",
      source: "voice",
    });
  });

  test("Persisted reasoning: hydrates multi-step reasoning blocks and preserves surviving thoughts across mid-step retry", () => {
    const steps: TimelineStep[] = [
      { kind: "agui", event: runStarted("run-reason") },
      ...openingMessage("u-r", "user", "Compare options.").map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepStarted("turn 1") },
      ...reasoningEvents("r-step-1", ["Step 1 thought."]).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepFinished("turn 1") },
      ...toolCallStartSeq("tc-r1", "okf_read", "a-r1", { id: "okf:note/a" }).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: toolCallResult("tc-r1", '{"ok":true}', { durationMs: 50 }) },
      { kind: "mark", label: "afterStep1" },
      { kind: "agui", event: stepStarted("turn 2") },
      ...reasoningEvents("r-discarded", ["Discarded retry thought."]).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepFinished("turn 2") },
      { kind: "agui", event: customRetry("503", 100) },
      { kind: "snapshot_to", label: "afterStep1" },
      { kind: "agui", event: stepStarted("turn 2") },
      ...reasoningEvents("r-step-2", ["Step 2 final thought."]).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: textStart("a-r2", "assistant") },
      { kind: "agui", event: textDelta("a-r2", "Here is the comparison.") },
      { kind: "agui", event: textEnd("a-r2") },
      { kind: "agui", event: stepFinished("turn 2") },
      { kind: "agui", event: runFinishedSuccess("run-reason") },
    ];

    const result = replayAndCompare(steps);
    const resetEvent = result.emitted.find(
      (e): e is Extract<ChatEvent, { type: "reset" }> => e.type === "reset",
    );
    expect(resetEvent?.live.streamingReasoning).toBe("Step 1 thought.");

    const msgEvent = result.emitted.find(
      (e): e is Extract<ChatEvent, { type: "message" }> => e.type === "message",
    );
    expect(msgEvent?.reasoning).toBe("Step 1 thought.\n\nStep 2 final thought.");

    const hydrated = hydrateTurnsFromThread(result.thread, { now: FIXED_NOW });
    expect(hydrated[1]?.reasoning).toBe("Step 1 thought.\n\nStep 2 final thought.");
  });

  test("OPEN_SKILL parity: emits opened 'skill:<slug>', formats 'opened skill <slug>' in note, and excludes open_skill from calls", () => {
    const steps: TimelineStep[] = [
      { kind: "agui", event: runStarted("run-skill") },
      ...openingMessage("u-sk", "user", "Help me create a morning briefing skill.").map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepStarted("turn 1") },
      ...toolCallStartSeq("tc-sk-1", OPEN_SKILL, "a-sk-1", { skill: "create-skill" }).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      {
        kind: "agui",
        event: toolCallResult("tc-sk-1", "# Skill: create-skill\nFollow these steps.", {
          durationMs: 4,
        }),
      },
      { kind: "agui", event: stepFinished("turn 1") },
      { kind: "agui", event: stepStarted("turn 2") },
      ...toolCallStartSeq("tc-sk-2", "skills_list", "a-sk-2", {}).map(
        (event): TimelineStep => ({ kind: "agui", event }),
      ),
      {
        kind: "agui",
        event: toolCallResult("tc-sk-2", '{"skills":[]}', { durationMs: 12 }),
      },
      { kind: "agui", event: textStart("a-sk-3", "assistant") },
      { kind: "agui", event: textDelta("a-sk-3", "Let's design your morning briefing skill.") },
      { kind: "agui", event: textEnd("a-sk-3") },
      { kind: "agui", event: stepFinished("turn 2") },
      { kind: "agui", event: runFinishedSuccess("run-skill") },
    ];

    const result = replayAndCompare(steps);
    const openedEvent = result.emitted.find(
      (e): e is Extract<ChatEvent, { type: "opened" }> => e.type === "opened",
    );
    expect(openedEvent).toEqual({ type: "opened", group: "skill:create-skill" });

    expect(result.liveTurns).toEqual(result.hydratedTurns);
    expect(result.hydratedTurns[1]).toMatchObject({
      by: "agent",
      body: "Let's design your morning briefing skill.",
      note: "opened skill create-skill",
      calls: [{ name: "skills.list", arg: null, kind: "read", ok: true, duration: "12ms" }],
    });
  });
});
