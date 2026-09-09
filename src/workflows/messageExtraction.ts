import { Agent, isGuardrailDetectedError, isPromptInjectionDetectedError } from "../core/rawAgent";
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
  intake?: Agent;
  grader?: Agent;
  okfManager?: Agent;
  retrieveMessages?: (
    params: MessageExtractionParams,
  ) => TrustedMessageWindowResult;
}

interface Conversation {
  id: string;
  messages: TrustedMessageView[];
}

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

// Preserve conversation context even when a single conversation exceeds the target.
function* conversationBatches(conversations: Conversation[]): Generator<Conversation[]> {
  let batch: Conversation[] = [];
  let messageCount = 0;
  for (const conversation of conversations) {
    if (batch.length > 0 && messageCount + conversation.messages.length > 50) {
      yield batch;
      batch = [];
      messageCount = 0;
    }
    batch.push(conversation);
    messageCount += conversation.messages.length;
  }
  if (batch.length > 0) yield batch;
}

export async function extractMessages(
  params: MessageExtractionParams = {},
  dependencies: MessageExtractionDependencies = {},
): Promise<MessageExtractionResult> {
  // Take one chronological snapshot so a long run cannot shift its own window.
  const retrieved = (dependencies.retrieveMessages ?? readAllTrustedMessageWindow)(params);
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
  for (const conversations of conversationBatches(groupConversations(retrieved.messages))) {
    // Finish extraction, grading, and the OKF write before starting the next
    // chunk. Only the existing conversation/grading fanout within a chunk remains.
    const chunk = await extractMessageChunk(conversations, dependencies);
    result.actionItems.push(...chunk.actionItems);
    result.conversationSummaries.push(...chunk.conversationSummaries);
    result.memoryContext.push(...chunk.memoryContext);
    for (const key of ["processedConversations", "quarantinedConversations", "failedConversations"] as const) {
      result.screening[key] += chunk.screening[key];
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
  return result;
}

async function extractMessageChunk(
  conversations: Conversation[],
  dependencies: MessageExtractionDependencies,
): Promise<MessageExtractionResult> {
  const intakeAgent = dependencies.intake ?? createImessageConversationAgent(runtimeConfig);
  const extraction = await runIsolated({
    items: conversations,
    key: (conversation) => conversation.id,
    concurrency: 8,
    name: "imessage-conversation-extraction",
    execute: (conversation) => intakeAgent.run(
      conversationExtractionPrompt(conversation),
      imessageIntakeSchema,
    ),
  });

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
    result.status === "fulfilled" ? [result.value] : []
  );
  const extracted: ImessageIntakeResult = {
    actionItems: successful.flatMap((result) => result.actionItems),
    conversationSummaries: successful.flatMap(
      (result) => result.conversationSummaries,
    ),
    memoryContext: successful.flatMap((result) => result.memoryContext),
  };

  const graded = await runIsolated({
    items: extracted.memoryContext,
    key: (_output, index) => index,
    concurrency: 8,
    name: "message-memory-grading",
    execute: (output) => (dependencies.grader ?? memoryGraderAgent).run(
      memoryGraderPrompt,
      { output },
      memoryGraderSchema,
    ),
  });
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
  for (const conversation of successful) {
    const memories = conversation.memoryContext.filter((_, index) => {
      const grade = graded.results[memoryOffset + index];
      if (grade?.status !== "fulfilled") return false;
      return (grade.value.memoryRelevance + grade.value.memoryActionability) / 2 > MEMORY_PASS_THRESHOLD;
    });
    memoryOffset += conversation.memoryContext.length;
    if (memories.length === 0) continue;
    try {
      // Await every writer: separate conversations may update the same OKF entry.
      const update = await (dependencies.okfManager ?? okfManagerAgent).run(
        `Update the okf with these memories:\n${memories.map((memory) => `- ${memory}`).join("\n")}`,
        okfManagerResultSchema,
      );
      memoryContext.push(...memories);
      if (okfUpdate === "none") okfUpdate = update;
      else {
        okfUpdate.actionsTaken.push(...update.actionsTaken);
        okfUpdate.resultSummary += "\n" + update.resultSummary;
      }
    } catch (error) {
      // A detection ends only this invocation. Scanner outages and ordinary
      // write failures still halt; retrying writes here could duplicate effects.
      if (!isGuardrailDetectedError(error)) throw error;
      quarantinedMemoryUpdates++;
      log.warn("messageExtraction: conversation memory update quarantined", {
        boundary: error.boundary,
        classification: isPromptInjectionDetectedError(error) ? "prompt_injection" : "content_safety",
      });
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
  };
}
