import type { AGUIEvent, Message } from "@ag-ui/core";
import type {
  ApprovalOutcome,
  ChatApproval,
  ChatChoice,
  ChatEvent,
  ChatFact,
  ChatTurnRow,
  LiveTurnSnapshot,
} from "../shared/chat";

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
  /** Custom duration formatter (defaults to `src/chat/turn.ts` `duration` formatting). */
  formatDuration?: (ms: number) => string;
  now?: () => number;
}

export interface HydrateTurnsOptions {
  now?: Date;
  resolveToolKind?: (toolName: string) => "read" | "write";
  approvalsByToolCallId?: ReadonlyMap<string, ChatApproval>;
  deferredApprovals?: readonly ChatApproval[];
}

/**
 * Pure, stateful translator folding AG-UI 1.0 `AGUIEvent`s into solenoid-assistant's
 * wire `ChatEvent` frames, maintaining a serializable `LiveTurnSnapshot` for SSE reconnects
 * and emitting atomic `reset` frames on retry / route-fallback `MESSAGES_SNAPSHOT`.
 */
export class AgUiToChatEventTranslator {
  constructor(_options: TranslatorOptions = {}) {}

  push(_event: AGUIEvent): ChatEvent[] {
    throw new Error("Not implemented: AgUiToChatEventTranslator.push");
  }

  onApprovalSettled(_decisionId: string, _outcome: ApprovalOutcome): ChatEvent[] {
    throw new Error("Not implemented: AgUiToChatEventTranslator.onApprovalSettled");
  }

  onDeferredApproval(
    _event: Extract<ChatEvent, { type: "deferred_approval" }>,
  ): ChatEvent[] {
    throw new Error("Not implemented: AgUiToChatEventTranslator.onDeferredApproval");
  }

  snapshot(): LiveTurnSnapshot | null {
    throw new Error("Not implemented: AgUiToChatEventTranslator.snapshot");
  }

  reset(): void {
    throw new Error("Not implemented: AgUiToChatEventTranslator.reset");
  }
}

/**
 * Hydrate persisted `ChatTurnRow[]` directly from an AG-UI `Message[]` thread stored
 * in a session checkpoint — guaranteed field-for-field equivalent to what the live
 * `AgUiToChatEventTranslator` + client reducer produces.
 */
export function hydrateTurnsFromThread(
  _thread: readonly Message[],
  _options?: HydrateTurnsOptions,
): ChatTurnRow[] {
  throw new Error("Not implemented: hydrateTurnsFromThread");
}
