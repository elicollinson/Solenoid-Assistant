import { randomBytes } from "node:crypto";
import {
  EventType,
  contentToText,
  type AGUIEvent,
  type Interrupt,
  type Message,
} from "@ag-ui/core";
import {
  APPROVAL_REASON,
  AgentAbortedError,
  AppSettingsSchema,
  approvalAnswer,
  createHarness,
  findToolCall,
  type AgentProfile,
  type AgentTool,
  type ExternalTurnInput,
  type Harness,
  type PendingInterrupt,
  type ReconciledSession,
  type Session,
  type SubagentDeferRequest,
  type ToolSettledInfo,
} from "@elicollinson/solenoid-engine";
import {
  AlreadySettledError,
  ApprovalBroker,
  capabilityFor,
  computeArgsDigest,
  resolveScopedPermission,
  type ApprovalChoice,
  type ApprovalRecord,
  type PermissionMode,
  type PermissionRules,
} from "@elicollinson/solenoid-security";
import { and, eq, isNull } from "drizzle-orm";
import { createChatProfile } from "../agents/chat";
import { loadRuntimeConfig } from "../core/config";
import { createEngineLogger } from "../core/engine";
import { log } from "../core/logger";
import { privateSourceContext } from "../core/privateSourceContext";
import { createModelRoutes } from "../core/providerFactory";
import { getDb, ulid, type Db } from "../db";
import { DrizzleApprovalStore, DrizzleCheckpointStore } from "../db/chatCheckpoints";
import { NoSuchDecisionError } from "../db/mutations/chat";
import { clock } from "../db/queries/_format";
import * as s from "../db/schema";
import { createSecurityScreener } from "../safety/modelArmor";
import type {
  ApprovalOutcome,
  ChatChoice,
  ChatEvent,
  ChatFact,
  LiveTurnSnapshot,
} from "../shared/chat";
import { compileToolCatalog } from "../tools/groupAdapter";
import { DEFAULT_APPROVAL_MS, NotWaitingError } from "./session";
import { AgUiToChatEventTranslator, type TranslatorApprovalContext } from "./translator";
import { displayArg, displayName } from "./turn";

const DEFAULT_HOLD = "Nothing has been written. I stopped before the call.";
const DEFERRED_HOLD = "Deferred by subagent — nothing has been written.";
const DEFAULT_IDLE_EVICT_MS = 15 * 60_000;

export interface SessionCoordinatorOptions {
  db: Db;
  /** Optional pre-built engine harness (injected in tests with ScriptedProvider). */
  harness?: Harness;
  /** Optional profile builder for a conversation session. */
  profileFactory?: (conversationId: string) => AgentProfile;
  /** Blocking approval timeout in ms (defaults to 10 minutes). */
  approvalTimeoutMs?: number;
  /** Idle eviction threshold in ms for in-memory sessions. */
  idleEvictMs?: number;
  /** Tool resolver for executing deferred subagent writes on approval. */
  resolveTool?: (name: string) => Promise<AgentTool | undefined>;
}

export interface AnswerDecisionResult {
  decisionId: string;
  outcome: ApprovalOutcome;
  /** True when a blocking interrupt (in-memory or crash-resumed from checkpoint) resumed. */
  resumed?: boolean;
  /** True when a deferred subagent write was settled/rechecked. */
  deferred?: boolean;
}

interface ToolMetadata {
  kind: "read" | "write";
  description: string;
  group: string;
  tool: AgentTool;
}

interface PendingBlockingApproval {
  decisionId: string;
  interruptId: string;
  toolCallId: string;
  tool: string;
  ref: string;
  title: string;
  why: string | null;
  hold: string | null;
  facts: ChatFact[];
  actions: ChatChoice[];
  timer?: ReturnType<typeof setTimeout>;
}

interface ConversationEntry {
  conversationId: string;
  session: Session;
  translator: AgUiToChatEventTranslator;
  toolKinds: Map<string, "read" | "write">;
  toolMeta: Map<string, ToolMetadata>;
  activeAborts: Set<AbortController>;
  inFlightCount: number;
  blockingByInterruptId: Map<string, PendingBlockingApproval>;
  decisionIdByToolCallId: Map<string, string>;
  activeSubagentIds: Set<string>;
  openDeveloperMessages: Map<string, string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  offAutoTurn: (() => void) | null;
  closed: boolean;
}

function mintOpaqueChoiceId(): string {
  return randomBytes(18).toString("base64url");
}

function cap(text: string, at: number): string {
  return text.length > at ? `${text.slice(0, at - 1)}…` : text;
}

function groupFromToolName(tool: string): string {
  const cut = tool.indexOf("_");
  return cut > 0 ? tool.slice(0, cut) : tool;
}

function askTitle(
  group: string,
  description: string,
  said: string | undefined,
  subagentName?: string,
): string {
  const spoken = said?.trim();
  if (spoken) return cap(spoken, 240);
  const first = description.split(/(?<=[.!?])\s/)[0]?.trim() ?? description;
  const subject = subagentName
    ? `${subagentName} would like to write to your ${group.replace(/_/g, " ")}.`
    : `I'd like to write to your ${group.replace(/_/g, " ")}.`;
  return cap(`${subject} ${first}`, 240);
}

function whyFor(description: string): string | null {
  const first = description.split(/(?<=[.!?])\s/)[0]?.trim();
  return first ? cap(first, 220) : null;
}

function factsFor(tool: string, args: unknown): ChatFact[] {
  const facts: ChatFact[] = [["Call", displayName(tool)]];
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      if (value === undefined || value === null || value === "") continue;
      const rendered =
        typeof value === "string"
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

function collectProfileTools(profile: AgentProfile): {
  toolKinds: Map<string, "read" | "write">;
  toolMeta: Map<string, ToolMetadata>;
} {
  const toolKinds = new Map<string, "read" | "write">();
  const toolMeta = new Map<string, ToolMetadata>();

  const recordTool = (tool: AgentTool, group: string) => {
    const name = tool.definition.function.name;
    const kind: "read" | "write" = tool.kind === "write" ? "write" : "read";
    toolKinds.set(name, kind);
    toolMeta.set(name, {
      kind,
      description: tool.definition.function.description,
      group,
      tool,
    });
  };

  for (const tool of profile.tools ?? []) {
    recordTool(tool, groupFromToolName(tool.definition.function.name));
  }
  for (const group of profile.toolGroups ?? []) {
    for (const tool of group.tools) {
      recordTool(tool, group.name);
    }
  }

  return { toolKinds, toolMeta };
}

function extractPendingInterrupts(pending: unknown): PendingInterrupt[] {
  if (!pending || typeof pending !== "object") return [];
  const list = (pending as { interrupts?: unknown }).interrupts;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item): item is PendingInterrupt =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as { interruptId?: unknown }).interruptId === "string" &&
      typeof (item as { toolCallId?: unknown }).toolCallId === "string",
  );
}

/**
 * Per-conversation runtime coordinator owning active `solenoid-engine` `Session`
 * instances, persistent SSE subscriber fan-out, durable Phase 2 restart resume,
 * subagent `defer` settlement, and serialized Gemini Live voice turn appends.
 */
export class SessionCoordinator {
  private readonly db: Db;
  private readonly checkpointStore: DrizzleCheckpointStore;
  private readonly approvalStore: DrizzleApprovalStore;
  private readonly broker: ApprovalBroker;
  private readonly providedHarness?: Harness;
  private readonly profileFactory?: (conversationId: string) => AgentProfile;
  private readonly approvalTimeoutMs: number;
  private readonly idleEvictMs: number;
  private readonly resolveToolOption?: (name: string) => Promise<AgentTool | undefined>;

  private defaultHarnessPromise?: Promise<Harness>;
  private defaultHarness?: Harness;
  private catalogToolsCache?: Map<string, AgentTool>;

  private readonly entries = new Map<string, ConversationEntry>();
  private readonly hydrating = new Map<string, Promise<ConversationEntry>>();
  private readonly subscribers = new Map<string, Set<(event: ChatEvent) => void>>();
  private closed = false;

  constructor(options: SessionCoordinatorOptions) {
    this.db = options.db;
    this.checkpointStore = new DrizzleCheckpointStore(options.db);
    this.approvalStore = new DrizzleApprovalStore(options.db);
    this.broker = new ApprovalBroker({
      store: this.approvalStore,
      defaultHold: DEFAULT_HOLD,
    });
    this.providedHarness = options.harness;
    this.profileFactory = options.profileFactory;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_MS;
    this.idleEvictMs = options.idleEvictMs ?? DEFAULT_IDLE_EVICT_MS;
    this.resolveToolOption = options.resolveTool;
  }

  /** Subscribe to live `ChatEvent`s for `conversationId`; immediately pushes a `snapshot` frame. */
  subscribe(conversationId: string, listener: (event: ChatEvent) => void): () => void {
    let set = this.subscribers.get(conversationId);
    if (!set) {
      set = new Set();
      this.subscribers.set(conversationId, set);
    }
    set.add(listener);

    try {
      listener({ type: "snapshot", live: this.getLiveSnapshot(conversationId) });
    } catch (error) {
      log.warn("chat subscriber threw on initial snapshot", {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      set.delete(listener);
      if (set.size === 0) {
        this.subscribers.delete(conversationId);
      }
    };
  }

  /** Current serializable live turn snapshot, or null when idle. */
  getLiveSnapshot(conversationId: string): LiveTurnSnapshot | null {
    return this.entries.get(conversationId)?.translator.snapshot() ?? null;
  }

  /** Enqueue a user turn into the conversation's serialized session queue. */
  async send(
    conversationId: string,
    text: string,
    _options?: { now?: Date },
  ): Promise<{ turnId: string }> {
    const entry = await this.ensureEntry(conversationId);
    const turnId = ulid();
    void this.runSessionTurn(entry, (onEvent, signal) =>
      entry.session.send(text, { onEvent, signal }),
    );
    return { turnId };
  }

  /** Cancel the active in-flight turn for `conversationId`, if any. */
  async cancel(conversationId: string): Promise<boolean> {
    const entry = this.entries.get(conversationId);
    if (!entry || (entry.inFlightCount === 0 && entry.blockingByInterruptId.size === 0)) {
      return false;
    }

    // Clear and expire any open blocking approval gates held by the cancelled turn.
    for (const [interruptId, pending] of [...entry.blockingByInterruptId]) {
      if (pending.timer) clearTimeout(pending.timer);
      entry.blockingByInterruptId.delete(interruptId);
      try {
        this.approvalStore.settle({
          approvalId: pending.decisionId,
          outcome: "expired",
          chosenId: null,
          settledNote: "Cancelled before answer — nothing was written.",
          now: new Date(),
        });
        const settledEvents = entry.translator.onApprovalSettled(pending.decisionId, "expired");
        this.broadcast(
          conversationId,
          settledEvents.length
            ? settledEvents
            : [{ type: "settled", decisionId: pending.decisionId, outcome: "expired" }],
        );
      } catch (error) {
        if (!(error instanceof AlreadySettledError)) {
          log.warn("failed to settle cancelled approval", {
            conversationId,
            decisionId: pending.decisionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    for (const controller of [...entry.activeAborts]) {
      controller.abort();
    }
    return true;
  }

  /**
   * Answer either a blocking chat approval (live OR crash-resumed from SQLite Phase 2
   * `interrupt` checkpoint) or a deferred subagent write approval (with live permission
   * re-check and settlement note appended into the parent session checkpoint).
   */
  async answerDecision(
    actionId: string,
    options?: { now?: Date },
  ): Promise<AnswerDecisionResult> {
    const found = this.approvalStore.findByChoiceId(actionId);
    if (!found) {
      throw new NoSuchDecisionError(actionId);
    }

    if (found.record.mode === "deferred") {
      return this.answerDeferredDecision(actionId, found.record, options?.now ?? new Date());
    }

    return this.answerBlockingDecision(found.record, found.choice, options?.now ?? new Date());
  }

  /** Append a Gemini Live voice turn into the conversation's checkpoint behind the session queue. */
  async appendVoiceTurn(conversationId: string, input: ExternalTurnInput): Promise<void> {
    const entry = await this.ensureEntry(conversationId);
    this.cancelIdleEvict(entry);
    entry.inFlightCount++;
    try {
      await entry.session.appendExternalTurn(input);
    } finally {
      entry.inFlightCount--;
      this.scheduleIdleEvictIfReady(entry);
    }
  }

  /** Reconcile orphaned `running` sessions after server boot without replaying writes. */
  async reconcileOnBoot(): Promise<ReconciledSession[]> {
    return this.checkpointStore.reconcileOrphaned();
  }

  /** Whether an in-memory session is currently loaded for `conversationId`. */
  isActive(conversationId: string): boolean {
    return this.entries.has(conversationId);
  }

  /** Close all active sessions, timers, and subscribers cleanly. */
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of [...this.entries.values()]) {
      this.disposeEntry(entry, { preservePendingApprovals: true });
    }
    this.entries.clear();
    this.hydrating.clear();
    this.subscribers.clear();

    if (this.defaultHarness) {
      const harness = this.defaultHarness;
      this.defaultHarness = undefined;
      this.defaultHarnessPromise = undefined;
      await harness.close();
    }
  }

  // -------------------------------------------------------------------------
  // Blocking & deferred decision handlers
  // -------------------------------------------------------------------------

  private async answerBlockingDecision(
    record: ApprovalRecord,
    choice: ApprovalChoice,
    now: Date,
  ): Promise<AnswerDecisionResult> {
    const outcome: ApprovalOutcome = choice.approves ? "approved" : "declined";
    const settledNote = `You said "${choice.label}", ${clock(now)}.`;

    // Atomically settle in SQLite BEFORE any await so concurrent double-clicks
    // cannot both pass the open check.
    this.approvalStore.settle({
      approvalId: record.id,
      outcome,
      chosenId: choice.id,
      settledNote,
      now,
    });

    const scope = record.scope ?? {};
    const conversationId =
      typeof scope.conversationId === "string" ? scope.conversationId : undefined;
    const interruptId = typeof scope.interruptId === "string" ? scope.interruptId : undefined;
    const toolCallId = typeof scope.toolCallId === "string" ? scope.toolCallId : undefined;

    if (!conversationId || !interruptId) {
      throw new NotWaitingError(record.id);
    }

    const answer = choice.approves ? "allow" : "decline";

    // Case A: Live in-memory Session is currently suspended on this interrupt.
    const liveEntry = this.entries.get(conversationId);
    const livePending = liveEntry?.blockingByInterruptId.get(interruptId);
    if (liveEntry && livePending) {
      if (livePending.timer) clearTimeout(livePending.timer);
      liveEntry.blockingByInterruptId.delete(interruptId);
      liveEntry.decisionIdByToolCallId.set(livePending.toolCallId, record.id);

      const settledEvents = liveEntry.translator.onApprovalSettled(record.id, outcome);
      this.broadcast(
        conversationId,
        settledEvents.length
          ? settledEvents
          : [{ type: "settled", decisionId: record.id, outcome }],
      );

      try {
        liveEntry.session.resume([approvalAnswer(interruptId, answer)]);
      } catch {
        throw new NotWaitingError(record.id);
      }
      return { decisionId: record.id, outcome, resumed: true };
    }

    // Case B: Process restarted or session evicted — resume durably from Phase 2 checkpoint.
    const loaded = await this.checkpointStore.load(conversationId);
    const pendingInterrupts = extractPendingInterrupts(loaded?.checkpoint.pending);
    const matchedInterrupt = pendingInterrupts.find(
      (item) => item.interruptId === interruptId || (toolCallId && item.toolCallId === toolCallId),
    );
    if (!loaded || !matchedInterrupt) {
      throw new NotWaitingError(record.id);
    }

    const entry = await this.ensureEntry(conversationId);
    const hasRestored = entry.session.pendingInterrupts.some(
      (item) => item.interruptId === matchedInterrupt.interruptId,
    );
    if (!hasRestored) {
      throw new NotWaitingError(record.id);
    }

    entry.decisionIdByToolCallId.set(matchedInterrupt.toolCallId, record.id);
    this.primeTranslatorForResume(entry, loaded.checkpoint.thread, matchedInterrupt, record, outcome);
    this.broadcast(conversationId, [{ type: "settled", decisionId: record.id, outcome }]);

    void this.runSessionTurn(entry, (onEvent, signal) =>
      entry.session.continueFromInterrupt(
        [approvalAnswer(matchedInterrupt.interruptId, answer)],
        { onEvent, signal },
      ),
    );

    return { decisionId: record.id, outcome, resumed: true };
  }

  private async answerDeferredDecision(
    actionId: string,
    record: ApprovalRecord,
    now: Date,
  ): Promise<AnswerDecisionResult> {
    const scope = record.scope ?? {};
    const conversationId =
      typeof scope.conversationId === "string" ? scope.conversationId : undefined;

    const rechecked = await this.broker.recheckAndAuthorize({
      choiceId: actionId,
      now,
      resolvePermission: (toolName, _capability, latestRecord) =>
        this.resolveLivePermission(toolName, latestRecord),
      resolveTool: async (toolName) => {
        const tool = await this.resolveExecutableTool(toolName, conversationId);
        if (!tool) return undefined;
        return {
          name: tool.definition.function.name,
          validateArgs: (args) => {
            const parsed = tool.schema.safeParse(args);
            return parsed.success
              ? { ok: true as const, data: parsed.data }
              : { ok: false as const, error: parsed.error.message };
          },
          execute: (args) =>
            tool.execute(args, {
              signal: new AbortController().signal,
              offered: new Map([[tool.definition.function.name, tool]]),
              messages: [],
              commit: () => {},
            }),
        };
      },
    });

    const outcome: ApprovalOutcome = rechecked.status === "executed" ? "approved" : "declined";

    if (conversationId) {
      const liveEntry = this.entries.get(conversationId);
      const settledEvents = liveEntry?.translator.onApprovalSettled(record.id, outcome) ?? [];
      this.broadcast(
        conversationId,
        settledEvents.length
          ? settledEvents
          : [{ type: "settled", decisionId: record.id, outcome }],
      );

      const toolDisplay = displayName(rechecked.record.tool);
      const summaryArg = displayArg(rechecked.record.args);
      const argSuffix = summaryArg ? ` (${summaryArg})` : "";

      let settlementNote: string;
      if (rechecked.status === "executed") {
        settlementNote =
          rechecked.outcome.status === "ok"
            ? `Deferred approval settled: ${toolDisplay}${argSuffix} was approved and ran and finished.`
            : `Deferred approval settled: ${toolDisplay}${argSuffix} was approved and failed: ${rechecked.outcome.error ?? "unknown error"}.`;
      } else if (rechecked.status === "refused") {
        settlementNote = `Deferred approval refused for ${toolDisplay}${argSuffix}: ${rechecked.message}`;
      } else {
        settlementNote = `Deferred approval declined: ${toolDisplay}${argSuffix} was not run.`;
      }

      await this.appendSettlementNote(conversationId, settlementNote, now);
    }

    return {
      decisionId: rechecked.record.id,
      outcome,
      deferred: true,
    };
  }

  private async appendSettlementNote(
    conversationId: string,
    note: string,
    now: Date,
  ): Promise<void> {
    const entry = await this.ensureEntry(conversationId);
    this.cancelIdleEvict(entry);
    entry.inFlightCount++;
    try {
      await entry.session.appendExternalTurn({
        source: "deferred_settlement",
        assistantText: note,
        screened: true,
        timestamp: now.toISOString(),
      });
    } finally {
      entry.inFlightCount--;
      this.scheduleIdleEvictIfReady(entry);
    }
  }

  private resolveLivePermission(toolName: string, record: ApprovalRecord): PermissionMode {
    const personRules: PermissionRules | undefined =
      this.providedHarness?.settings.approvals.rules ?? this.defaultHarness?.settings.approvals.rules;

    const globalRows = this.db
      .select({
        capability: s.workflowPermissions.capability,
        mode: s.workflowPermissions.mode,
      })
      .from(s.workflowPermissions)
      .where(
        and(
          isNull(s.workflowPermissions.workflowId),
          isNull(s.workflowPermissions.retiredAt),
        ),
      )
      .all();

    const globalRules: Record<string, PermissionMode> = {};
    for (const row of globalRows) {
      globalRules[row.capability] = row.mode;
    }

    let workflowRules: Record<string, PermissionMode> | undefined;
    const workflowId =
      typeof record.scope?.workflowId === "string" ? record.scope.workflowId : undefined;
    if (workflowId) {
      const wfRows = this.db
        .select({
          capability: s.workflowPermissions.capability,
          mode: s.workflowPermissions.mode,
        })
        .from(s.workflowPermissions)
        .where(
          and(
            eq(s.workflowPermissions.workflowId, workflowId),
            isNull(s.workflowPermissions.retiredAt),
          ),
        )
        .all();
      workflowRules = {};
      for (const row of wfRows) {
        workflowRules[row.capability] = row.mode;
      }
    }

    return resolveScopedPermission({
      tool: toolName,
      ...(personRules ? { person: personRules } : {}),
      global: globalRules,
      ...(workflowRules ? { workflow: workflowRules } : {}),
    }).mode;
  }

  private async resolveExecutableTool(
    toolName: string,
    conversationId?: string,
  ): Promise<AgentTool | undefined> {
    if (this.resolveToolOption) {
      const resolved = await this.resolveToolOption(toolName);
      if (resolved) return resolved;
    }

    if (conversationId) {
      const entryTool = this.entries.get(conversationId)?.toolMeta.get(toolName)?.tool;
      if (entryTool) return entryTool;
    }

    for (const entry of this.entries.values()) {
      const found = entry.toolMeta.get(toolName)?.tool;
      if (found) return found;
    }

    if (!this.catalogToolsCache) {
      const groups = compileToolCatalog({ db: this.db });
      this.catalogToolsCache = new Map();
      for (const group of groups) {
        for (const tool of group.tools) {
          this.catalogToolsCache.set(tool.definition.function.name, tool);
        }
      }
    }
    return this.catalogToolsCache.get(toolName);
  }

  // -------------------------------------------------------------------------
  // Session hydration, turn execution, subagent defer & tool settlement
  // -------------------------------------------------------------------------

  private async getHarness(): Promise<Harness> {
    if (this.providedHarness) return this.providedHarness;
    if (!this.defaultHarnessPromise) {
      this.defaultHarnessPromise = (async () => {
        const config = loadRuntimeConfig();
        const settings = AppSettingsSchema.parse({
          screening: { enabled: false },
          checkpoints: { enabled: true },
          device: { id: "solenoid-server", name: "solenoid-server" },
        });
        const routes = createModelRoutes(config);
        const screener = createSecurityScreener(config) ?? null;
        const harness = await createHarness(settings, {
          checkpointStore: this.checkpointStore,
          routes,
          screener,
          baseTools: [],
          logger: createEngineLogger("chat"),
          shouldTrace: () => !privateSourceContext.getStore(),
        });
        this.defaultHarness = harness;
        return harness;
      })();
    }
    return this.defaultHarnessPromise;
  }

  private async ensureEntry(conversationId: string): Promise<ConversationEntry> {
    const existing = this.entries.get(conversationId);
    if (existing && !existing.closed) return existing;

    const inflight = this.hydrating.get(conversationId);
    if (inflight) return inflight;

    const promise = this.hydrateEntry(conversationId).finally(() => {
      if (this.hydrating.get(conversationId) === promise) {
        this.hydrating.delete(conversationId);
      }
    });
    this.hydrating.set(conversationId, promise);
    return promise;
  }

  private async hydrateEntry(conversationId: string): Promise<ConversationEntry> {
    const harness = await this.getHarness();
    const baseProfile = this.profileFactory
      ? this.profileFactory(conversationId)
      : createChatProfile({ db: this.db });
    const { toolKinds, toolMeta } = collectProfileTools(baseProfile);

    const blockingByInterruptId = new Map<string, PendingBlockingApproval>();
    const translator = new AgUiToChatEventTranslator({
      resolveToolKind: (toolName) => toolKinds.get(toolName) ?? "read",
      resolveApproval: (interruptId, toolCallId): TranslatorApprovalContext | undefined => {
        const byInterrupt = blockingByInterruptId.get(interruptId);
        const matched =
          byInterrupt ??
          [...blockingByInterruptId.values()].find((item) => item.toolCallId === toolCallId);
        if (!matched) return undefined;
        return {
          decisionId: matched.decisionId,
          ref: matched.ref,
          title: matched.title,
          why: matched.why,
          hold: matched.hold,
          tool: displayName(matched.tool),
          facts: matched.facts,
          actions: matched.actions,
        };
      },
    });

    const entry: ConversationEntry = {
      conversationId,
      session: undefined as unknown as Session,
      translator,
      toolKinds,
      toolMeta,
      activeAborts: new Set(),
      inFlightCount: 0,
      blockingByInterruptId,
      decisionIdByToolCallId: new Map(),
      activeSubagentIds: new Set(),
      openDeveloperMessages: new Map(),
      idleTimer: null,
      offAutoTurn: null,
      closed: false,
    };

    const effectiveProfile: AgentProfile = {
      ...baseProfile,
      abortOnWriteQuarantine: baseProfile.abortOnWriteQuarantine ?? true,
      onToolSettled: async (info) => {
        await baseProfile.onToolSettled?.(info);
        this.handleToolSettled(entry, info);
      },
      ...(baseProfile.subagentApproval === "defer" && !baseProfile.onSubagentDefer
        ? {
            onSubagentDefer: (req) => this.handleSubagentDefer(entry, req),
          }
        : {}),
    };

    const store = harness.checkpoints ?? this.checkpointStore;
    const loaded = await store.load(conversationId);
    if (!loaded) {
      await store.save({
        sessionId: conversationId,
        status: "idle",
        kind: "turn_end",
        device: harness.settings.device,
        committed: false,
        transcript: [],
        thread: [],
      });
    }

    const resumed = await harness.resumeSession(conversationId, effectiveProfile);
    if (this.closed) {
      resumed.session.close();
      throw new Error("SessionCoordinator is closed");
    }

    entry.session = resumed.session;
    entry.offAutoTurn = entry.session.onAutoTurn((autoTurn) => {
      void this.runSessionTurn(entry, (onEvent, signal) => autoTurn({ onEvent, signal }));
    });

    this.entries.set(conversationId, entry);
    return entry;
  }

  private runSessionTurn(
    entry: ConversationEntry,
    execute: (onEvent: (event: AGUIEvent) => void, signal: AbortSignal) => Promise<string>,
  ): Promise<void> {
    this.cancelIdleEvict(entry);
    const abort = new AbortController();
    entry.activeAborts.add(abort);
    entry.inFlightCount++;

    const bufferedTerminal: ChatEvent[] = [];

    const onEvent = (aguiEvent: AGUIEvent) => {
      if (entry.closed) return;

      this.trackSubagentLifecycle(entry, aguiEvent);

      if (
        aguiEvent.type === EventType.RUN_FINISHED &&
        aguiEvent.outcome?.type === "interrupt"
      ) {
        this.prepareBlockingApprovals(entry, aguiEvent.outcome.interrupts);
      }

      const rawEvents = entry.translator.push(aguiEvent);
      if (!rawEvents.length) return;

      const immediate: ChatEvent[] = [];
      for (const raw of rawEvents) {
        const ev: ChatEvent =
          raw.type === "tool_end" && raw.kind === "write" && raw.responseQuarantined
            ? { ...raw, ok: true }
            : raw;
        if (ev.type === "message" || ev.type === "error" || ev.type === "cancelled") {
          bufferedTerminal.push(ev);
        } else {
          immediate.push(ev);
        }
      }

      if (immediate.length) {
        this.broadcast(entry.conversationId, immediate);
      }
    };

    // Invoke `execute` synchronously so `Session.running` is claimed before any await.
    let turnPromise: Promise<string>;
    try {
      turnPromise = execute(onEvent, abort.signal);
    } catch (error) {
      turnPromise = Promise.reject(error);
    }

    return turnPromise
      .then(
        () => {},
        (error) => {
          if (!(error instanceof AgentAbortedError)) {
            const message = error instanceof Error ? error.message : String(error);
            log.warn("chat turn failed", {
              conversationId: entry.conversationId,
              error: message,
            });
            if (!bufferedTerminal.some((e) => e.type === "error" || e.type === "cancelled")) {
              bufferedTerminal.push({ type: "error", message });
            }
          }
        },
      )
      .finally(() => {
        entry.activeAborts.delete(abort);
        entry.inFlightCount--;
        if (!entry.closed && bufferedTerminal.length) {
          this.broadcast(entry.conversationId, bufferedTerminal);
        }
        this.scheduleIdleEvictIfReady(entry);
      });
  }

  private trackSubagentLifecycle(entry: ConversationEntry, event: AGUIEvent): void {
    if (event.type === EventType.TOOL_CALL_RESULT) {
      const call = findToolCall(entry.session.messages, event.toolCallId);
      const name = call?.function.name;
      if (name === "spawn_subagent" || name === "message_subagent" || name === "cancel_subagent") {
        try {
          const parsed = JSON.parse(contentToText(event.content)) as { id?: unknown; status?: unknown };
          if (typeof parsed?.id === "string") {
            if (name === "cancel_subagent") {
              entry.activeSubagentIds.delete(parsed.id);
            } else if (parsed.status === "queued" || parsed.status === "running") {
              entry.activeSubagentIds.add(parsed.id);
            }
          }
        } catch {
          // Non-JSON error output (e.g. monotonic escalation refusal) — no subagent started.
        }
      }
      return;
    }

    if (event.type === EventType.TEXT_MESSAGE_START && event.role === "developer") {
      entry.openDeveloperMessages.set(event.messageId, "");
      return;
    }

    if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
      const prev = entry.openDeveloperMessages.get(event.messageId);
      if (prev !== undefined) {
        entry.openDeveloperMessages.set(event.messageId, prev + event.delta);
      }
      return;
    }

    if (event.type === EventType.TEXT_MESSAGE_END) {
      const text = entry.openDeveloperMessages.get(event.messageId);
      if (text !== undefined) {
        entry.openDeveloperMessages.delete(event.messageId);
        for (const match of text.matchAll(/\((sa-\d+)\)\s+(?:done|failed)/g)) {
          const id = match[1];
          if (id) entry.activeSubagentIds.delete(id);
        }
      }
    }
  }

  private prepareBlockingApprovals(
    entry: ConversationEntry,
    interrupts: readonly Interrupt[],
  ): void {
    const snap = entry.translator.snapshot();
    const said = snap?.said.at(-1)?.trim() || snap?.streamingText.trim() || undefined;
    const pendingById = new Map(
      entry.session.pendingInterrupts.map((item) => [item.interruptId, item]),
    );

    for (const interrupt of interrupts) {
      if (entry.blockingByInterruptId.has(interrupt.id)) continue;

      const pending = pendingById.get(interrupt.id);
      const tool = pending?.tool ?? "unknown_tool";
      const toolCallId = pending?.toolCallId ?? interrupt.toolCallId ?? interrupt.id;
      const args = pending?.args ?? {};
      const description = pending?.description ?? interrupt.message ?? tool;
      const group = entry.toolMeta.get(tool)?.group ?? groupFromToolName(tool);

      const title = askTitle(group, description, said);
      const why = whyFor(description);
      const hold = DEFAULT_HOLD;
      const facts = factsFor(tool, args);
      const capability = capabilityFor(tool);
      const argsDigest = computeArgsDigest(args);
      const choices: ApprovalChoice[] = [
        { id: mintOpaqueChoiceId(), label: "Go ahead", stance: "affirm", approves: true },
        { id: mintOpaqueChoiceId(), label: "Not this one", stance: "quiet", approves: false },
      ];

      const record = this.approvalStore.create({
        mode: "blocking",
        tool,
        capability,
        args,
        argsDigest,
        title,
        why,
        hold,
        facts,
        choices,
        scope: {
          conversationId: entry.conversationId,
          interruptId: interrupt.id,
          toolCallId,
        },
        expiresAt: new Date(Date.now() + this.approvalTimeoutMs).toISOString(),
      });

      const pendingApproval: PendingBlockingApproval = {
        decisionId: record.id,
        interruptId: interrupt.id,
        toolCallId,
        tool,
        ref: record.ref,
        title: record.title,
        why: record.why,
        hold: record.hold,
        facts: record.facts,
        actions: record.choices.map(({ id, label, stance }) => ({ id, label, stance })),
      };

      const timer = setTimeout(() => {
        void this.expireBlockingApproval(entry.conversationId, interrupt.id, record.id);
      }, this.approvalTimeoutMs);
      timer.unref?.();
      pendingApproval.timer = timer;

      entry.blockingByInterruptId.set(interrupt.id, pendingApproval);
      entry.decisionIdByToolCallId.set(toolCallId, record.id);
    }
  }

  private async expireBlockingApproval(
    conversationId: string,
    interruptId: string,
    decisionId: string,
  ): Promise<void> {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.closed) return;

    const pending = entry.blockingByInterruptId.get(interruptId);
    if (!pending || pending.decisionId !== decisionId) return;

    try {
      this.approvalStore.settle({
        approvalId: decisionId,
        outcome: "expired",
        chosenId: null,
        settledNote: "No answer — nothing was written.",
        now: new Date(),
      });
    } catch (error) {
      if (error instanceof AlreadySettledError) {
        entry.blockingByInterruptId.delete(interruptId);
        return;
      }
      log.warn("failed to expire blocking approval", {
        conversationId,
        decisionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (pending.timer) clearTimeout(pending.timer);
    entry.blockingByInterruptId.delete(interruptId);

    const settledEvents = entry.translator.onApprovalSettled(decisionId, "expired");
    this.broadcast(
      conversationId,
      settledEvents.length
        ? settledEvents
        : [{ type: "settled", decisionId, outcome: "expired" }],
    );

    try {
      entry.session.resume([approvalAnswer(interruptId, "decline")]);
    } catch {
      // Session already closed or resumed.
    }
  }

  private async handleSubagentDefer(
    entry: ConversationEntry,
    request: SubagentDeferRequest,
  ): Promise<{ allow: false; tell: string }> {
    const group = entry.toolMeta.get(request.tool)?.group ?? groupFromToolName(request.tool);
    const title = askTitle(group, request.description, undefined, request.subagentName);
    const why = whyFor(request.description);
    const facts = factsFor(request.tool, request.args);

    const { record, verdict } = await this.broker.deferAsk({
      request,
      title,
      why,
      hold: DEFERRED_HOLD,
      facts,
      choices: [
        { label: "Go ahead", stance: "affirm", approves: true },
        { label: "Not this one", stance: "quiet", approves: false },
      ],
      scope: {
        conversationId: entry.conversationId,
        subagentId: request.subagentId,
        subagentName: request.subagentName,
        toolCallId: request.toolCallId,
      },
    });

    const deferredEvent: Extract<ChatEvent, { type: "deferred_approval" }> = {
      type: "deferred_approval",
      decisionId: record.id,
      ref: record.ref,
      title: record.title,
      why: record.why,
      hold: record.hold,
      tool: displayName(record.tool),
      subagentName: request.subagentName,
      facts: record.facts,
      actions: record.choices.map(({ id, label, stance }) => ({ id, label, stance })),
    };

    const emitted = entry.translator.onDeferredApproval(deferredEvent);
    this.broadcast(entry.conversationId, emitted.length ? emitted : [deferredEvent]);

    return verdict;
  }

  private handleToolSettled(entry: ConversationEntry, info: ToolSettledInfo): void {
    const decisionId = entry.decisionIdByToolCallId.get(info.toolCallId);
    if (!decisionId) return;
    entry.decisionIdByToolCallId.delete(info.toolCallId);

    // Only record execution outcomes for calls that were approved and ran.
    if (info.outcome.declined || info.wasApproved === false) return;

    const called = displayName(info.tool);
    if (info.responseQuarantined || info.outcome.quarantined) {
      this.approvalStore.recordExecution(
        decisionId,
        { status: "response_quarantined", durationMs: info.durationMs },
        `${called} ran and finished, but its response was quarantined.`,
      );
      return;
    }

    if (info.outcome.ok) {
      this.approvalStore.recordExecution(
        decisionId,
        { status: "ok", durationMs: info.durationMs },
        `${called} ran and finished.`,
      );
      return;
    }

    const errText = info.outcome.error ?? info.outcome.output;
    this.approvalStore.recordExecution(
      decisionId,
      { status: "failed", error: errText, durationMs: info.durationMs },
      `${called} was allowed and failed: ${errText}`,
    );
  }

  private primeTranslatorForResume(
    entry: ConversationEntry,
    thread: readonly Message[],
    pendingInterrupt: PendingInterrupt,
    record: ApprovalRecord,
    outcome: ApprovalOutcome,
  ): void {
    let opening: Extract<Message, { role: "user" | "developer" }> | undefined;
    for (let i = thread.length - 1; i >= 0; i--) {
      const msg = thread[i];
      if (msg && (msg.role === "user" || msg.role === "developer")) {
        opening = msg;
        break;
      }
    }
    const openingId = opening?.id ?? ulid();
    const openingRole = opening?.role === "developer" ? "developer" : "user";
    const openingText = opening ? contentToText(opening.content) : "";

    const tempPending: PendingBlockingApproval = {
      decisionId: record.id,
      interruptId: pendingInterrupt.interruptId,
      toolCallId: pendingInterrupt.toolCallId,
      tool: pendingInterrupt.tool,
      ref: record.ref,
      title: record.title,
      why: record.why,
      hold: record.hold,
      facts: record.facts,
      actions: record.choices.map(({ id, label, stance }) => ({ id, label, stance })),
    };
    entry.blockingByInterruptId.set(pendingInterrupt.interruptId, tempPending);

    const primeRunId = `resume-prime:${pendingInterrupt.interruptId}`;
    entry.translator.push({
      type: EventType.RUN_STARTED,
      threadId: entry.conversationId,
      runId: primeRunId,
    });
    entry.translator.push({
      type: EventType.TEXT_MESSAGE_START,
      messageId: openingId,
      role: openingRole,
    });
    if (openingText) {
      entry.translator.push({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: openingId,
        delta: openingText,
      });
    }
    entry.translator.push({
      type: EventType.TEXT_MESSAGE_END,
      messageId: openingId,
    });
    entry.translator.push({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [...thread],
    });
    entry.translator.push({
      type: EventType.RUN_FINISHED,
      threadId: entry.conversationId,
      runId: primeRunId,
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: pendingInterrupt.interruptId,
            reason: APPROVAL_REASON,
            toolCallId: pendingInterrupt.toolCallId,
          },
        ],
      },
    });

    entry.blockingByInterruptId.delete(pendingInterrupt.interruptId);
    entry.translator.onApprovalSettled(record.id, outcome);
  }

  // -------------------------------------------------------------------------
  // Idle eviction & fan-out helpers
  // -------------------------------------------------------------------------

  private cancelIdleEvict(entry: ConversationEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private scheduleIdleEvictIfReady(entry: ConversationEntry): void {
    if (entry.closed || this.closed || this.idleEvictMs <= 0) return;
    if (
      entry.inFlightCount > 0 ||
      entry.blockingByInterruptId.size > 0 ||
      entry.activeSubagentIds.size > 0
    ) {
      return;
    }
    this.cancelIdleEvict(entry);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (
        entry.closed ||
        entry.inFlightCount > 0 ||
        entry.blockingByInterruptId.size > 0 ||
        entry.activeSubagentIds.size > 0
      ) {
        return;
      }
      this.evictEntry(entry.conversationId);
    }, this.idleEvictMs);
    entry.idleTimer.unref?.();
  }

  private evictEntry(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (!entry) return;
    this.entries.delete(conversationId);
    this.disposeEntry(entry, { preservePendingApprovals: true });
  }

  private disposeEntry(
    entry: ConversationEntry,
    options: { preservePendingApprovals: boolean },
  ): void {
    if (entry.closed) return;
    entry.closed = true;
    this.cancelIdleEvict(entry);

    const hasPendingApproval = entry.blockingByInterruptId.size > 0;
    for (const pending of entry.blockingByInterruptId.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    entry.blockingByInterruptId.clear();

    entry.offAutoTurn?.();
    entry.offAutoTurn = null;

    // When preserving pending approvals across shutdown/restart, do NOT abort the
    // interrupted turn's signal — aborting would wake Session.interrupt and overwrite
    // the durable `kind: 'interrupt'` checkpoint with `status: 'idle'`.
    if (!options.preservePendingApprovals || !hasPendingApproval) {
      for (const controller of [...entry.activeAborts]) {
        controller.abort();
      }
    }
    entry.activeAborts.clear();
    entry.session.close();
  }

  private broadcast(conversationId: string, events: readonly ChatEvent[]): void {
    const listeners = this.subscribers.get(conversationId);
    if (!listeners || listeners.size === 0) return;
    for (const event of events) {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          log.warn("chat subscriber listener threw", {
            conversationId,
            eventType: event.type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton accessors (wired by src/server.ts & routes/chat.ts)
// ---------------------------------------------------------------------------

let defaultCoordinator: SessionCoordinator | undefined;

export function setDefaultCoordinator(coordinator: SessionCoordinator | undefined): void {
  defaultCoordinator = coordinator;
}

export function getDefaultCoordinator(resolveDb: () => Db = getDb): SessionCoordinator {
  defaultCoordinator ??= new SessionCoordinator({ db: resolveDb() });
  return defaultCoordinator;
}
