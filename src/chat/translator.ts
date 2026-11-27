import {
  EventType,
  contentToText,
  type AGUIEvent,
  type AssistantMessage,
  type Interrupt,
  type Message,
  type ToolMessage,
} from "@ag-ui/core";
import {
  CUSTOM_EVENTS,
  OPEN_SKILL,
  OPEN_TOOL_GROUP,
  SOLENOID_METADATA_KEY,
  applyEvent,
  customValue,
  findToolCall,
  resultMetadata,
  type CustomEventName,
} from "@elicollinson/solenoid-engine";
import { clock, dayKey, stampLong } from "../db/queries/_format";
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
import { displayArg, displayName } from "./turn";

export interface TranslatorApprovalContext {
  decisionId: string;
  ref: string;
  title: string;
  why: string | null;
  hold: string | null;
  tool: string;
  facts: readonly ChatFact[];
  actions: readonly ChatChoice[];
}

export interface TranslatorOptions {
  /** Resolve whether a tool name is a read or write tool (defaults to `"read"`). */
  resolveToolKind?: (toolName: string) => "read" | "write";
  /** Lookup UI approval metadata for an AG-UI interrupt event. */
  resolveApproval?: (
    interruptId: string,
    toolCallId: string,
  ) => TranslatorApprovalContext | undefined;
  /** Custom duration formatter (defaults to `src/chat/turn.ts` `displayDuration` formatting). */
  formatDuration?: (ms: number) => string;
  now?: () => number;
}

export interface HydrateTurnsOptions {
  now?: Date;
  resolveToolKind?: (toolName: string) => "read" | "write";
  approvalsByToolCallId?: ReadonlyMap<string, ChatApproval>;
  deferredApprovals?: readonly ChatApproval[];
}

// ---------------------------------------------------------------------------
// Pure formatting & reconstruction helpers
// ---------------------------------------------------------------------------

const DEFAULT_HOLD = "Nothing has been written. I stopped before the call.";
const KNOWN_CUSTOM_EVENTS = new Set<string>(Object.values(CUSTOM_EVENTS));

function isCustomEventName(name: string): name is CustomEventName {
  return KNOWN_CUSTOM_EVENTS.has(name);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function defaultFormatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
}

function noteFor(opened: readonly string[]): string | null {
  if (!opened.length) return null;
  const formatted = opened.map((item) =>
    item.startsWith("skill:") ? `skill ${item.slice(6)}` : item,
  );
  return `opened ${formatted.join(", ")}`;
}

/**
 * Formats `"3 tool calls · imessage.list_conversations ×2, okf.read"` from
 * already-dotted display names so multi-underscore tools are never double-dotted.
 */
function summarizeDisplayCalls(calls: readonly { name: string }[]): string | null {
  if (!calls.length) return null;
  const counts = new Map<string, number>();
  for (const call of calls) {
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  }
  const named = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  return `${calls.length} tool call${calls.length === 1 ? "" : "s"} · ${named.join(", ")}`;
}

function cloneSnapshot(snap: LiveTurnSnapshot): LiveTurnSnapshot {
  return {
    turnId: snap.turnId,
    asked: snap.asked,
    source: snap.source,
    said: [...snap.said],
    streamingText: snap.streamingText,
    streamingReasoning: snap.streamingReasoning,
    calls: snap.calls.map((c) => ({ ...c })),
    opened: [...snap.opened],
    pending: snap.pending,
    deferredApprovals: [...snap.deferredApprovals],
    activeSubagents: snap.activeSubagents.map((s) => ({ ...s })),
    error: snap.error,
  };
}

function turnStamp(at: Date, now: Date): string {
  return dayKey(at) === dayKey(now) ? clock(at) : stampLong(at, now);
}

function readSolenoidMetadata(msg: Message): Record<string, unknown> | undefined {
  const raw = msg.metadata?.[SOLENOID_METADATA_KEY];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

function formatMessageStamp(msg: Message, now: Date): string {
  const solenoid = readSolenoidMetadata(msg);
  const rawTs = solenoid?.timestamp;
  if (typeof rawTs === "string" || typeof rawTs === "number") {
    const parsed = new Date(rawTs);
    if (!Number.isNaN(parsed.getTime())) {
      return turnStamp(parsed, now);
    }
  }
  return turnStamp(now, now);
}

function metadataSource(msg: Message): "text" | "voice" | "subagent" | undefined {
  const src = readSolenoidMetadata(msg)?.source;
  if (src === "voice" || src === "subagent" || src === "text") return src;
  return undefined;
}

function extractOpenGroupName(args: Record<string, unknown> | null): string | null {
  const group = typeof args?.group === "string" ? args.group.trim() : "";
  return group || null;
}

function extractOpenSkillLabel(args: Record<string, unknown> | null): string | null {
  const skill = typeof args?.skill === "string" ? args.skill.trim().toLowerCase() : "";
  return skill ? `skill:${skill}` : null;
}

function isToolOutcomeOk(
  toolError: string | undefined,
  meta: ReturnType<typeof resultMetadata>,
): boolean {
  return !toolError && !meta.error && !meta.quarantined && !meta.declined && !meta.malformed;
}

// ---------------------------------------------------------------------------
// Internal translator tracking structures
// ---------------------------------------------------------------------------

interface PendingToolCallBuffer {
  id: string;
  rawName: string;
  argsBuf: string;
  isOpenGroup: boolean;
  isOpenSkill: boolean;
}

interface StartedToolCallInfo {
  id: string;
  rawName: string;
  name: string;
  kind: "read" | "write";
  arg: string | null;
}

interface OpenTextMessage {
  role: "user" | "developer" | "assistant" | "system";
  text: string;
}

interface PendingReset {
  scope: "step" | "attempt";
  reason: string;
}

/**
 * Pure, stateful translator folding AG-UI 1.0 `AGUIEvent`s into solenoid-assistant's
 * wire `ChatEvent` frames, maintaining a serializable `LiveTurnSnapshot` for SSE reconnects
 * and emitting atomic `reset` frames on retry / route-fallback `MESSAGES_SNAPSHOT`.
 */
export class AgUiToChatEventTranslator {
  private readonly resolveToolKind: (toolName: string) => "read" | "write";
  private readonly resolveApproval?: (
    interruptId: string,
    toolCallId: string,
  ) => TranslatorApprovalContext | undefined;
  private readonly formatDuration: (ms: number) => string;

  /** Lockstep AG-UI thread maintained via solenoid-engine's `applyEvent()`. */
  private thread: Message[] = [];
  /** Current serializable live turn snapshot, or `null` when idle. */
  private live: LiveTurnSnapshot | null = null;
  private currentRunId: string | null = null;
  private awaitingResume = false;
  private pendingReset: PendingReset | null = null;

  private readonly openTextMessages = new Map<string, OpenTextMessage>();
  private pendingAssistantId: string | null = null;
  private pendingAssistantText = "";
  private lastAssistantId: string | null = null;
  private lastNonEmptyAssistantId: string | null = null;
  private lastNonEmptyAssistantText = "";

  private readonly pendingCalls = new Map<string, PendingToolCallBuffer>();
  private readonly activeToolCalls = new Map<string, StartedToolCallInfo>();
  private readonly completedToolCallIds = new Set<string>();
  private readonly openGroupCallIds = new Set<string>();

  private openBlockingDecisionId: string | null = null;
  private readonly openDeferredDecisionIds = new Set<string>();
  private readonly settledDecisionIds = new Set<string>();
  private readonly trackedSubagents = new Map<string, SubagentStatusItem>();

  constructor(options: TranslatorOptions = {}) {
    this.resolveToolKind = options.resolveToolKind ?? (() => "read");
    this.resolveApproval = options.resolveApproval;
    this.formatDuration = options.formatDuration ?? defaultFormatDuration;
  }

  push(event: AGUIEvent): ChatEvent[] {
    this.thread = applyEvent(this.thread, event);

    switch (event.type) {
      case EventType.RUN_STARTED: {
        this.currentRunId = event.runId;
        if (this.awaitingResume) {
          this.awaitingResume = false;
          return [];
        }
        this.clearTurnScratch();
        this.live = null;
        return [];
      }

      case EventType.RUN_FINISHED: {
        const outcome = event.outcome ?? { type: "success" as const };
        switch (outcome.type) {
          case "interrupt":
            return this.handleInterruptOutcome(outcome.interrupts);

          case "cancelled": {
            const ev: ChatEvent = { type: "cancelled" };
            this.clearActiveTurn();
            return [ev];
          }

          case "success": {
            if (!this.live) {
              this.clearActiveTurn();
              return [];
            }
            const body =
              this.pendingAssistantText.length > 0
                ? this.pendingAssistantText
                : this.lastNonEmptyAssistantText.length > 0
                  ? this.lastNonEmptyAssistantText
                  : "";
            const messageId =
              this.pendingAssistantText.length > 0
                ? (this.pendingAssistantId ?? this.currentRunId ?? "assistant")
                : this.lastNonEmptyAssistantText.length > 0
                  ? (this.lastNonEmptyAssistantId ?? this.currentRunId ?? "assistant")
                  : (this.pendingAssistantId ?? this.lastAssistantId ?? this.currentRunId ?? "assistant");
            const reasoning = this.live.streamingReasoning.trim() || null;
            const messageEvent: ChatEvent = {
              type: "message",
              messageId,
              body,
              note: noteFor(this.live.opened),
              toolSummary: summarizeDisplayCalls(this.live.calls),
              ...(reasoning ? { reasoning } : {}),
              source: this.live.source,
            };
            this.clearActiveTurn();
            return [messageEvent];
          }

          default: {
            const _exhaustiveOutcome: never = outcome;
            void _exhaustiveOutcome;
            return [];
          }
        }
      }

      case EventType.RUN_ERROR: {
        const errorEvent: ChatEvent = { type: "error", message: event.message };
        this.clearActiveTurn();
        return [errorEvent];
      }

      case EventType.STEP_STARTED: {
        return this.flushPendingAssistantAsSay();
      }

      case EventType.STEP_FINISHED:
        return [];

      case EventType.TEXT_MESSAGE_START: {
        const role = event.role ?? "assistant";
        this.openTextMessages.set(event.messageId, { role, text: "" });
        if (role === "assistant") {
          const out =
            this.pendingAssistantId !== null && this.pendingAssistantId !== event.messageId
              ? this.flushPendingAssistantAsSay()
              : [];
          this.pendingAssistantId = event.messageId;
          this.pendingAssistantText = "";
          this.lastAssistantId = event.messageId;
          return out;
        }
        return [];
      }

      case EventType.TEXT_MESSAGE_CONTENT: {
        const open = this.openTextMessages.get(event.messageId);
        if (open) {
          open.text += event.delta;
          if (open.role === "user" || open.role === "developer" || open.role === "system") {
            return [];
          }
          this.pendingAssistantId = event.messageId;
          this.pendingAssistantText += event.delta;
          if (this.pendingAssistantText.length > 0) {
            this.lastNonEmptyAssistantId = event.messageId;
            this.lastNonEmptyAssistantText = this.pendingAssistantText;
          }
          if (!event.delta) return [];
          const deltaEvent: ChatEvent = { type: "delta", text: event.delta };
          this.applyLiveEvent(deltaEvent);
          return [deltaEvent];
        }
        if (!event.delta) return [];
        const deltaEvent: ChatEvent = { type: "delta", text: event.delta };
        this.applyLiveEvent(deltaEvent);
        return [deltaEvent];
      }

      case EventType.TEXT_MESSAGE_END: {
        const open = this.openTextMessages.get(event.messageId);
        this.openTextMessages.delete(event.messageId);
        if (open && (open.role === "user" || open.role === "developer")) {
          const source: "text" | "subagent" = open.role === "developer" ? "subagent" : "text";
          const asked = open.role === "developer" ? "" : open.text;
          const turnId = event.messageId;
          this.clearTurnScratch();
          const turnStartEvent: Extract<ChatEvent, { type: "turn_start" }> = {
            type: "turn_start",
            turnId,
            asked,
            source,
          };
          this.live = {
            turnId,
            asked,
            source,
            said: [],
            streamingText: "",
            streamingReasoning: "",
            calls: [],
            opened: [],
            pending: null,
            deferredApprovals: [],
            activeSubagents: [...this.trackedSubagents.values()].map((s) => ({ ...s })),
            error: null,
          };
          return [turnStartEvent];
        }
        return [];
      }

      case EventType.TEXT_MESSAGE_CHUNK: {
        if (event.role === "user" || event.role === "developer" || event.role === "system") {
          return [];
        }
        if (!event.delta) return [];
        if (event.messageId) {
          this.pendingAssistantId = event.messageId;
          this.lastAssistantId = event.messageId;
        }
        this.pendingAssistantText += event.delta;
        if (this.pendingAssistantText.length > 0) {
          this.lastNonEmptyAssistantId = this.pendingAssistantId;
          this.lastNonEmptyAssistantText = this.pendingAssistantText;
        }
        const deltaEvent: ChatEvent = { type: "delta", text: event.delta };
        this.applyLiveEvent(deltaEvent);
        return [deltaEvent];
      }

      case EventType.TOOL_CALL_START: {
        const out = this.flushPendingAssistantAsSay();
        this.pendingCalls.set(event.toolCallId, {
          id: event.toolCallId,
          rawName: event.toolCallName,
          argsBuf: "",
          isOpenGroup: event.toolCallName === OPEN_TOOL_GROUP,
          isOpenSkill: event.toolCallName === OPEN_SKILL,
        });
        return out;
      }

      case EventType.TOOL_CALL_ARGS: {
        const pending = this.pendingCalls.get(event.toolCallId);
        if (pending) {
          pending.argsBuf += event.delta;
        }
        return [];
      }

      case EventType.TOOL_CALL_END: {
        const pending = this.pendingCalls.get(event.toolCallId);
        this.pendingCalls.delete(event.toolCallId);
        if (!pending) return [];

        const parsedArgs = parseJsonObject(pending.argsBuf);
        if (pending.isOpenGroup || pending.isOpenSkill) {
          this.openGroupCallIds.add(pending.id);
          const group = pending.isOpenSkill
            ? extractOpenSkillLabel(parsedArgs)
            : extractOpenGroupName(parsedArgs);
          if (!group || this.live?.opened.includes(group)) return [];
          const openedEvent: ChatEvent = { type: "opened", group };
          this.applyLiveEvent(openedEvent);
          return [openedEvent];
        }

        if (this.activeToolCalls.has(pending.id)) return [];
        const info: StartedToolCallInfo = {
          id: pending.id,
          rawName: pending.rawName,
          name: displayName(pending.rawName),
          kind: this.resolveToolKind(pending.rawName),
          arg: displayArg(parsedArgs),
        };
        this.activeToolCalls.set(pending.id, info);
        const startEvent: ChatEvent = {
          type: "tool_start",
          id: info.id,
          name: info.name,
          kind: info.kind,
          arg: info.arg,
        };
        this.applyLiveEvent(startEvent);
        return [startEvent];
      }

      case EventType.TOOL_CALL_CHUNK: {
        if (event.toolCallId) {
          let pending = this.pendingCalls.get(event.toolCallId);
          if (!pending && event.toolCallName) {
            pending = {
              id: event.toolCallId,
              rawName: event.toolCallName,
              argsBuf: "",
              isOpenGroup: event.toolCallName === OPEN_TOOL_GROUP,
              isOpenSkill: event.toolCallName === OPEN_SKILL,
            };
            this.pendingCalls.set(event.toolCallId, pending);
          }
          if (pending && event.delta) {
            pending.argsBuf += event.delta;
          }
        }
        return [];
      }

      case EventType.TOOL_CALL_RESULT: {
        if (this.openGroupCallIds.has(event.toolCallId)) return [];
        const threadCall = findToolCall(this.thread, event.toolCallId);
        if (
          threadCall?.function.name === OPEN_TOOL_GROUP ||
          threadCall?.function.name === OPEN_SKILL
        ) {
          this.openGroupCallIds.add(event.toolCallId);
          return [];
        }

        const info = this.activeToolCalls.get(event.toolCallId);
        if (!info || this.completedToolCallIds.has(event.toolCallId)) return [];
        this.completedToolCallIds.add(event.toolCallId);

        const meta = resultMetadata(event.metadata);
        const ok = isToolOutcomeOk(undefined, meta);
        const duration =
          typeof meta.durationMs === "number" ? this.formatDuration(meta.durationMs) : "";
        const endEvent: Extract<ChatEvent, { type: "tool_end" }> = {
          type: "tool_end",
          id: info.id,
          name: info.name,
          kind: info.kind,
          arg: info.arg,
          duration,
          ok,
          ...(meta.quarantined ? { responseQuarantined: true } : {}),
        };
        this.applyLiveEvent(endEvent);
        return [endEvent];
      }

      case EventType.REASONING_MESSAGE_START: {
        // Separate distinct reasoning blocks across multi-step turns cleanly.
        if (this.live?.streamingReasoning.trim().length) {
          const sep: ChatEvent = { type: "reasoning_delta", text: "\n\n" };
          this.applyLiveEvent(sep);
          return [sep];
        }
        return [];
      }

      case EventType.REASONING_START:
      case EventType.REASONING_MESSAGE_END:
      case EventType.REASONING_END:
      case EventType.REASONING_ENCRYPTED_VALUE:
        return [];

      case EventType.REASONING_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_CHUNK: {
        if (!event.delta) return [];
        const reasoningEvent: ChatEvent = { type: "reasoning_delta", text: event.delta };
        this.applyLiveEvent(reasoningEvent);
        return [reasoningEvent];
      }

      case EventType.MESSAGES_SNAPSHOT:
        return this.handleMessagesSnapshot(event.messages);

      case EventType.STATE_SNAPSHOT:
      case EventType.STATE_DELTA:
      case EventType.ACTIVITY_SNAPSHOT:
      case EventType.ACTIVITY_DELTA:
      case EventType.RAW:
        return [];

      case EventType.CUSTOM:
        return this.handleCustomEvent(event);

      case EventType.SUBAGENT_STARTED: {
        this.trackedSubagents.set(event.subagentRunId, {
          id: event.subagentRunId,
          name: event.name,
          status: "running",
          current: event.description ?? null,
        });
        return this.emitSubagentStatus();
      }

      case EventType.SUBAGENT_FINISHED: {
        if (event.outcome?.type === "suspended") {
          const prev = this.trackedSubagents.get(event.subagentRunId);
          if (prev) {
            this.trackedSubagents.set(event.subagentRunId, { ...prev, status: "suspended" });
          }
        } else {
          this.trackedSubagents.delete(event.subagentRunId);
        }
        return this.emitSubagentStatus();
      }

      case EventType.SUBAGENT_ERROR: {
        this.trackedSubagents.delete(event.subagentRunId);
        return this.emitSubagentStatus();
      }

      default: {
        const _exhaustive: never = event;
        void _exhaustive;
        return [];
      }
    }
  }

  onApprovalSettled(decisionId: string, outcome: ApprovalOutcome): ChatEvent[] {
    if (this.settledDecisionIds.has(decisionId)) return [];

    const matchesBlocking =
      this.live?.pending?.decisionId === decisionId || this.openBlockingDecisionId === decisionId;
    const matchesDeferred =
      this.openDeferredDecisionIds.has(decisionId) ||
      Boolean(this.live?.deferredApprovals.some((d) => d.decisionId === decisionId));

    if (!matchesBlocking && !matchesDeferred) return [];

    this.settledDecisionIds.add(decisionId);
    if (matchesBlocking) this.openBlockingDecisionId = null;
    if (matchesDeferred) this.openDeferredDecisionIds.delete(decisionId);

    const settledEvent: ChatEvent = { type: "settled", decisionId, outcome };
    this.applyLiveEvent(settledEvent);
    return [settledEvent];
  }

  onDeferredApproval(
    event: Extract<ChatEvent, { type: "deferred_approval" }>,
  ): ChatEvent[] {
    if (
      this.settledDecisionIds.has(event.decisionId) ||
      this.openDeferredDecisionIds.has(event.decisionId)
    ) {
      return [];
    }
    this.openDeferredDecisionIds.add(event.decisionId);
    this.applyLiveEvent(event);
    return [event];
  }

  snapshot(): LiveTurnSnapshot | null {
    return this.live ? cloneSnapshot(this.live) : null;
  }

  reset(): void {
    this.thread = [];
    this.live = null;
    this.currentRunId = null;
    this.awaitingResume = false;
    this.clearTurnScratch();
    this.openDeferredDecisionIds.clear();
    this.settledDecisionIds.clear();
    this.trackedSubagents.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private clearTurnScratch(): void {
    this.pendingReset = null;
    this.openTextMessages.clear();
    this.pendingAssistantId = null;
    this.pendingAssistantText = "";
    this.lastAssistantId = null;
    this.lastNonEmptyAssistantId = null;
    this.lastNonEmptyAssistantText = "";
    this.pendingCalls.clear();
    this.activeToolCalls.clear();
    this.completedToolCallIds.clear();
    this.openGroupCallIds.clear();
    this.openBlockingDecisionId = null;
  }

  private clearActiveTurn(): void {
    this.live = null;
    this.awaitingResume = false;
    this.clearTurnScratch();
  }

  private flushPendingAssistantAsSay(): ChatEvent[] {
    if (!this.pendingAssistantText.length) return [];
    const body = this.pendingAssistantText;
    this.pendingAssistantText = "";
    this.pendingAssistantId = null;
    const sayEvent: ChatEvent = { type: "say", body };
    this.applyLiveEvent(sayEvent);
    return [sayEvent];
  }

  private handleCustomEvent(event: Extract<AGUIEvent, { type: EventType.CUSTOM }>): ChatEvent[] {
    if (!isCustomEventName(event.name)) return [];
    const customName: CustomEventName = event.name;
    switch (customName) {
      case CUSTOM_EVENTS.retry: {
        const val = customValue(event, CUSTOM_EVENTS.retry);
        this.pendingReset = {
          scope: "step",
          reason: val?.error ? `retry: ${val.error}` : "retry",
        };
        return [];
      }
      case CUSTOM_EVENTS.routeAdvanced: {
        const val = customValue(event, CUSTOM_EVENTS.routeAdvanced);
        this.pendingReset = {
          scope: "attempt",
          reason: val?.error ? `route_advanced: ${val.error}` : "route_advanced",
        };
        return [];
      }
      case CUSTOM_EVENTS.guardrail:
        return [];
      default: {
        const _exhaustiveCustom: never = customName;
        void _exhaustiveCustom;
        return [];
      }
    }
  }

  private handleInterruptOutcome(interrupts: readonly Interrupt[]): ChatEvent[] {
    const out: ChatEvent[] = this.flushPendingAssistantAsSay();
    for (const interrupt of interrupts) {
      const approvalEvent = this.buildApprovalEvent(interrupt);
      this.openBlockingDecisionId = approvalEvent.decisionId;
      this.settledDecisionIds.delete(approvalEvent.decisionId);
      this.applyLiveEvent(approvalEvent);
      out.push(approvalEvent);
    }
    this.awaitingResume = true;
    return out;
  }

  private buildApprovalEvent(interrupt: Interrupt): Extract<ChatEvent, { type: "approval" }> {
    const toolCallId = interrupt.toolCallId ?? "";
    const resolved = this.resolveApproval?.(interrupt.id, toolCallId);
    if (resolved) {
      return {
        type: "approval",
        decisionId: resolved.decisionId,
        ref: resolved.ref,
        title: resolved.title,
        why: resolved.why,
        hold: resolved.hold,
        tool: resolved.tool,
        facts: resolved.facts,
        actions: resolved.actions,
      };
    }

    const activeInfo = toolCallId ? this.activeToolCalls.get(toolCallId) : undefined;
    const threadCall = toolCallId ? findToolCall(this.thread, toolCallId) : undefined;
    const toolDisplay =
      activeInfo?.name ?? (threadCall ? displayName(threadCall.function.name) : "tool");

    return {
      type: "approval",
      decisionId: interrupt.id,
      ref: interrupt.id,
      title: interrupt.message ?? `Allow ${toolDisplay}?`,
      why: null,
      hold: DEFAULT_HOLD,
      tool: toolDisplay,
      facts: [["Call", toolDisplay]],
      actions: [
        { id: `${interrupt.id}:allow`, label: "Go ahead", stance: "affirm" },
        { id: `${interrupt.id}:deny`, label: "Not this one", stance: "quiet" },
      ],
    };
  }

  private handleMessagesSnapshot(messages: readonly Message[]): ChatEvent[] {
    const resetInfo = this.pendingReset ?? {
      scope: "step" as const,
      reason: "messages_snapshot",
    };
    this.pendingReset = null;

    if (!this.live) return [];

    // Locate the opening `user` or `developer` message of the active turn so prior
    // completed turns in the thread never bleed into the rebuilt live snapshot.
    let openingIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const role = messages[i]?.role;
      if (role === "user" || role === "developer") {
        openingIdx = i;
        break;
      }
    }

    let source: "text" | "subagent" = this.live.source;
    let asked = this.live.asked;
    let turnSlice: readonly Message[];
    if (openingIdx !== -1) {
      const opening = messages[openingIdx]!;
      if (opening.role === "developer") {
        source = "subagent";
        asked = "";
      } else if (opening.role === "user") {
        source = "text";
        asked = contentToText(opening.content);
      }
      turnSlice = messages.slice(openingIdx + 1);
    } else {
      turnSlice = messages;
    }

    // Reset all per-turn buffers and rebuild strictly from surviving `turnSlice`.
    const prevDeferred = [...this.live.deferredApprovals];
    const prevSubagents = this.live.activeSubagents.map((s) => ({ ...s }));
    const turnId = this.live.turnId;

    this.openTextMessages.clear();
    this.pendingAssistantId = null;
    this.pendingAssistantText = "";
    this.lastAssistantId = null;
    this.lastNonEmptyAssistantId = null;
    this.lastNonEmptyAssistantText = "";
    this.pendingCalls.clear();
    this.activeToolCalls.clear();
    this.completedToolCallIds.clear();
    this.openGroupCallIds.clear();
    this.openBlockingDecisionId = null;
    this.awaitingResume = false;

    const resultsByCallId = new Map<string, ToolMessage>();
    for (const msg of turnSlice) {
      if (msg.role === "tool") {
        resultsByCallId.set(msg.toolCallId, msg);
      }
    }

    const said: string[] = [];
    const calls: ChatToolCall[] = [];
    const opened: string[] = [];
    const openedSet = new Set<string>();
    const reasoningParts: string[] = [];

    for (const msg of turnSlice) {
      if (msg.role === "reasoning") {
        const text = typeof msg.content === "string" ? msg.content.trim() : "";
        if (text) reasoningParts.push(text);
        continue;
      }
      if (msg.role !== "assistant") continue;
      this.lastAssistantId = msg.id;
      if (msg.content && msg.content.length > 0) {
        said.push(msg.content);
        this.lastNonEmptyAssistantId = msg.id;
        this.lastNonEmptyAssistantText = msg.content;
      }
      if (!msg.toolCalls?.length) continue;

      for (const tc of msg.toolCalls) {
        const parsedArgs = parseJsonObject(tc.function.arguments);
        if (tc.function.name === OPEN_TOOL_GROUP || tc.function.name === OPEN_SKILL) {
          this.openGroupCallIds.add(tc.id);
          const group =
            tc.function.name === OPEN_SKILL
              ? extractOpenSkillLabel(parsedArgs)
              : extractOpenGroupName(parsedArgs);
          if (group && !openedSet.has(group)) {
            openedSet.add(group);
            opened.push(group);
          }
          continue;
        }

        if (this.activeToolCalls.has(tc.id)) continue;
        const info: StartedToolCallInfo = {
          id: tc.id,
          rawName: tc.function.name,
          name: displayName(tc.function.name),
          kind: this.resolveToolKind(tc.function.name),
          arg: displayArg(parsedArgs),
        };
        this.activeToolCalls.set(tc.id, info);

        const resultMsg = resultsByCallId.get(tc.id);
        if (resultMsg) {
          this.completedToolCallIds.add(tc.id);
          const meta = resultMetadata(resultMsg.metadata);
          const ok = isToolOutcomeOk(resultMsg.error, meta);
          const duration =
            typeof meta.durationMs === "number" ? this.formatDuration(meta.durationMs) : "";
          calls.push({
            id: info.id,
            name: info.name,
            arg: info.arg,
            duration,
            kind: info.kind,
            ok,
            status: ok ? "completed" : "failed",
          });
        } else {
          calls.push({
            id: info.id,
            name: info.name,
            arg: info.arg,
            duration: "",
            kind: info.kind,
            ok: true,
            status: "running",
          });
        }
      }
    }

    const rebuilt: LiveTurnSnapshot = {
      turnId,
      asked,
      source,
      said,
      streamingText: "",
      streamingReasoning: reasoningParts.join("\n\n"),
      calls,
      opened,
      pending: null,
      deferredApprovals: prevDeferred,
      activeSubagents: prevSubagents,
      error: null,
    };
    this.live = rebuilt;

    return [
      {
        type: "reset",
        scope: resetInfo.scope,
        reason: resetInfo.reason,
        live: cloneSnapshot(rebuilt),
      },
    ];
  }

  private emitSubagentStatus(): ChatEvent[] {
    const subagents = [...this.trackedSubagents.values()].map((s) => ({ ...s }));
    const ev: ChatEvent = { type: "subagent_status", subagents };
    this.applyLiveEvent(ev);
    return [ev];
  }

  /**
   * Mirrors `web/src/app/chat.ts`'s pure `apply()` reducer step-for-step so
   * `snapshot()` stays in strict lockstep with client state at every event index.
   */
  private applyLiveEvent(event: ChatEvent): void {
    const live = this.live;
    if (!live) return;

    switch (event.type) {
      case "delta":
        live.streamingText += event.text;
        break;
      case "reasoning_delta":
        live.streamingReasoning += event.text;
        break;
      case "opened":
        if (!live.opened.includes(event.group)) {
          live.opened.push(event.group);
        }
        break;
      case "say":
        live.said.push(event.body);
        live.streamingText = "";
        break;
      case "tool_start": {
        const nextCall: ChatToolCall = {
          id: event.id,
          name: event.name,
          arg: event.arg,
          duration: "",
          kind: event.kind,
          ok: true,
          status: "running",
        };
        const idx = live.calls.findIndex((c) => c.id === event.id);
        if (idx !== -1) live.calls[idx] = nextCall;
        else live.calls.push(nextCall);
        break;
      }
      case "tool_end": {
        const updatedCall: ChatToolCall = {
          id: event.id,
          name: event.name,
          arg: event.arg,
          duration: event.duration,
          kind: event.kind,
          ok: event.ok,
          status: event.ok ? "completed" : "failed",
        };
        const idx = live.calls.findIndex((c) => c.id === event.id);
        if (idx !== -1) live.calls[idx] = updatedCall;
        else live.calls.push(updatedCall);
        break;
      }
      case "approval":
        live.pending = event;
        break;
      case "deferred_approval":
        if (!live.deferredApprovals.some((d) => d.decisionId === event.decisionId)) {
          live.deferredApprovals.push(event);
        }
        break;
      case "settled":
        if (live.pending && live.pending.decisionId === event.decisionId) {
          live.pending = null;
        }
        live.deferredApprovals = live.deferredApprovals.filter(
          (d) => d.decisionId !== event.decisionId,
        );
        break;
      case "subagent_status":
        live.activeSubagents = event.subagents.map((s) => ({ ...s }));
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Checkpoint Hydration (`hydrateTurnsFromThread`)
// ---------------------------------------------------------------------------

interface AgentBucket {
  defaultSource: "text" | "voice" | "subagent";
  messages: Message[];
}

/**
 * Hydrate persisted `ChatTurnRow[]` directly from an AG-UI `Message[]` thread stored
 * in a session checkpoint — guaranteed field-for-field equivalent to what the live
 * `AgUiToChatEventTranslator` + client reducer produces.
 */
export function hydrateTurnsFromThread(
  thread: readonly Message[],
  options: HydrateTurnsOptions = {},
): ChatTurnRow[] {
  const now = options.now ?? new Date();
  const resolveToolKind = options.resolveToolKind ?? (() => "read");
  const approvalsByToolCallId = options.approvalsByToolCallId;

  const rows: ChatTurnRow[] = [];
  let bucket: AgentBucket | null = null;

  const flushBucket = (): void => {
    if (!bucket) return;
    const current = bucket;
    bucket = null;

    const assistants = current.messages.filter(
      (m): m is AssistantMessage => m.role === "assistant",
    );
    if (!assistants.length) return;

    const toolResultsByCallId = new Map<string, ToolMessage>();
    for (const m of current.messages) {
      if (m.role === "tool") {
        toolResultsByCallId.set(m.toolCallId, m);
      }
    }

    const opened: string[] = [];
    const openedSet = new Set<string>();
    const calls: ChatToolCall[] = [];
    const seenCallIds = new Set<string>();
    const reasoningParts: string[] = [];
    let approval: ChatApproval | null = null;
    let lastWithContent: AssistantMessage | null = null;
    let resolvedSource: "text" | "voice" | "subagent" = current.defaultSource;

    for (const m of current.messages) {
      if (m.role === "reasoning") {
        const text = typeof m.content === "string" ? m.content.trim() : "";
        if (text) reasoningParts.push(text);
      }
    }
    const reasoning = reasoningParts.length ? reasoningParts.join("\n\n") : null;

    for (const assistant of assistants) {
      const explicitSource = metadataSource(assistant);
      if (explicitSource === "voice" || explicitSource === "subagent") {
        resolvedSource = explicitSource;
      }
      if (assistant.content && assistant.content.length > 0) {
        lastWithContent = assistant;
      }
      if (!assistant.toolCalls?.length) continue;

      for (const tc of assistant.toolCalls) {
        const parsedArgs = parseJsonObject(tc.function.arguments);
        if (tc.function.name === OPEN_TOOL_GROUP || tc.function.name === OPEN_SKILL) {
          const group =
            tc.function.name === OPEN_SKILL
              ? extractOpenSkillLabel(parsedArgs)
              : extractOpenGroupName(parsedArgs);
          if (group && !openedSet.has(group)) {
            openedSet.add(group);
            opened.push(group);
          }
          continue;
        }

        if (seenCallIds.has(tc.id)) continue;
        seenCallIds.add(tc.id);

        const name = displayName(tc.function.name);
        const kind = resolveToolKind(tc.function.name);
        const arg = displayArg(parsedArgs);
        const resultMsg = toolResultsByCallId.get(tc.id);

        if (resultMsg) {
          const meta = resultMetadata(resultMsg.metadata);
          const ok = isToolOutcomeOk(resultMsg.error, meta);
          const duration =
            typeof meta.durationMs === "number" ? defaultFormatDuration(meta.durationMs) : "";
          calls.push({
            id: tc.id,
            name,
            arg,
            duration,
            kind,
            ok,
            status: ok ? "completed" : "failed",
          });
        } else {
          calls.push({
            id: tc.id,
            name,
            arg,
            duration: "",
            kind,
            ok: true,
            status: "running",
          });
        }

        const matchedApproval = approvalsByToolCallId?.get(tc.id);
        if (matchedApproval) {
          approval = matchedApproval;
        }
      }
    }

    const primaryAssistant = lastWithContent ?? assistants[assistants.length - 1]!;
    rows.push({
      id: primaryAssistant.id,
      by: "agent",
      body: primaryAssistant.content ?? "",
      at: formatMessageStamp(primaryAssistant, now),
      note: noteFor(opened),
      toolSummary: summarizeDisplayCalls(calls),
      calls,
      approval,
      ...(reasoning ? { reasoning } : {}),
      source: resolvedSource,
    });
  };

  for (const msg of thread) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      flushBucket();
      const source: "text" | "voice" = metadataSource(msg) === "voice" ? "voice" : "text";
      rows.push({
        id: msg.id,
        by: "user",
        body: contentToText(msg.content),
        at: formatMessageStamp(msg, now),
        note: null,
        toolSummary: null,
        calls: [],
        approval: null,
        source,
      });
      bucket = { defaultSource: source, messages: [] };
      continue;
    }

    if (msg.role === "developer") {
      flushBucket();
      bucket = { defaultSource: "subagent", messages: [] };
      continue;
    }

    if (!bucket) {
      bucket = { defaultSource: "text", messages: [] };
    }
    bucket.messages.push(msg);
  }

  flushBucket();

  if (options.deferredApprovals?.length) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (row.by === "agent") {
        row.deferredApprovals = [...options.deferredApprovals];
        break;
      }
    }
  }

  return rows;
}
