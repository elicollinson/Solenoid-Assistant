import type {
  AgentProfile,
  AgentTool,
  ExternalTurnInput,
  Harness,
  ReconciledSession,
} from "@elicollinson/solenoid-engine";
import type { Db } from "../db";
import type { ApprovalOutcome, ChatEvent, LiveTurnSnapshot } from "../shared/chat";

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

/**
 * Per-conversation runtime coordinator owning active `solenoid-engine` `Session`
 * instances, persistent SSE subscriber fan-out, durable Phase 2 restart resume,
 * subagent `defer` settlement, and serialized Gemini Live voice turn appends.
 */
export class SessionCoordinator {
  constructor(_options: SessionCoordinatorOptions) {}

  /** Subscribe to live `ChatEvent`s for `conversationId`; immediately pushes a `snapshot` frame. */
  subscribe(_conversationId: string, _listener: (event: ChatEvent) => void): () => void {
    throw new Error("Not implemented: SessionCoordinator.subscribe");
  }

  /** Current serializable live turn snapshot, or null when idle. */
  getLiveSnapshot(_conversationId: string): LiveTurnSnapshot | null {
    throw new Error("Not implemented: SessionCoordinator.getLiveSnapshot");
  }

  /** Enqueue a user turn into the conversation's serialized session queue. */
  send(
    _conversationId: string,
    _text: string,
    _options?: { now?: Date },
  ): Promise<{ turnId: string }> {
    return Promise.reject(new Error("Not implemented: SessionCoordinator.send"));
  }

  /** Cancel the active in-flight turn for `conversationId`, if any. */
  cancel(_conversationId: string): Promise<boolean> {
    return Promise.reject(new Error("Not implemented: SessionCoordinator.cancel"));
  }

  /**
   * Answer either a blocking chat approval (live OR crash-resumed from SQLite Phase 2
   * `interrupt` checkpoint) or a deferred subagent write approval (with live permission
   * re-check and settlement note appended into the parent session checkpoint).
   */
  answerDecision(
    _actionId: string,
    _options?: { now?: Date },
  ): Promise<AnswerDecisionResult> {
    return Promise.reject(new Error("Not implemented: SessionCoordinator.answerDecision"));
  }

  /** Append a Gemini Live voice turn into the conversation's checkpoint behind the session queue. */
  appendVoiceTurn(_conversationId: string, _input: ExternalTurnInput): Promise<void> {
    return Promise.reject(new Error("Not implemented: SessionCoordinator.appendVoiceTurn"));
  }

  /** Reconcile orphaned `running` sessions after server boot without replaying writes. */
  reconcileOnBoot(): Promise<ReconciledSession[]> {
    return Promise.reject(new Error("Not implemented: SessionCoordinator.reconcileOnBoot"));
  }

  /** Whether an in-memory session is currently loaded for `conversationId`. */
  isActive(_conversationId: string): boolean {
    throw new Error("Not implemented: SessionCoordinator.isActive");
  }

  /** Close all active sessions, timers, and subscribers cleanly. */
  close(): Promise<void> {
    return Promise.reject(new Error("Not implemented: SessionCoordinator.close"));
  }
}
