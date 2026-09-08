import { Agent } from "../core/rawAgent";
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
  for (let offset = 0; offset < retrieved.messages.length; offset += 50) {
    // Finish extraction, grading, and the OKF write before starting the next
    // chunk. Only the existing conversation/grading fanout within a chunk remains.
    const chunk = await extractMessageChunk(retrieved.messages.slice(offset, offset + 50), dependencies);
    result.actionItems.push(...chunk.actionItems);
    result.conversationSummaries.push(...chunk.conversationSummaries);
    result.memoryContext.push(...chunk.memoryContext);
    for (const key of ["processedConversations", "quarantinedConversations", "failedConversations"] as const) {
      result.screening[key] += chunk.screening[key];
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
  messages: TrustedMessageView[],
  dependencies: MessageExtractionDependencies,
): Promise<MessageExtractionResult> {
  const conversations = groupConversations(messages);
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

  const memoryContext = extracted.memoryContext.filter((_, index) => {
    const result = graded.results[index];
    if (result?.status !== "fulfilled") return false;
    const { memoryRelevance, memoryActionability } = result.value;
    return (memoryRelevance + memoryActionability) / 2 > MEMORY_PASS_THRESHOLD;
  });

  const okfUpdate =
    memoryContext.length === 0
      ? "none"
      : await (dependencies.okfManager ?? okfManagerAgent).run(
          `Update the okf with these memories:\n${memoryContext
            .map((memory) => `- ${memory}`)
            .join("\n")}`,
          okfManagerResultSchema,
        );

  return {
    ...extracted,
    memoryContext,
    okfUpdate,
    screening: {
      processedConversations: extraction.completed,
      quarantinedConversations: extraction.quarantined,
      failedConversations: extraction.failed,
    },
  };
}
