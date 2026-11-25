// Tier 4 — Seeded Property / Fuzz Invariants for AgUiToChatEventTranslator.
//
// Uses a deterministic Mulberry32 PRNG to generate 200 valid AG-UI 1.0 event
// sequences combining randomized mixes of:
//   - 1–3 consecutive turns (user & developer subagent auto-turns)
//   - 1–5 steps per turn
//   - reasoning deltas & text deltas (multi-chunk)
//   - 0–4 parallel tool calls per step (including `open_tool_group`, reads,
//     writes, multi-chunk args, out-of-order results, quarantined, malformed,
//     declined, and error outcomes)
//   - mid-step retries (`solenoid.retry` + genuine `MESSAGES_SNAPSHOT`)
//   - route fallbacks (`solenoid.route_advanced` + genuine `MESSAGES_SNAPSHOT`)
//   - approval interrupts + settlements + resumes
//   - deferred subagent approvals (`onDeferredApproval`)
//   - display `ACTIVITY_SNAPSHOT` and `solenoid.guardrail` events
//   - cancellations (`RUN_FINISHED(cancelled)`) and fatal `RUN_ERROR`s
//
// Asserts all 5 universal invariants on EVERY seed (1..200):
//   1. Translator never throws on any valid AG-UI sequence.
//   2. Every emitted `tool_end` has a matching prior `tool_start` with the same
//      `id` within the current non-reset epoch (and `open_tool_group` never
//      appears as a tool_start/tool_end).
//   3. Every emitted `reset` carries a structurally valid `LiveTurnSnapshot`
//      with zero stale calls or groups from rolled-back steps.
//   4. Every terminal event (`RUN_FINISHED(success|cancelled)` or `RUN_ERROR`)
//      cleanly closes the active turn with no dangling running tools or open
//      blocking `pending` approval.
//   5. Feeding every emitted `ChatEvent` into `web/src/app/chat.ts`'s `apply()`
//      never throws and preserves valid `LiveTurn` structure.
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
  ChatChoice,
  ChatEvent,
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
// Deterministic Mulberry32 PRNG
// ---------------------------------------------------------------------------

interface Rng {
  next(): number;
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
}

function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    chance(probability) {
      return next() < probability;
    },
    pick(items) {
      return items[Math.floor(next() * items.length)]!;
    },
    shuffle(items) {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = copy[i]!;
        copy[i] = copy[j]!;
        copy[j] = tmp;
      }
      return copy;
    },
  };
}

// ---------------------------------------------------------------------------
// Seeded Valid AG-UI Sequence Generator
// ---------------------------------------------------------------------------

const GROUPS = ["reminders", "calendar", "mail", "weather", "okf", "notes"] as const;
const READ_TOOLS = [
  "okf_read",
  "calendar_list",
  "mail_list",
  "imessage_list_conversations",
  "web_search",
  "weather_get",
] as const;
const WRITE_TOOLS = ["reminders_create", "calendar_create", "okf_write"] as const;
const WRITE_TOOL_SET = new Set<string>(WRITE_TOOLS);

const APPROVAL_CHOICES: ChatChoice[] = [
  { id: "fuzz-allow", label: "Go ahead", stance: "affirm" },
  { id: "fuzz-deny", label: "Not this one", stance: "quiet" },
];

type FuzzStep =
  | { kind: "agui"; event: AGUIEvent }
  | { kind: "settle"; decisionId: string; outcome: ApprovalOutcome }
  | { kind: "deferred"; event: Extract<ChatEvent, { type: "deferred_approval" }> };

interface GeneratedScenario {
  seed: number;
  steps: FuzzStep[];
  approvals: Map<string, TranslatorApprovalContext>;
  finalThread: Message[];
  stats: {
    turns: number;
    developerTurns: number;
    stepsRun: number;
    reasoningBlocks: number;
    toolCalls: number;
    openToolGroups: number;
    retries: number;
    routeAdvances: number;
    interrupts: number;
    deferredApprovals: number;
    activitySnapshots: number;
    cancellations: number;
    errors: number;
    successes: number;
  };
}

function splitIntoChunks(rng: Rng, text: string, maxChunks: number): string[] {
  const count = Math.min(maxChunks, Math.max(1, text.length));
  const target = rng.int(1, count);
  if (target <= 1 || text.length <= 1) return [text];
  const cuts = new Set<number>();
  while (cuts.size < target - 1) {
    cuts.add(rng.int(1, text.length - 1));
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = 0;
  for (const cut of sorted) {
    out.push(text.slice(prev, cut));
    prev = cut;
  }
  out.push(text.slice(prev));
  return out.filter((c) => c.length > 0);
}

function generateScenario(seed: number): GeneratedScenario {
  const rng = createRng(seed);
  const threadId = `fuzz-thread-${seed}`;
  const steps: FuzzStep[] = [];
  const approvals = new Map<string, TranslatorApprovalContext>();
  let thread: Message[] = [];
  let seq = 1;
  const nextId = (prefix: string) => `${prefix}-${seed}-${seq++}`;

  const stats: GeneratedScenario["stats"] = {
    turns: 0,
    developerTurns: 0,
    stepsRun: 0,
    reasoningBlocks: 0,
    toolCalls: 0,
    openToolGroups: 0,
    retries: 0,
    routeAdvances: 0,
    interrupts: 0,
    deferredApprovals: 0,
    activitySnapshots: 0,
    cancellations: 0,
    errors: 0,
    successes: 0,
  };

  const emitAgui = (event: AGUIEvent): void => {
    thread = applyEvent(thread, event);
    steps.push({ kind: "agui", event });
  };

  const turnCount = rng.int(1, 3);

  for (let t = 0; t < turnCount; t++) {
    stats.turns++;
    const role: "user" | "developer" = t === 0 ? "user" : rng.chance(0.4) ? "developer" : "user";
    if (role === "developer") stats.developerTurns++;

    let runId = nextId("run");
    emitAgui({ type: EventType.RUN_STARTED, threadId, runId });

    const openingId = nextId(role === "user" ? "u" : "dev");
    const openingText =
      role === "user"
        ? `User prompt ${seed}.${t}: check schedule & notes`
        : `Subagents finished: worker-${t} (sa-${t}) done.\n\nSummary for seed ${seed}.`;
    emitAgui({ type: EventType.TEXT_MESSAGE_START, messageId: openingId, role });
    for (const chunk of splitIntoChunks(rng, openingText, 3)) {
      emitAgui({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: openingId, delta: chunk });
    }
    emitAgui({ type: EventType.TEXT_MESSAGE_END, messageId: openingId });

    const turnStart = thread.length;
    const desiredSteps = rng.int(1, 5);
    const terminalRoll = rng.next();
    const terminalMode: "success" | "cancelled" | "error" =
      terminalRoll < 0.72 ? "success" : terminalRoll < 0.86 ? "cancelled" : "error";
    const abortAtStep = terminalMode === "success" ? -1 : rng.int(1, desiredSteps);

    let committed = false;
    let retriesRemaining = 2;
    let routeAdvancesRemaining = 1;
    let stepNum = 1;
    let terminated = false;

    while (stepNum <= desiredSteps && !terminated) {
      stats.stepsRun++;
      const stepStart = thread.length;
      const stepName = `turn ${stepNum}`;
      const assistantId = nextId("a");
      const isFinalSuccessStep = terminalMode === "success" && stepNum === desiredSteps;
      const isAbortStep = terminalMode !== "success" && stepNum === abortAtStep;

      emitAgui({ type: EventType.STEP_STARTED, stepName });

      let reasoningId: string | undefined;
      if (rng.chance(0.55)) {
        stats.reasoningBlocks++;
        reasoningId = nextId("r");
        emitAgui({ type: EventType.REASONING_START, messageId: reasoningId });
        emitAgui({
          type: EventType.REASONING_MESSAGE_START,
          messageId: reasoningId,
          role: "reasoning",
        });
        for (const chunk of splitIntoChunks(
          rng,
          `Reasoning seed ${seed} step ${stepNum} — evaluating options.`,
          4,
        )) {
          emitAgui({
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: reasoningId,
            delta: chunk,
          });
        }
      }

      const closeReasoning = () => {
        if (!reasoningId) return;
        emitAgui({ type: EventType.REASONING_MESSAGE_END, messageId: reasoningId });
        emitAgui({ type: EventType.REASONING_END, messageId: reasoningId });
        reasoningId = undefined;
      };

      let textOpen = false;
      const shouldEmitText = isFinalSuccessStep || rng.chance(0.55);
      if (shouldEmitText) {
        closeReasoning();
        textOpen = true;
        emitAgui({ type: EventType.TEXT_MESSAGE_START, messageId: assistantId, role: "assistant" });
        const bodyText = isFinalSuccessStep
          ? `Final answer for seed ${seed} turn ${t} after ${stepNum} steps.`
          : `Step ${stepNum} note before acting.`;
        for (const chunk of splitIntoChunks(rng, bodyText, 4)) {
          emitAgui({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: assistantId, delta: chunk });
        }
      }

      if (rng.chance(0.2)) {
        emitAgui({
          type: EventType.CUSTOM,
          name: CUSTOM_EVENTS.guardrail,
          value: { boundary: "model_output", decision: "allow", score: 0.01 },
        });
      }

      if (rng.chance(0.14)) {
        stats.deferredApprovals++;
        const defId = nextId("def");
        steps.push({
          kind: "deferred",
          event: {
            type: "deferred_approval",
            decisionId: defId,
            ref: `ap/1124-${seq}`,
            title: `Deferred subagent write ${defId}`,
            why: "Background subagent requested write.",
            hold: "Deferred — nothing written.",
            tool: "reminders.create",
            subagentName: `helper-${t}`,
            facts: [["Call", "reminders.create"]],
            actions: APPROVAL_CHOICES,
          },
        });
        if (rng.chance(0.5)) {
          steps.push({
            kind: "settle",
            decisionId: defId,
            outcome: rng.pick(["approved", "declined", "expired"] as const),
          });
        }
      }

      const closeStep = () => {
        closeReasoning();
        if (textOpen) {
          emitAgui({ type: EventType.TEXT_MESSAGE_END, messageId: assistantId });
          textOpen = false;
        }
        emitAgui({ type: EventType.STEP_FINISHED, stepName });
      };

      // Mid-step retry + MESSAGES_SNAPSHOT back to stepStart.
      if (retriesRemaining > 0 && rng.chance(0.2)) {
        retriesRemaining--;
        stats.retries++;
        closeStep();
        emitAgui({
          type: EventType.CUSTOM,
          name: CUSTOM_EVENTS.retry,
          value: { error: "503 transient failure", delayMs: 250 },
        });
        emitAgui({
          type: EventType.MESSAGES_SNAPSHOT,
          messages: thread.slice(0, stepStart),
        });
        continue;
      }

      // Route advance + MESSAGES_SNAPSHOT back to turnStart (only before committed write).
      if (!committed && routeAdvancesRemaining > 0 && stepNum >= 1 && rng.chance(0.15)) {
        routeAdvancesRemaining--;
        stats.routeAdvances++;
        closeStep();
        emitAgui({
          type: EventType.CUSTOM,
          name: CUSTOM_EVENTS.routeAdvanced,
          value: {
            from: { provider: "omlx", model: "local-a" },
            to: { provider: "openrouter", model: "fallback-b" },
            error: "stall timeout",
          },
        });
        emitAgui({
          type: EventType.MESSAGES_SNAPSHOT,
          messages: thread.slice(0, turnStart),
        });
        stepNum = 1;
        continue;
      }

      closeStep();

      // Final successful step finishes the turn.
      if (isFinalSuccessStep) {
        stats.successes++;
        emitAgui({
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
          outcome: { type: "success" },
        });
        terminated = true;
        break;
      }

      // Abort directly before tools on half of abort steps.
      if (isAbortStep && rng.chance(0.5)) {
        if (terminalMode === "cancelled") {
          stats.cancellations++;
          emitAgui({
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
            outcome: { type: "cancelled" },
          });
        } else {
          stats.errors++;
          emitAgui({
            type: EventType.RUN_ERROR,
            message: `Synthetic error on seed ${seed}`,
            code: "FUZZ_ERR",
          });
        }
        terminated = true;
        break;
      }

      // Non-final step: generate 0..4 parallel tool calls.
      const toolCount = isAbortStep ? rng.int(1, 2) : rng.int(0, 4);
      interface PlannedCall {
        id: string;
        name: string;
        isWrite: boolean;
        isMalformed: boolean;
        rawArgs: string;
      }
      const planned: PlannedCall[] = [];
      let hasWriteInStep = false;

      for (let c = 0; c < toolCount; c++) {
        const callId = nextId("tc");
        const roll = rng.next();
        if (roll < 0.25) {
          stats.openToolGroups++;
          const group = rng.pick(GROUPS);
          planned.push({
            id: callId,
            name: OPEN_TOOL_GROUP,
            isWrite: false,
            isMalformed: false,
            rawArgs: JSON.stringify({ group }),
          });
        } else if (roll < 0.42 && !hasWriteInStep && !isAbortStep) {
          hasWriteInStep = true;
          stats.toolCalls++;
          const name = rng.pick(WRITE_TOOLS);
          planned.push({
            id: callId,
            name,
            isWrite: true,
            isMalformed: false,
            rawArgs: JSON.stringify({ title: `Write task ${seed}-${stepNum}-${c}` }),
          });
        } else {
          stats.toolCalls++;
          const name = rng.pick(READ_TOOLS);
          const isMalformed = rng.chance(0.1);
          planned.push({
            id: callId,
            name,
            isWrite: false,
            isMalformed,
            rawArgs: isMalformed
              ? "{malformed_json"
              : JSON.stringify({ query: `q-${seed}-${stepNum}-${c}` }),
          });
        }
      }

      for (const call of planned) {
        emitAgui({
          type: EventType.TOOL_CALL_START,
          toolCallId: call.id,
          toolCallName: call.name,
          parentMessageId: assistantId,
        });
        for (const chunk of splitIntoChunks(rng, call.rawArgs, 4)) {
          emitAgui({ type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: chunk });
        }
        emitAgui({ type: EventType.TOOL_CALL_END, toolCallId: call.id });
      }

      // Abort mid-tools (TurnEncoder.closeCalls closes open calls with error: "not run").
      if (isAbortStep) {
        for (const call of planned) {
          emitAgui({
            type: EventType.TOOL_CALL_RESULT,
            messageId: `${call.id}:result`,
            toolCallId: call.id,
            content: "Not run: the turn ended first.",
            role: "tool",
            metadata: { [SOLENOID_METADATA_KEY]: { error: "not run" } satisfies ToolResultMetadata },
          });
        }
        if (terminalMode === "cancelled") {
          stats.cancellations++;
          emitAgui({
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
            outcome: { type: "cancelled" },
          });
        } else {
          stats.errors++;
          emitAgui({
            type: EventType.RUN_ERROR,
            message: `Synthetic mid-tool error on seed ${seed}`,
            code: "FUZZ_TOOL_ERR",
          });
        }
        terminated = true;
        break;
      }

      // Optional display ACTIVITY_SNAPSHOT.
      if (planned.length > 0 && rng.chance(0.25)) {
        stats.activitySnapshots++;
        const first = planned[0]!;
        emitAgui({
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: `${first.id}:display`,
          activityType: "chart",
          content: { points: [1, 2, 3], seed },
          replace: true,
        });
      }

      // Optional approval interrupt for write call in this step.
      const declinedCalls = new Set<string>();
      const writeCall = planned.find((c) => c.isWrite);
      if (writeCall && rng.chance(0.75)) {
        stats.interrupts++;
        const interruptId = `approval:${writeCall.id}`;
        const decisionId = nextId("dec");
        approvals.set(interruptId, {
          decisionId,
          ref: `ap/1124-${seq}`,
          title: `Allow ${writeCall.name}?`,
          why: "Fuzz approval request.",
          hold: "Nothing has been written.",
          tool: writeCall.name.replace("_", "."),
          facts: [["Call", writeCall.name.replace("_", ".")]],
          actions: APPROVAL_CHOICES,
        });

        emitAgui({
          type: EventType.RUN_FINISHED,
          threadId,
          runId,
          outcome: {
            type: "interrupt",
            interrupts: [
              {
                id: interruptId,
                reason: APPROVAL_REASON,
                message: `Allow ${writeCall.name}?`,
                toolCallId: writeCall.id,
                responseSchema: {
                  type: "object",
                  properties: { approved: { type: "boolean" } },
                  required: ["approved"],
                },
              },
            ],
          },
        });

        const outcome = rng.pick(["approved", "approved", "declined", "expired"] as const);
        steps.push({ kind: "settle", decisionId, outcome });
        // Occasionally test duplicate settlement idempotency under fuzzing.
        if (rng.chance(0.25)) {
          steps.push({ kind: "settle", decisionId, outcome: "expired" });
        }

        if (outcome === "approved") {
          committed = true;
        } else {
          declinedCalls.add(writeCall.id);
        }

        runId = nextId("run");
        emitAgui({ type: EventType.RUN_STARTED, threadId, runId });
      } else if (writeCall) {
        committed = true;
      }

      // Emit TOOL_CALL_RESULTs in shuffled order to stress out-of-order completion.
      for (const call of rng.shuffle(planned)) {
        let outcome: ToolResultMetadata;
        let content = "ok";
        if (call.name === OPEN_TOOL_GROUP) {
          outcome = { durationMs: rng.int(1, 8) };
          content = "Group opened.";
        } else if (declinedCalls.has(call.id)) {
          outcome = { durationMs: rng.int(1, 10), declined: true };
          content = "Declined.";
        } else if (call.isMalformed) {
          outcome = { durationMs: rng.int(1, 5), error: "Invalid arguments", malformed: true };
          content = "Invalid arguments";
        } else {
          const outcomeRoll = rng.next();
          if (outcomeRoll < 0.78) {
            outcome = { durationMs: rng.int(10, 1800) };
          } else if (outcomeRoll < 0.9) {
            outcome = { durationMs: rng.int(10, 500), error: "transient tool error" };
            content = "Error: transient tool error";
          } else {
            outcome = { durationMs: rng.int(10, 500), quarantined: true };
            content = "[quarantined]";
          }
        }
        emitAgui({
          type: EventType.TOOL_CALL_RESULT,
          messageId: `${call.id}:result`,
          toolCallId: call.id,
          content,
          role: "tool",
          metadata: { [SOLENOID_METADATA_KEY]: outcome },
        });
      }

      stepNum++;
    }
  }

  return { seed, steps, approvals, finalThread: thread, stats };
}

// ---------------------------------------------------------------------------
// Universal Invariant Verifier for One Seed
// ---------------------------------------------------------------------------

/** Extracts non-open_tool_group tool call IDs belonging to the current (last) turn in `messages`. */
function currentTurnToolCallIds(messages: readonly Message[]): {
  toolCallIds: Set<string>;
  openedGroups: Set<string>;
} {
  let turnStartIdx = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === "user" || role === "developer") {
      turnStartIdx = i;
      break;
    }
  }
  const toolCallIds = new Set<string>();
  const openedGroups = new Set<string>();
  for (let i = turnStartIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant" || !msg.toolCalls) continue;
    for (const call of msg.toolCalls) {
      if (call.function.name === OPEN_TOOL_GROUP) {
        try {
          const parsed = JSON.parse(call.function.arguments || "{}") as { group?: unknown };
          if (typeof parsed.group === "string" && parsed.group) {
            openedGroups.add(parsed.group);
          }
        } catch {
          // ignore malformed open_tool_group args
        }
      } else {
        toolCallIds.add(call.id);
      }
    }
  }
  return { toolCallIds, openedGroups };
}

function assertSeedInvariants(seed: number): void {
  const scenario = generateScenario(seed);
  const ctx = `[seed=${seed}]`;
  const resolveToolKind = (name: string): "read" | "write" =>
    WRITE_TOOL_SET.has(name) ? "write" : "read";

  const translator = new AgUiToChatEventTranslator({
    resolveToolKind,
    resolveApproval: (interruptId) => scenario.approvals.get(interruptId),
  });

  // Track tool_start / tool_end pairing within current non-reset epoch.
  let startedIds = new Set<string>();
  let endedIds = new Set<string>();
  let turnMessagesCount = 0;
  let turnCancelledCount = 0;
  let turnErrorCount = 0;
  let live: LiveTurn = freshLiveTurn();

  const validateAndApplyChatEvents = (
    emitted: ChatEvent[],
    stepIndex: number,
    sourceEvent?: AGUIEvent,
  ): void => {
    expect(Array.isArray(emitted), `${ctx} step=${stepIndex}: push returned array`).toBe(true);

    for (const ev of emitted) {
      // Invariant 5: Feeding every emitted ChatEvent into web/src/app/chat.ts `apply()` NEVER throws.
      if (ev.type === "turn_start") {
        startedIds = new Set<string>();
        endedIds = new Set<string>();
        turnMessagesCount = 0;
        turnCancelledCount = 0;
        turnErrorCount = 0;
        live = freshLiveTurn({ turnId: ev.turnId, asked: ev.asked, source: ev.source });
      }
      live = apply(live, ev);
      expect(live, `${ctx} step=${stepIndex}: apply(${ev.type}) defined`).toBeDefined();
      expect(Array.isArray(live.said), `${ctx} step=${stepIndex}: live.said array`).toBe(true);
      expect(Array.isArray(live.calls), `${ctx} step=${stepIndex}: live.calls array`).toBe(true);
      expect(Array.isArray(live.opened), `${ctx} step=${stepIndex}: live.opened array`).toBe(true);

      // Invariant 2: Every tool_end pairs with a prior tool_start in current non-reset epoch.
      if (ev.type === "tool_start") {
        expect(
          ev.name !== OPEN_TOOL_GROUP && ev.name !== "open.tool_group",
          `${ctx} step=${stepIndex}: open_tool_group must not emit tool_start`,
        ).toBe(true);
        expect(
          startedIds.has(ev.id),
          `${ctx} step=${stepIndex}: duplicate tool_start for id=${ev.id}`,
        ).toBe(false);
        startedIds.add(ev.id);
      } else if (ev.type === "tool_end") {
        expect(
          ev.name !== OPEN_TOOL_GROUP && ev.name !== "open.tool_group",
          `${ctx} step=${stepIndex}: open_tool_group must not emit tool_end`,
        ).toBe(true);
        expect(
          startedIds.has(ev.id),
          `${ctx} step=${stepIndex}: tool_end id=${ev.id} without matching prior tool_start`,
        ).toBe(true);
        expect(
          endedIds.has(ev.id),
          `${ctx} step=${stepIndex}: duplicate tool_end for id=${ev.id}`,
        ).toBe(false);
        endedIds.add(ev.id);
      } else if (ev.type === "reset") {
        // Invariant 3: Structurally valid LiveTurnSnapshot with zero stale rolled-back calls/groups.
        expect(
          ev.scope === "step" || ev.scope === "attempt",
          `${ctx} step=${stepIndex}: valid reset scope`,
        ).toBe(true);
        expect(typeof ev.reason, `${ctx} step=${stepIndex}: reset.reason string`).toBe("string");

        const snap = ev.live;
        expect(snap, `${ctx} step=${stepIndex}: reset.live defined`).toBeDefined();
        expect(typeof snap.turnId, `${ctx} step=${stepIndex}: reset.live.turnId`).toBe("string");
        expect(typeof snap.asked, `${ctx} step=${stepIndex}: reset.live.asked`).toBe("string");
        expect(
          snap.source === "text" || snap.source === "subagent",
          `${ctx} step=${stepIndex}: reset.live.source`,
        ).toBe(true);
        expect(typeof snap.streamingText, `${ctx} step=${stepIndex}: reset.live.streamingText`).toBe(
          "string",
        );
        expect(
          typeof snap.streamingReasoning,
          `${ctx} step=${stepIndex}: reset.live.streamingReasoning`,
        ).toBe("string");
        expect(Array.isArray(snap.said), `${ctx} step=${stepIndex}: reset.live.said`).toBe(true);
        expect(Array.isArray(snap.calls), `${ctx} step=${stepIndex}: reset.live.calls`).toBe(true);
        expect(Array.isArray(snap.opened), `${ctx} step=${stepIndex}: reset.live.opened`).toBe(true);
        expect(
          Array.isArray(snap.deferredApprovals),
          `${ctx} step=${stepIndex}: reset.live.deferredApprovals`,
        ).toBe(true);
        expect(
          Array.isArray(snap.activeSubagents),
          `${ctx} step=${stepIndex}: reset.live.activeSubagents`,
        ).toBe(true);
        expect(
          new Set(snap.opened).size,
          `${ctx} step=${stepIndex}: reset.live.opened unique`,
        ).toBe(snap.opened.length);

        // Verify zero stale calls or groups from rolled-back steps remain in reset.live!
        if (sourceEvent && sourceEvent.type === EventType.MESSAGES_SNAPSHOT) {
          const surviving = currentTurnToolCallIds(sourceEvent.messages);
          for (const call of snap.calls) {
            if (call.id) {
              expect(
                surviving.toolCallIds.has(call.id),
                `${ctx} step=${stepIndex}: stale rolled-back call id=${call.id} in reset.live`,
              ).toBe(true);
            }
          }
          expect(
            snap.calls.length,
            `${ctx} step=${stepIndex}: reset.live.calls count matches surviving snapshot`,
          ).toBe(surviving.toolCallIds.size);
          for (const group of snap.opened) {
            expect(
              surviving.openedGroups.has(group),
              `${ctx} step=${stepIndex}: stale rolled-back group="${group}" in reset.live`,
            ).toBe(true);
          }
        }

        // Re-baseline current epoch tracking from reset.live.calls.
        startedIds = new Set<string>();
        endedIds = new Set<string>();
        for (const call of snap.calls) {
          if (!call.id) continue;
          startedIds.add(call.id);
          if (call.status !== "running") endedIds.add(call.id);
        }
      } else if (ev.type === "message") {
        turnMessagesCount++;
      } else if (ev.type === "cancelled") {
        turnCancelledCount++;
      } else if (ev.type === "error") {
        turnErrorCount++;
      }
    }
  };

  // Replay entire generated sequence checking Invariants 1..5 at every step.
  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!;
    let emitted: ChatEvent[];
    if (step.kind === "agui") {
      emitted = translator.push(step.event);
      validateAndApplyChatEvents(emitted, i, step.event);

      // Invariant 4: Terminal events cleanly close the active turn.
      if (step.event.type === EventType.RUN_FINISHED && step.event.outcome?.type !== "interrupt") {
        const snapAfter = translator.snapshot();
        expect(
          snapAfter,
          `${ctx} step=${i}: snapshot must be null after RUN_FINISHED(${step.event.outcome?.type ?? "success"})`,
        ).toBeNull();
        if (step.event.outcome?.type === "cancelled") {
          expect(turnCancelledCount, `${ctx} step=${i}: cancelled event emitted`).toBeGreaterThanOrEqual(
            1,
          );
          expect(turnMessagesCount, `${ctx} step=${i}: no message on cancel`).toBe(0);
        } else {
          expect(turnMessagesCount, `${ctx} step=${i}: exactly 1 message on success`).toBe(1);
        }
        startedIds = new Set<string>();
        endedIds = new Set<string>();
      } else if (step.event.type === EventType.RUN_ERROR) {
        expect(turnErrorCount, `${ctx} step=${i}: error event emitted`).toBeGreaterThanOrEqual(1);
        expect(turnMessagesCount, `${ctx} step=${i}: no message on RUN_ERROR`).toBe(0);
        const snapAfter = translator.snapshot();
        if (snapAfter !== null) {
          expect(snapAfter.error, `${ctx} step=${i}: terminal snapshot carries error`).not.toBeNull();
          expect(
            snapAfter.pending,
            `${ctx} step=${i}: terminal error snapshot has no pending approval`,
          ).toBeNull();
          expect(
            snapAfter.calls.some((c) => c.status === "running"),
            `${ctx} step=${i}: terminal error snapshot has no dangling running tools`,
          ).toBe(false);
        }
        startedIds = new Set<string>();
        endedIds = new Set<string>();
      }
    } else if (step.kind === "settle") {
      emitted = translator.onApprovalSettled(step.decisionId, step.outcome);
      validateAndApplyChatEvents(emitted, i);
    } else {
      emitted = translator.onDeferredApproval(step.event);
      validateAndApplyChatEvents(emitted, i);
    }
  }

  // Final checkpoint hydration safety check on every seed.
  const hydrated = hydrateTurnsFromThread(scenario.finalThread, {
    now: new Date("2026-11-24T18:00:00.000Z"),
    resolveToolKind,
  });
  expect(Array.isArray(hydrated), `${ctx}: hydrateTurnsFromThread returns array`).toBe(true);
  for (const row of hydrated) {
    for (const call of row.calls) {
      expect(
        call.name !== OPEN_TOOL_GROUP && call.name !== "open.tool_group",
        `${ctx}: hydrated calls must never contain open_tool_group`,
      ).toBe(true);
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 4 Fuzz Suite (200 Deterministic Seeds)
// ---------------------------------------------------------------------------

describe("Tier 4 — Seeded Property / Fuzz Invariants (200 deterministic seeds)", () => {
  test("generator self-check: Mulberry32 is 100% deterministic and exercises every AG-UI feature across 200 seeds", () => {
    // Determinism check on sample seed.
    const a = generateScenario(42);
    const b = generateScenario(42);
    expect(a.steps).toEqual(b.steps);
    expect(a.finalThread).toEqual(b.finalThread);

    // Aggregate feature coverage across all 200 seeds so the fuzzer never silently goes stale.
    const totals = {
      turns: 0,
      developerTurns: 0,
      stepsRun: 0,
      reasoningBlocks: 0,
      toolCalls: 0,
      openToolGroups: 0,
      retries: 0,
      routeAdvances: 0,
      interrupts: 0,
      deferredApprovals: 0,
      activitySnapshots: 0,
      cancellations: 0,
      errors: 0,
      successes: 0,
    };
    for (let seed = 1; seed <= 200; seed++) {
      const s = generateScenario(seed);
      totals.turns += s.stats.turns;
      totals.developerTurns += s.stats.developerTurns;
      totals.stepsRun += s.stats.stepsRun;
      totals.reasoningBlocks += s.stats.reasoningBlocks;
      totals.toolCalls += s.stats.toolCalls;
      totals.openToolGroups += s.stats.openToolGroups;
      totals.retries += s.stats.retries;
      totals.routeAdvances += s.stats.routeAdvances;
      totals.interrupts += s.stats.interrupts;
      totals.deferredApprovals += s.stats.deferredApprovals;
      totals.activitySnapshots += s.stats.activitySnapshots;
      totals.cancellations += s.stats.cancellations;
      totals.errors += s.stats.errors;
      totals.successes += s.stats.successes;
    }

    expect(totals.turns).toBeGreaterThanOrEqual(300);
    expect(totals.developerTurns).toBeGreaterThan(25);
    expect(totals.stepsRun).toBeGreaterThan(800);
    expect(totals.reasoningBlocks).toBeGreaterThan(200);
    expect(totals.toolCalls).toBeGreaterThan(500);
    expect(totals.openToolGroups).toBeGreaterThan(100);
    expect(totals.retries).toBeGreaterThan(50);
    expect(totals.routeAdvances).toBeGreaterThan(30);
    expect(totals.interrupts).toBeGreaterThan(30);
    expect(totals.deferredApprovals).toBeGreaterThan(30);
    expect(totals.activitySnapshots).toBeGreaterThan(30);
    expect(totals.cancellations).toBeGreaterThan(20);
    expect(totals.errors).toBeGreaterThan(20);
    expect(totals.successes).toBeGreaterThan(150);
  });

  test("seeds 1..50 satisfy all 5 universal translator & reducer invariants", () => {
    for (let seed = 1; seed <= 50; seed++) {
      assertSeedInvariants(seed);
    }
  });

  test("seeds 51..100 satisfy all 5 universal translator & reducer invariants", () => {
    for (let seed = 51; seed <= 100; seed++) {
      assertSeedInvariants(seed);
    }
  });

  test("seeds 101..150 satisfy all 5 universal translator & reducer invariants", () => {
    for (let seed = 101; seed <= 150; seed++) {
      assertSeedInvariants(seed);
    }
  });

  test("seeds 151..200 satisfy all 5 universal translator & reducer invariants", () => {
    for (let seed = 151; seed <= 200; seed++) {
      assertSeedInvariants(seed);
    }
  });
});
