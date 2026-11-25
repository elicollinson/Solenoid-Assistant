// Tier 2 — Arbitrary SSE Cut-Point Reconnects for AgUiToChatEventTranslator.
//
// For 5 multi-step recorded AG-UI streams (streaming + tools, approval interrupt +
// resume, mid-step retry + snapshot, multi-turn route fallback + snapshot, and
// subagent spawn + async onAutoTurn), disconnects the SSE subscriber at EVERY
// single event index `i` from `0` through `N`, re-hydrates client state from
// `hydrateTurnsFromThread()` + `translator.snapshot()` (as `GET /api/chat/:id` +
// SSE `snapshot` frame does), replays remaining events `i..N-1` through
// `web/src/app/chat.ts`'s `apply()`, and proves:
//   - zero duplicate user/agent bubbles
//   - zero duplicate tool call entries
//   - zero orphaned open approvals
//   - mid-flight `snapshot()` matches uninterrupted `live` state
//   - identical final rendered state to an uninterrupted stream!
import { describe, expect, test } from "bun:test";
import { type AGUIEvent, EventType, type Message } from "@ag-ui/core";
import {
  APPROVAL_REASON,
  CUSTOM_EVENTS,
  OPEN_TOOL_GROUP,
  SOLENOID_METADATA_KEY,
  applyEvent,
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
  LiveTurnSnapshot,
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
  echoed: (chat: {
    stored: readonly Pick<ChatTurnRow, "by" | "body">[];
    live: LiveTurn | null;
  }) => boolean;
}

const WEB_CHAT_MODULE_URL = new URL("../../web/src/app/chat.ts", import.meta.url).href;
const webChat = (await import(WEB_CHAT_MODULE_URL)) as WebChatModule;
const { apply, EMPTY_LIVE_TURN, echoed } = webChat;

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
// Deterministic AG-UI 1.0 Event Builders
// ---------------------------------------------------------------------------

const THREAD_ID = "thread-cut-1";
const FIXED_NOW = new Date("2026-11-24T16:00:00.000Z");

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

const reasoningSeq = (messageId: string, chunks: readonly string[]): AGUIEvent[] => [
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

const openingSeq = (
  messageId: string,
  role: "user" | "developer",
  text: string,
): AGUIEvent[] => [textStart(messageId, role), textDelta(messageId, text), textEnd(messageId)];

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
// Cut-Point Simulation Engine
// ---------------------------------------------------------------------------

type ScriptStep =
  | { kind: "agui"; event: AGUIEvent }
  | { kind: "settle"; decisionId: string; outcome: ApprovalOutcome }
  | { kind: "deferred"; event: Extract<ChatEvent, { type: "deferred_approval" }> }
  | { kind: "mark"; label: string }
  | { kind: "snapshot_to"; label: string };

type ConcreteStep =
  | { kind: "agui"; event: AGUIEvent }
  | { kind: "settle"; decisionId: string; outcome: ApprovalOutcome }
  | { kind: "deferred"; event: Extract<ChatEvent, { type: "deferred_approval" }> };

interface RenderedCall {
  name: string;
  arg: string | null;
  kind: "read" | "write";
  ok: boolean;
  duration: string;
}

interface RenderedTurn {
  by: "user" | "agent";
  body: string;
  source: "text" | "voice" | "subagent";
  note: string | null;
  toolSummary: string | null;
  calls: RenderedCall[];
}

function normalizeRow(row: ChatTurnRow): RenderedTurn {
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
  };
}

function cloneLive(live: LiveTurn | null): LiveTurn | null {
  if (!live) return null;
  return {
    ...live,
    said: [...live.said],
    calls: live.calls.map((c) => ({ ...c })),
    opened: [...live.opened],
    deferredApprovals: [...(live.deferredApprovals ?? [])],
    activeSubagents: [...(live.activeSubagents ?? [])],
  };
}

/** Materializes mark/snapshot_to directives into a concrete AG-UI timeline. */
function materialize(script: readonly ScriptStep[]): ConcreteStep[] {
  const out: ConcreteStep[] = [];
  let thread: Message[] = [];
  const marks = new Map<string, number>();

  for (const step of script) {
    if (step.kind === "mark") {
      marks.set(step.label, thread.length);
    } else if (step.kind === "snapshot_to") {
      const len = marks.get(step.label);
      if (len === undefined) throw new Error(`Unknown mark "${step.label}"`);
      const ev: AGUIEvent = {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: thread.slice(0, len),
      };
      thread = applyEvent(thread, ev);
      out.push({ kind: "agui", event: ev });
    } else if (step.kind === "agui") {
      thread = applyEvent(thread, step.event);
      out.push(step);
    } else {
      out.push(step);
    }
  }
  return out;
}

interface ClientState {
  turns: RenderedTurn[];
  live: LiveTurn | null;
}

function foldClientEvent(state: ClientState, ev: ChatEvent): void {
  if (ev.type === "turn_start") {
    state.live = freshLiveTurn({
      turnId: ev.turnId,
      asked: ev.asked,
      source: ev.source,
    });
    return;
  }
  if (ev.type === "snapshot") {
    state.live = ev.live ? apply(freshLiveTurn(), ev) : null;
    return;
  }
  if (ev.type === "message") {
    const source = ev.source ?? state.live?.source ?? "text";
    if (
      source !== "subagent" &&
      state.live &&
      state.live.asked &&
      !echoed({ stored: state.turns, live: state.live })
    ) {
      state.turns.push({
        by: "user",
        body: state.live.asked,
        source: "text",
        note: null,
        toolSummary: null,
        calls: [],
      });
    }
    state.turns.push({
      by: "agent",
      body: ev.body,
      source,
      note: ev.note,
      toolSummary: ev.toolSummary,
      calls: (state.live?.calls ?? []).map((c) => ({
        name: c.name,
        arg: c.arg,
        kind: c.kind,
        ok: c.ok,
        duration: c.duration,
      })),
    });
    state.live = null;
    return;
  }
  if (ev.type === "cancelled") {
    if (state.live) state.live = apply(state.live, ev);
    state.live = null;
    return;
  }
  state.live = apply(state.live ?? freshLiveTurn(), ev);
}

function pushConcreteStep(
  translator: AgUiToChatEventTranslator,
  step: ConcreteStep,
): ChatEvent[] {
  if (step.kind === "agui") return translator.push(step.event);
  if (step.kind === "settle") return translator.onApprovalSettled(step.decisionId, step.outcome);
  return translator.onDeferredApproval(step.event);
}

function assertSnapshotMatchesLive(
  snap: LiveTurnSnapshot,
  live: LiveTurn,
  cut: number,
  scenarioName: string,
): void {
  const ctx = `[${scenarioName} @ cut=${cut}]`;
  expect(snap.asked, `${ctx} asked`).toBe(live.asked);
  expect(snap.source, `${ctx} source`).toBe(live.source ?? "text");
  expect(snap.said, `${ctx} said`).toEqual(live.said);
  expect(snap.streamingText, `${ctx} streamingText`).toBe(live.streamingText ?? "");
  expect(snap.streamingReasoning, `${ctx} streamingReasoning`).toBe(
    live.streamingReasoning ?? "",
  );
  expect(snap.opened, `${ctx} opened`).toEqual(live.opened);
  expect(snap.pending?.decisionId ?? null, `${ctx} pending.decisionId`).toBe(
    live.pending?.decisionId ?? null,
  );
  expect(
    snap.deferredApprovals.map((d) => d.decisionId),
    `${ctx} deferredApprovals`,
  ).toEqual((live.deferredApprovals ?? []).map((d) => d.decisionId));
  expect(snap.error, `${ctx} error`).toBe(live.error);
  expect(
    snap.calls.map((c) => ({
      id: c.id,
      name: c.name,
      arg: c.arg,
      kind: c.kind,
      ok: c.ok,
      duration: c.duration,
      status: c.status,
    })),
    `${ctx} calls`,
  ).toEqual(
    live.calls.map((c) => ({
      id: c.id,
      name: c.name,
      arg: c.arg,
      kind: c.kind,
      ok: c.ok,
      duration: c.duration,
      status: c.status,
    })),
  );
}

function assertNoDuplicateCallIds(calls: readonly ChatToolCall[], context: string): void {
  const seenIds = new Set<string>();
  for (const call of calls) {
    if (!call.id) continue;
    expect(seenIds.has(call.id), `${context}: duplicate tool call id "${call.id}"`).toBe(false);
    seenIds.add(call.id);
  }
}

interface CutPointScenarioConfig {
  name: string;
  script: ScriptStep[];
  translatorOptions?: TranslatorOptions;
  hydrateOptionsAt?: (stepIndex: number) => HydrateTurnsOptions;
  /** Optional expected open approval window [startInclusive, endExclusive) by concrete step index. */
  expectedOpenApprovalWindow?: {
    decisionId: string;
    toolCallId: string;
    isOpenAt: (stepIndex: number, steps: readonly ConcreteStep[]) => boolean;
  };
}

/**
 * Runs the exhaustive cut-point harness across EVERY `cut ∈ [0, N]` for `config`.
 */
function verifyAllCutPoints(config: CutPointScenarioConfig): { cutCount: number; turns: RenderedTurn[] } {
  const steps = materialize(config.script);
  const N = steps.length;

  // 1. Run uninterrupted reference client + track exact thread & completed-turn boundaries.
  const refTranslator = new AgUiToChatEventTranslator(config.translatorOptions);
  const refClient: ClientState = { turns: [], live: null };

  const threadAt: Message[][] = [[]];
  const completedThreadAt: Message[][] = [[]];
  const refLiveAt: Array<LiveTurn | null> = [null];
  const turnOpenAt: boolean[] = [false];

  let thread: Message[] = [];
  let lastCompletedThread: Message[] = [];
  let inFlightTurn = false;

  for (let idx = 0; idx < N; idx++) {
    const step = steps[idx]!;
    if (step.kind === "agui") {
      thread = applyEvent(thread, step.event);
      if (step.event.type === EventType.RUN_STARTED) {
        inFlightTurn = true;
      }
    }

    const emitted = pushConcreteStep(refTranslator, step);
    for (const ev of emitted) foldClientEvent(refClient, ev);

    if (
      step.kind === "agui" &&
      ((step.event.type === EventType.RUN_FINISHED &&
        step.event.outcome?.type !== "interrupt") ||
        step.event.type === EventType.RUN_ERROR)
    ) {
      inFlightTurn = false;
      lastCompletedThread = [...thread];
    }

    threadAt.push([...thread]);
    completedThreadAt.push(inFlightTurn ? [...lastCompletedThread] : [...thread]);
    refLiveAt.push(cloneLive(refClient.live));
    turnOpenAt.push(inFlightTurn);
  }

  expect(refClient.live, `[${config.name}] uninterrupted client must finish idle`).toBeNull();
  expect(refTranslator.snapshot(), `[${config.name}] uninterrupted translator must finish null`).toBeNull();

  // Verify uninterrupted live turns match final checkpoint hydration.
  const finalHydrateOpts: HydrateTurnsOptions = {
    now: FIXED_NOW,
    resolveToolKind: config.translatorOptions?.resolveToolKind,
    ...(config.hydrateOptionsAt ? config.hydrateOptionsAt(N) : {}),
  };
  const refHydrated = hydrateTurnsFromThread(threadAt[N]!, finalHydrateOpts).map(normalizeRow);
  expect(refClient.turns, `[${config.name}] reference live vs hydrated`).toEqual(refHydrated);

  // 2. Simulate disconnecting & reconnecting at EVERY single index cut ∈ [0, N].
  for (let cut = 0; cut <= N; cut++) {
    const serverTranslator = new AgUiToChatEventTranslator(config.translatorOptions);
    for (let k = 0; k < cut; k++) {
      pushConcreteStep(serverTranslator, steps[k]!);
    }

    const snapAtCut = serverTranslator.snapshot();
    const hydrateOptsAtCut: HydrateTurnsOptions = {
      now: FIXED_NOW,
      resolveToolKind: config.translatorOptions?.resolveToolKind,
      ...(config.hydrateOptionsAt ? config.hydrateOptionsAt(cut) : {}),
    };

    // (a) Mid-turn checkpoint hydration at cut point must never throw or duplicate tool calls.
    const rawHydratedAtCut = hydrateTurnsFromThread(threadAt[cut]!, hydrateOptsAtCut);
    for (const row of rawHydratedAtCut) {
      assertNoDuplicateCallIds(row.calls, `${config.name} hydrated@${cut}`);
    }

    // (b) Approval open/closed window invariants right at cut point.
    if (config.expectedOpenApprovalWindow) {
      const { decisionId, isOpenAt } = config.expectedOpenApprovalWindow;
      const shouldBeOpen = isOpenAt(cut, steps);
      if (shouldBeOpen) {
        expect(snapAtCut?.pending?.decisionId, `[${config.name} @ cut=${cut}] pending open`).toBe(
          decisionId,
        );
        const openHydrated = rawHydratedAtCut.find((r) => r.approval?.decisionId === decisionId);
        expect(openHydrated?.approval?.state, `[${config.name} @ cut=${cut}] hydrated open`).toBe(
          "open",
        );
      } else {
        expect(snapAtCut?.pending ?? null, `[${config.name} @ cut=${cut}] no orphaned approval`).toBeNull();
      }
    } else {
      expect(snapAtCut?.pending ?? null, `[${config.name} @ cut=${cut}] no unexpected approval`).toBeNull();
    }

    // (c) Mid-flight snapshot invariants & lockstep match against uninterrupted client.
    if (snapAtCut !== null) {
      assertNoDuplicateCallIds(snapAtCut.calls, `${config.name} snapshot@${cut}`);
      expect(
        new Set(snapAtCut.opened).size,
        `[${config.name} @ cut=${cut}] no duplicate opened groups`,
      ).toBe(snapAtCut.opened.length);

      const expectedLive = refLiveAt[cut];
      if (expectedLive != null) {
        assertSnapshotMatchesLive(snapAtCut, expectedLive, cut, config.name);
      }
    }

    // (d) Re-hydrate fresh client from GET /api/chat/:id + SSE `snapshot` frame,
    //     then replay remaining events cut..N-1 through `apply()`.
    const storedSourceThread = turnOpenAt[cut] ? completedThreadAt[cut]! : threadAt[cut]!;
    const reconnected: ClientState = {
      turns: hydrateTurnsFromThread(storedSourceThread, hydrateOptsAtCut).map(normalizeRow),
      live: null,
    };
    foldClientEvent(reconnected, { type: "snapshot", live: snapAtCut });

    for (let k = cut; k < N; k++) {
      const emitted = pushConcreteStep(serverTranslator, steps[k]!);
      for (const ev of emitted) foldClientEvent(reconnected, ev);
    }

    // (e) Assert zero duplicates, zero orphaned approvals, and IDENTICAL final state!
    expect(reconnected.live, `[${config.name} @ cut=${cut}] final live null`).toBeNull();
    expect(serverTranslator.snapshot(), `[${config.name} @ cut=${cut}] final snapshot null`).toBeNull();
    expect(
      reconnected.turns.filter((t) => t.by === "user").length,
      `[${config.name} @ cut=${cut}] user bubble count`,
    ).toBe(refClient.turns.filter((t) => t.by === "user").length);
    expect(
      reconnected.turns.filter((t) => t.by === "agent").length,
      `[${config.name} @ cut=${cut}] agent bubble count`,
    ).toBe(refClient.turns.filter((t) => t.by === "agent").length);
    expect(reconnected.turns, `[${config.name} @ cut=${cut}] final rendered state`).toEqual(
      refClient.turns,
    );
  }

  return { cutCount: N + 1, turns: refClient.turns };
}

// ---------------------------------------------------------------------------
// Tier 2 Cut-Point Suites (5 Multi-Step Scenarios)
// ---------------------------------------------------------------------------

describe("Tier 2 — Arbitrary SSE Cut-Point Reconnects (every index i ∈ [0, N])", () => {
  test("1. Streaming + reasoning + open_tool_group + multi-step tools reconnects cleanly at every index", () => {
    const script: ScriptStep[] = [
      { kind: "agui", event: runStarted("cut-r1") },
      ...openingSeq("u-c1", "user", "Check reminders and notes on Ferris.").map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepStarted("turn 1") },
      ...reasoningSeq("r-c1-1", ["Open reminders ", "and search notes."]).map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: textStart("a-c1-1", "assistant") },
      { kind: "agui", event: textDelta("a-c1-1", "Let me check ") },
      { kind: "agui", event: textDelta("a-c1-1", "your reminders and notes.") },
      { kind: "agui", event: textEnd("a-c1-1") },
      { kind: "agui", event: stepFinished("turn 1") },
      ...toolStartSeq("tc-open-rem", OPEN_TOOL_GROUP, "a-c1-1", { group: "reminders" }).map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      ...toolStartSeq("tc-okf-1", "okf_read", "a-c1-1", { id: "okf:contact/ferris" }).map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: toolResult("tc-open-rem", "Briefing: reminders", { durationMs: 3 }) },
      { kind: "agui", event: toolResult("tc-okf-1", "Ferris note", { durationMs: 140 }) },
      { kind: "agui", event: stepStarted("turn 2") },
      { kind: "agui", event: stepFinished("turn 2") },
      ...toolStartSeq("tc-rem-1", "reminders_list", "a-c1-2", { query: "Ferris" }).map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      ...toolStartSeq("tc-okf-2", "okf_read", "a-c1-2", { id: "okf:policy/ferris-hold" }).map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: toolResult("tc-rem-1", "1 reminder", { durationMs: 85 }) },
      { kind: "agui", event: toolResult("tc-okf-2", "Hold active", { durationMs: 1200 }) },
      { kind: "agui", event: stepStarted("turn 3") },
      { kind: "agui", event: textStart("a-c1-3", "assistant") },
      { kind: "agui", event: textDelta("a-c1-3", "Ferris has one reminder ") },
      { kind: "agui", event: textDelta("a-c1-3", "and an active hold.") },
      { kind: "agui", event: textEnd("a-c1-3") },
      { kind: "agui", event: stepFinished("turn 3") },
      { kind: "agui", event: runFinishedSuccess("cut-r1") },
    ];

    const { cutCount, turns } = verifyAllCutPoints({
      name: "streaming+tools",
      script,
    });
    expect(cutCount).toBeGreaterThan(30);
    expect(turns[1]?.note).toBe("opened reminders");
    expect(turns[1]?.toolSummary).toBe("3 tool calls · okf.read ×2, reminders.list");
  });

  test("2. Approval interrupt + settlement + resume reconnects cleanly at every index (including mid-wait and post-settle)", () => {
    const choices: ChatChoice[] = [
      { id: "cut-allow", label: "Go ahead", stance: "affirm" },
      { id: "cut-deny", label: "Not this one", stance: "quiet" },
    ];
    const facts: ChatFact[] = [
      ["Call", "reminders.create"],
      ["title", "Order espresso beans"],
    ];
    const approvalCtx: TranslatorApprovalContext = {
      decisionId: "dec-cut-2",
      ref: "ap/1124-20",
      title: "I'll add a reminder to order espresso beans.",
      why: "Create a reminder.",
      hold: "Nothing has been written.",
      tool: "reminders.create",
      facts,
      actions: choices,
    };
    const makeHydratedApproval = (state: "open" | "resolved"): ChatApproval => ({
      decisionId: "dec-cut-2",
      ref: "ap/1124-20",
      title: "I'll add a reminder to order espresso beans.",
      why: "Create a reminder.",
      hold: "Nothing has been written.",
      facts: facts.map(([k, v]) => [k, v]),
      choices,
      state,
      chosenId: state === "resolved" ? "cut-allow" : null,
      settled:
        state === "resolved"
          ? 'You said "Go ahead", 16:00. reminders.create ran and finished.'
          : null,
    });

    const script: ScriptStep[] = [
      { kind: "agui", event: runStarted("cut-r2-a") },
      ...openingSeq("u-c2", "user", "Remind me to order espresso beans.").map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: textStart("a-c2-1", "assistant") },
      { kind: "agui", event: textDelta("a-c2-1", "I'll add a reminder to order espresso beans.") },
      { kind: "agui", event: textEnd("a-c2-1") },
      { kind: "agui", event: stepFinished("turn 1") },
      ...toolStartSeq("tc-cut-write", "reminders_create", "a-c2-1", {
        title: "Order espresso beans",
      }).map((event): ScriptStep => ({ kind: "agui", event })),
      {
        kind: "agui",
        event: runFinishedInterrupt(
          "cut-r2-a",
          "approval:tc-cut-write",
          "tc-cut-write",
          "Allow reminders_create?",
        ),
      },
      { kind: "settle", decisionId: "dec-cut-2", outcome: "approved" },
      { kind: "agui", event: runStarted("cut-r2-b") },
      { kind: "agui", event: toolResult("tc-cut-write", '{"id":"r-42"}', { durationMs: 260 }) },
      { kind: "agui", event: stepStarted("turn 2") },
      { kind: "agui", event: textStart("a-c2-2", "assistant") },
      { kind: "agui", event: textDelta("a-c2-2", "Added ") },
      { kind: "agui", event: textDelta("a-c2-2", "your espresso beans reminder.") },
      { kind: "agui", event: textEnd("a-c2-2") },
      { kind: "agui", event: stepFinished("turn 2") },
      { kind: "agui", event: runFinishedSuccess("cut-r2-b") },
    ];

    const resolveToolKind = (name: string): "read" | "write" =>
      name === "reminders_create" ? "write" : "read";

    const concreteSteps = materialize(script);
    const interruptIdx = concreteSteps.findIndex(
      (s) =>
        s.kind === "agui" &&
        s.event.type === EventType.RUN_FINISHED &&
        s.event.outcome?.type === "interrupt",
    );
    const settleIdx = concreteSteps.findIndex((s) => s.kind === "settle");

    const { cutCount, turns } = verifyAllCutPoints({
      name: "approval+resume",
      script,
      translatorOptions: {
        resolveToolKind,
        resolveApproval: () => approvalCtx,
      },
      hydrateOptionsAt: (cut) => ({
        resolveToolKind,
        approvalsByToolCallId:
          cut > interruptIdx
            ? new Map([["tc-cut-write", makeHydratedApproval(cut > settleIdx ? "resolved" : "open")]])
            : undefined,
      }),
      expectedOpenApprovalWindow: {
        decisionId: "dec-cut-2",
        toolCallId: "tc-cut-write",
        isOpenAt: (cut) => cut > interruptIdx && cut <= settleIdx,
      },
    });
    expect(cutCount).toBeGreaterThan(20);
    expect(turns[1]?.calls).toEqual([
      {
        name: "reminders.create",
        arg: "Order espresso beans",
        kind: "write",
        ok: true,
        duration: "260ms",
      },
    ]);
  });

  test("3. Mid-step retry + MESSAGES_SNAPSHOT reconnects cleanly before, during, and after rollback", () => {
    const script: ScriptStep[] = [
      { kind: "agui", event: runStarted("cut-r3") },
      ...openingSeq("u-c3", "user", "Check today's mail.").map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: stepFinished("turn 1") },
      ...toolStartSeq("tc-c3-open", OPEN_TOOL_GROUP, "a-c3-1", { group: "mail" }).map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      ...toolStartSeq("tc-c3-list", "mail_list", "a-c3-1", { query: "today" }).map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: toolResult("tc-c3-open", "Briefing: mail", { durationMs: 2 }) },
      { kind: "agui", event: toolResult("tc-c3-list", '["msg-1"]', { durationMs: 175 }) },
      { kind: "mark", label: "step2" },
      // Failed attempt on Step 2 -> rolled back via retry + MESSAGES_SNAPSHOT.
      { kind: "agui", event: stepStarted("turn 2") },
      ...reasoningSeq("r-c3-bad", ["Hallucinated ", "discarded reasoning"]).map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: textStart("a-c3-bad", "assistant") },
      { kind: "agui", event: textDelta("a-c3-bad", "Truncated bad ") },
      { kind: "agui", event: textDelta("a-c3-bad", "output...") },
      { kind: "agui", event: textEnd("a-c3-bad") },
      { kind: "agui", event: stepFinished("turn 2") },
      {
        kind: "agui",
        event: {
          type: EventType.CUSTOM,
          name: CUSTOM_EVENTS.retry,
          value: { error: "502 bad gateway", delayMs: 250 },
        },
      },
      { kind: "snapshot_to", label: "step2" },
      // Successful retry on Step 2.
      { kind: "agui", event: stepStarted("turn 2") },
      { kind: "agui", event: textStart("a-c3-good", "assistant") },
      { kind: "agui", event: textDelta("a-c3-good", "You have ") },
      { kind: "agui", event: textDelta("a-c3-good", "one email today.") },
      { kind: "agui", event: textEnd("a-c3-good") },
      { kind: "agui", event: stepFinished("turn 2") },
      { kind: "agui", event: runFinishedSuccess("cut-r3") },
    ];

    const { cutCount, turns } = verifyAllCutPoints({
      name: "mid-step-retry",
      script,
    });
    expect(cutCount).toBeGreaterThan(25);
    expect(turns[1]?.body).toBe("You have one email today.");
    expect(turns[1]?.note).toBe("opened mail");
  });

  test("4. Multi-turn route fallback + MESSAGES_SNAPSHOT reconnects cleanly at every index without cross-turn bleed", () => {
    const script: ScriptStep[] = [
      // Completed Turn 1.
      { kind: "agui", event: runStarted("cut-r4-t1") },
      ...openingSeq("u-c4-1", "user", "Hi there.").map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: textStart("a-c4-1", "assistant") },
      { kind: "agui", event: textDelta("a-c4-1", "Hello!") },
      { kind: "agui", event: textEnd("a-c4-1") },
      { kind: "agui", event: stepFinished("turn 1") },
      { kind: "agui", event: runFinishedSuccess("cut-r4-t1") },

      // Turn 2: fails on Route 1 after opening weather & running weather_get, rolls back to turn2Start.
      { kind: "agui", event: runStarted("cut-r4-t2") },
      ...openingSeq("u-c4-2", "user", "Read my daily brief.").map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      { kind: "mark", label: "turn2Start" },
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: textStart("a-c4-r1", "assistant") },
      { kind: "agui", event: textDelta("a-c4-r1", "Route 1 trying weather.") },
      { kind: "agui", event: textEnd("a-c4-r1") },
      { kind: "agui", event: stepFinished("turn 1") },
      ...toolStartSeq("tc-r1-open", OPEN_TOOL_GROUP, "a-c4-r1", { group: "weather" }).map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      ...toolStartSeq("tc-r1-wx", "weather_get", "a-c4-r1", { query: "Boston" }).map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: toolResult("tc-r1-open", "Briefing: weather", { durationMs: 2 }) },
      { kind: "agui", event: toolResult("tc-r1-wx", "68F", { durationMs: 190 }) },
      {
        kind: "agui",
        event: {
          type: EventType.CUSTOM,
          name: CUSTOM_EVENTS.routeAdvanced,
          value: {
            from: { provider: "omlx", model: "local-1" },
            to: { provider: "openrouter", model: "fallback-1" },
            error: "provider stalled",
          },
        },
      },
      { kind: "snapshot_to", label: "turn2Start" },

      // Route 2 succeeds cleanly with okf_read.
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: stepFinished("turn 1") },
      ...toolStartSeq("tc-r2-okf", "okf_read", "a-c4-r2-1", { id: "okf:brief/daily" }).map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: toolResult("tc-r2-okf", "All clear.", { durationMs: 95 }) },
      { kind: "agui", event: stepStarted("turn 2") },
      { kind: "agui", event: textStart("a-c4-r2-2", "assistant") },
      { kind: "agui", event: textDelta("a-c4-r2-2", "Daily brief: all clear.") },
      { kind: "agui", event: textEnd("a-c4-r2-2") },
      { kind: "agui", event: stepFinished("turn 2") },
      { kind: "agui", event: runFinishedSuccess("cut-r4-t2") },
    ];

    const { cutCount, turns } = verifyAllCutPoints({
      name: "route-fallback",
      script,
    });
    expect(cutCount).toBeGreaterThan(35);
    expect(turns).toHaveLength(4);
    expect(turns[3]?.note).toBeNull();
    expect(turns[3]?.toolSummary).toBe("1 tool call · okf.read");
  });

  test("5. Subagent spawn + parent turn + async onAutoTurn reconnects cleanly across turn boundaries", () => {
    const script: ScriptStep[] = [
      // Turn 1: parent user turn spawns background subagent.
      { kind: "agui", event: runStarted("cut-r5-parent") },
      ...openingSeq("u-c5", "user", "Compare hotel rates in the background.").map(
        (event): ScriptStep => ({ kind: "agui", event }),
      ),
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: stepFinished("turn 1") },
      ...toolStartSeq("tc-c5-spawn", "spawn_subagent", "a-c5-1", {
        name: "hotels",
        task: "Compare hotel rates in Chicago",
      }).map((event): ScriptStep => ({ kind: "agui", event })),
      { kind: "agui", event: toolResult("tc-c5-spawn", '{"id":"sa-1"}', { durationMs: 11 }) },
      { kind: "agui", event: stepStarted("turn 2") },
      { kind: "agui", event: textStart("a-c5-2", "assistant") },
      { kind: "agui", event: textDelta("a-c5-2", "Checking hotel rates in the background.") },
      { kind: "agui", event: textEnd("a-c5-2") },
      { kind: "agui", event: stepFinished("turn 2") },
      { kind: "agui", event: runFinishedSuccess("cut-r5-parent") },

      // Turn 2: async subagent auto-turn opens with `developer` message and streams synthesis.
      { kind: "agui", event: runStarted("cut-r5-auto") },
      ...openingSeq(
        "dev-c5",
        "developer",
        "Subagents finished: hotels (sa-1) done.\n\nhotels (sa-1) answered:\nBest rate is $185/night.",
      ).map((event): ScriptStep => ({ kind: "agui", event })),
      { kind: "agui", event: stepStarted("turn 1") },
      { kind: "agui", event: textStart("a-c5-syn", "assistant") },
      { kind: "agui", event: textDelta("a-c5-syn", "Hotel research finished: ") },
      { kind: "agui", event: textDelta("a-c5-syn", "the best rate is $185/night.") },
      { kind: "agui", event: textEnd("a-c5-syn") },
      { kind: "agui", event: stepFinished("turn 1") },
      { kind: "agui", event: runFinishedSuccess("cut-r5-auto") },
    ];

    const { cutCount, turns } = verifyAllCutPoints({
      name: "subagent-auto-turn",
      script,
    });
    expect(cutCount).toBeGreaterThan(25);
    expect(turns.map((t) => ({ by: t.by, source: t.source }))).toEqual([
      { by: "user", source: "text" },
      { by: "agent", source: "text" },
      { by: "agent", source: "subagent" },
    ]);
  });
});
