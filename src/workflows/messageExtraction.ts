import { Agent, AgentCancelledError, isPromptInjectionDetectedError } from "../core/rawAgent";
import { createModelRoutes } from "../core/providerFactory";
import { loadRuntimeConfig } from "../core/config";
import { log } from "../core/logger";
import { createImessageConversationAgent } from "../agents/imessageIntake";
import { okfManagerAgent } from "../agents/okfManager";
import {
  conversationExtractionPrompt,
  imessageIntakeSchema,
  memoryGraderPrompt,
  memoryGraderSchema,
  memoryGraderSystemPrompt,
  okfManagerResultSchema,
  type ImessageIntakeResult,
  type OkfManagerResult,
} from "../prompts";
import { runIsolated } from "../utils/fanout";
import {
  readAllTrustedMessageWindow,
  type TrustedMessageView,
  type TrustedMessageWindowResult,
} from "../tools/imessage";

const MEMORY_PASS_THRESHOLD = 7;
const runtimeConfig = loadRuntimeConfig();

const memoryGraderAgent = new Agent({
  name: "memory-grader",
  routes: createModelRoutes(runtimeConfig),
  systemPrompt: memoryGraderSystemPrompt,
});

export interface MessageExtractionParams {
  start?: Date;
  end?: Date;
}

export interface MessageExtractionResult extends Omit<ImessageIntakeResult, "memoryContext"> {
  memoryContext: string[];
  okfUpdate: OkfManagerResult | "none";
  screening: {
    processedConversations: number;
    quarantinedConversations: number;
    failedConversations: number;
    quarantinedMemoryUpdates?: number;
  };
}

export interface MessageExtractionDependencies {
  signal?: AbortSignal;
  intake?: Agent;
  grader?: Agent;
  okfManager?: Agent;
  retrieveMessages?: (
    params: MessageExtractionParams,
  ) => TrustedMessageWindowResult;
}

const NEVER_ABORTED = new AbortController().signal;

function ensureActive(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw new AgentCancelledError(
    `Message extraction was cancelled: ${reason instanceof Error ? reason.message : String(reason ?? "cancelled")}`,
    { cause: reason },
  );
}

interface Conversation {
  id: string;
  messages: TrustedMessageView[];
  priorChunkSummary?: string;
}

type ConversationOutcome = "processed" | "quarantined" | "failed";
interface MessageExtractionChunkResult extends MessageExtractionResult {
  conversationOutcomes: { id: string; outcome: ConversationOutcome }[];
}

const MAX_MESSAGES_PER_CHUNK = 50;
const MAX_PRIOR_SUMMARY_CHARS = 2_000;

function groupConversations(messages: TrustedMessageView[]): Conversation[] {
  const grouped = new Map<string, TrustedMessageView[]>();
  for (const message of messages) {
    const existing = grouped.get(message.conversationId);
    if (existing) existing.push(message);
    else grouped.set(message.conversationId, [message]);
  }
  return [...grouped].map(([id, conversationMessages]) => ({
    id,
    messages: conversationMessages,
  }));
}

// A chunk is the unit awaited by extractMessages. Split conversations first so
// even one long thread can never turn the 50-message target into a soft limit.
function* conversationBatches(conversations: Conversation[]): Generator<Conversation[]> {
  let batch: Conversation[] = [];
  let messageCount = 0;
  for (const conversation of conversations) {
    for (let offset = 0; offset < conversation.messages.length; offset += MAX_MESSAGES_PER_CHUNK) {
      const messages = conversation.messages.slice(offset, offset + MAX_MESSAGES_PER_CHUNK);
      if (batch.length > 0 && messageCount + messages.length > MAX_MESSAGES_PER_CHUNK) {
        yield batch;
        batch = [];
        messageCount = 0;
      }
      batch.push({ id: conversation.id, messages });
      messageCount += messages.length;
      if (messageCount === MAX_MESSAGES_PER_CHUNK) {
        yield batch;
        batch = [];
        messageCount = 0;
      }
    }
  }
  if (batch.length > 0) yield batch;
}

function boundedPriorSummary(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  if (summary.length <= MAX_PRIOR_SUMMARY_CHARS) return summary;
  const marker = "\n[…summary bounded…]\n";
  const half = Math.floor((MAX_PRIOR_SUMMARY_CHARS - marker.length) / 2);
  return `${summary.slice(0, half)}${marker}${summary.slice(-(MAX_PRIOR_SUMMARY_CHARS - marker.length - half))}`;
}

export async function extractMessages(
  params: MessageExtractionParams = {},
  dependencies: MessageExtractionDependencies = {},
): Promise<MessageExtractionResult> {
  const signal = dependencies.signal ?? NEVER_ABORTED;
  ensureActive(signal);
  // Take one chronological snapshot so a long run cannot shift its own window.
  const retrieved = (dependencies.retrieveMessages ?? readAllTrustedMessageWindow)(params);
  ensureActive(signal);
  const result: MessageExtractionResult = {
    actionItems: [],
    conversationSummaries: [],
    memoryContext: [],
    okfUpdate: "none",
    screening: {
      processedConversations: 0,
      quarantinedConversations: 0,
      failedConversations: 0,
    },
  };
  const priorSummaries = new Map<string, string>();
  const conversationOutcomes = new Map<string, ConversationOutcome>();
  for (const conversations of conversationBatches(groupConversations(retrieved.messages))) {
    ensureActive(signal);
    // Finish extraction, grading, and the OKF write before starting the next
    // chunk. Only the existing conversation/grading fanout within a chunk remains.
    const chunk = await extractMessageChunk(
      conversations.map((conversation) => ({
        ...conversation,
        priorChunkSummary: boundedPriorSummary(priorSummaries.get(conversation.id)),
      })),
      dependencies,
      priorSummaries,
    );
    ensureActive(signal);
    result.actionItems.push(...chunk.actionItems);
    result.conversationSummaries.push(...chunk.conversationSummaries);
    result.memoryContext.push(...chunk.memoryContext);
    for (const { id, outcome } of chunk.conversationOutcomes) {
      const previous = conversationOutcomes.get(id);
      if (!previous || outcome === "quarantined" || (outcome === "failed" && previous === "processed")) {
        conversationOutcomes.set(id, outcome);
      }
    }
    if (chunk.screening.quarantinedMemoryUpdates) {
      result.screening.quarantinedMemoryUpdates = (result.screening.quarantinedMemoryUpdates ?? 0) + chunk.screening.quarantinedMemoryUpdates;
    }
    if (chunk.okfUpdate !== "none") {
      if (result.okfUpdate === "none") result.okfUpdate = chunk.okfUpdate;
      else {
        result.okfUpdate.actionsTaken.push(...chunk.okfUpdate.actionsTaken);
        result.okfUpdate.resultSummary += "\n" + chunk.okfUpdate.resultSummary;
      }
    }
  }
  for (const outcome of conversationOutcomes.values()) {
    if (outcome === "processed") result.screening.processedConversations++;
    else if (outcome === "quarantined") result.screening.quarantinedConversations++;
    else result.screening.failedConversations++;
  }
  return result;
}

async function extractMessageChunk(
  conversations: Conversation[],
  dependencies: MessageExtractionDependencies,
  priorSummaries: Map<string, string>,
): Promise<MessageExtractionChunkResult> {
  const signal = dependencies.signal ?? NEVER_ABORTED;
  ensureActive(signal);
  const intakeAgent = dependencies.intake ?? createImessageConversationAgent(runtimeConfig);
  const extraction = await runIsolated({
    items: conversations,
    key: (conversation) => conversation.id,
    concurrency: 8,
    name: "imessage-conversation-extraction",
    execute: (conversation) => intakeAgent.runWithSignal(
      signal,
      conversationExtractionPrompt(conversation),
      imessageIntakeSchema,
    ),
  });
  ensureActive(signal);

  if (extraction.failed > 0) {
    log.warn("messageExtraction: conversation extraction failures", {
      failed: extraction.failed,
      total: conversations.length,
    });
  }
  if (extraction.quarantined > 0) {
    log.warn("messageExtraction: conversations quarantined", {
      quarantined: extraction.quarantined,
      total: conversations.length,
    });
  }

  const successful = extraction.results.flatMap((result) =>
    result.status === "fulfilled"
      ? [{ conversation: conversations[result.index]!, value: result.value }]
      : []
  );
  for (const { conversation, value } of successful) {
    if (value.conversationSummaries.length === 0) continue;
    priorSummaries.set(
      conversation.id,
      boundedPriorSummary(value.conversationSummaries.join("\n"))!,
    );
  }
  const extracted: ImessageIntakeResult = {
    actionItems: successful.flatMap(({ value }) => value.actionItems),
    conversationSummaries: successful.flatMap(
      ({ value }) => value.conversationSummaries,
    ),
    memoryContext: successful.flatMap(({ value }) => value.memoryContext),
  };

  const graded = await runIsolated({
    items: extracted.memoryContext,
    key: (_output, index) => index,
    concurrency: 8,
    name: "message-memory-grading",
    execute: (output) => (dependencies.grader ?? memoryGraderAgent).runWithSignal(
      signal,
      memoryGraderPrompt,
      { output },
      memoryGraderSchema,
    ),
  });
  ensureActive(signal);
  if (graded.failed > 0 || graded.quarantined > 0) {
    log.warn("messageExtraction: memory grades withheld", {
      failed: graded.failed,
      quarantined: graded.quarantined,
      total: graded.results.length,
    });
  }

  const memoryContext: string[] = [];

  // Keep source provenance through the write stage. Never combine conversations
  // in a writer invocation, or a detection cannot be contained to its source.
  let okfUpdate: OkfManagerResult | "none" = "none";
  let quarantinedMemoryUpdates = 0;
  let memoryOffset = 0;
  for (const { value: conversation } of successful) {
    ensureActive(signal);
    const memories = conversation.memoryContext.filter((_, index) => {
      const grade = graded.results[memoryOffset + index];
      if (grade?.status !== "fulfilled") return false;
      return (grade.value.memoryRelevance + grade.value.memoryActionability) / 2 > MEMORY_PASS_THRESHOLD;
    });
    memoryOffset += conversation.memoryContext.length;
    if (memories.length === 0) continue;
    try {
      // Await every writer: separate conversations may update the same OKF entry.
      const update = await (dependencies.okfManager ?? okfManagerAgent).runWithSignal(
        signal,
        `Update the okf with these memories:\n${memories.map((memory) => `- ${memory}`).join("\n")}`,
        okfManagerResultSchema,
      );
      ensureActive(signal);
      memoryContext.push(...memories);
      if (okfUpdate === "none") okfUpdate = update;
      else {
        okfUpdate.actionsTaken.push(...update.actionsTaken);
        okfUpdate.resultSummary += "\n" + update.resultSummary;
      }
    } catch (error) {
      // A detection ends only this invocation. Scanner outages and ordinary
      // write failures still halt; retrying writes here could duplicate effects.
      if (!isPromptInjectionDetectedError(error)) throw error;
      quarantinedMemoryUpdates++;
      log.warn("messageExtraction: conversation memory update quarantined", { boundary: error.boundary });
    }
  }

  return {
    ...extracted,
    memoryContext,
    okfUpdate,
    screening: {
      processedConversations: extraction.completed,
      quarantinedConversations: extraction.quarantined,
      failedConversations: extraction.failed,
      ...(quarantinedMemoryUpdates ? { quarantinedMemoryUpdates } : {}),
    },
    conversationOutcomes: extraction.results.map((result) => ({
      id: conversations[result.index]!.id,
      outcome: result.status === "fulfilled"
        ? "processed"
        : result.status === "quarantined"
        ? "quarantined"
        : "failed",
    })),
  };
}
