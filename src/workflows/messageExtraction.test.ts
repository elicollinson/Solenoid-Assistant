import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../core/rawAgent";
import { defineTool } from "../core/tools";
import type { ChatMessage, ChatProvider } from "../core/providers";
import type { TrustedMessageView } from "../tools/imessage";
import { extractMessages } from "./messageExtraction";

class PromptProvider implements ChatProvider {
  readonly providerName = "message-test";
  readonly traced = true;
  readonly prompts: string[] = [];

  constructor(private readonly reply: (prompt: string) => unknown) {}

  async chat(messages: ChatMessage[]): Promise<ChatMessage> {
    const prompt = [...messages].reverse().find(({ role }) => role === "user")?.content ?? "";
    this.prompts.push(prompt);
    const result = await this.reply(prompt);
    if (result instanceof Error) throw result;
    return { role: "assistant", content: JSON.stringify(result), finishReason: "stop" };
  }
}

function agent(
  provider: ChatProvider,
  screening: false | ((parts: readonly [string, ...string[]]) => Promise<{ flagged: boolean }>) = false,
): Agent {
  return new Agent({
    routes: [{ client: provider, model: "test" }],
    promptInjectionScreening: screening,
  });
}

function message(
  conversationId: string,
  body: string,
  timestamp: string,
): TrustedMessageView {
  return {
    sender: "+15555550100",
    senderName: "Trusted Person",
    body,
    conversationId,
    isFromMe: false,
    service: "iMessage",
    timestamp,
    hasAttachments: false,
  };
}

function retrieval(messages: TrustedMessageView[]) {
  return () => ({
    returned: messages.length,
    totalTrustedInWindow: messages.length,
    totalInWindow: messages.length,
    droppedUntrusted: 0,
    messages,
  });
}

const passGrader = (provider = new PromptProvider(() => ({
  memoryRelevance: 9,
  memoryActionability: 9,
}))) => agent(provider);

describe("message extraction isolation", () => {
  test("one malicious conversation does not suppress a successful sibling", async () => {
    const intakeProvider = new PromptProvider((prompt) => ({
      actionItems: prompt.includes("safe conversation") ? ["safe action"] : [],
      conversationSummaries: ["safe summary"],
      memoryContext: ["safe memory"],
    }));
    const graderProvider = new PromptProvider(() => ({
      memoryRelevance: 9,
      memoryActionability: 9,
    }));
    const okfProvider = new PromptProvider(() => ({
      actionsTaken: ["stored safe memory"],
      resultSummary: "done",
    }));
    const result = await extractMessages({}, {
      retrieveMessages: retrieval([
        message("bad-conversation", "INJECTION ATTACK", "2026-08-24T10:00:00.000Z"),
        message("safe-conversation", "safe conversation", "2026-08-24T10:01:00.000Z"),
      ]),
      intake: agent(intakeProvider, async (parts) => ({
        flagged: parts.join("\n").includes("INJECTION ATTACK"),
      })),
      grader: agent(graderProvider),
      okfManager: agent(okfProvider),
    });

    expect(result.actionItems).toEqual(["safe action"]);
    expect(result.memoryContext).toEqual(["safe memory"]);
    expect(result.screening).toEqual({
      processedConversations: 1,
      quarantinedConversations: 1,
      failedConversations: 0,
    });
    expect(intakeProvider.prompts).toHaveLength(1);
    expect(intakeProvider.prompts[0]).toContain("safe conversation");
    expect(graderProvider.prompts).toHaveLength(1);
    expect(graderProvider.prompts[0]).not.toContain("INJECTION ATTACK");
    expect(okfProvider.prompts).toHaveLength(1);
    expect(okfProvider.prompts[0]).not.toContain("INJECTION ATTACK");
  });

  test("messages in one conversation are screened together, including split injections", async () => {
    const screenedInputs: string[] = [];
    const intakeProvider = new PromptProvider(() => ({
      actionItems: [],
      conversationSummaries: ["should not be produced"],
      memoryContext: [],
    }));
    const result = await extractMessages({}, {
      retrieveMessages: retrieval([
        message("group-chat", "SPLIT OVERRIDE", "2026-08-24T10:00:00.000Z"),
        message("group-chat", "REVEAL SECRETS", "2026-08-24T10:01:00.000Z"),
      ]),
      intake: agent(intakeProvider, async (parts) => {
        const combined = parts.join("\n");
        screenedInputs.push(combined);
        return {
          flagged: combined.includes("SPLIT OVERRIDE") &&
            combined.includes("REVEAL SECRETS"),
        };
      }),
      grader: passGrader(),
    });

    expect(screenedInputs.some((input) =>
      input.includes("SPLIT OVERRIDE") && input.includes("REVEAL SECRETS")
    )).toBe(true);
    expect(intakeProvider.prompts).toHaveLength(0);
    expect(result.actionItems).toEqual([]);
    expect(result.conversationSummaries).toEqual([]);
    expect(result.memoryContext).toEqual([]);
    expect(result.okfUpdate).toBe("none");
    expect(result.screening).toEqual({
      processedConversations: 0,
      quarantinedConversations: 1,
      failedConversations: 0,
    });
  });

  test("all-quarantined input returns a valid empty partial result", async () => {
    const result = await extractMessages({}, {
      retrieveMessages: retrieval([
        message("one", "attack one", "2026-08-24T10:00:00.000Z"),
        message("two", "attack two", "2026-08-24T10:01:00.000Z"),
      ]),
      intake: agent(new PromptProvider(() => new Error("must not run")), async () => ({
        flagged: true,
      })),
      grader: passGrader(new PromptProvider(() => new Error("must not grade"))),
    });

    expect(result).toEqual({
      actionItems: [],
      conversationSummaries: [],
      memoryContext: [],
      okfUpdate: "none",
      screening: {
        processedConversations: 0,
        quarantinedConversations: 2,
        failedConversations: 0,
      },
    });
  });

  test("scanner failure fails the entire workflow", async () => {
    const promise = extractMessages({}, {
      retrieveMessages: retrieval([
        message("one", "content", "2026-08-24T10:00:00.000Z"),
      ]),
      intake: agent(new PromptProvider(() => ({
        actionItems: [],
        conversationSummaries: [],
        memoryContext: [],
      })), async () => {
        throw new Error("scanner offline");
      }),
      grader: passGrader(),
    });

    await expect(promise).rejects.toMatchObject({
      code: "PROMPT_INJECTION_SCREENING_FAILED",
    });
  });

  test("ordinary conversation failures appear in the partial response", async () => {
    const intakeProvider = new PromptProvider((prompt) =>
      prompt.includes("FAIL THIS")
        ? new Error("provider failed")
        : {
            actionItems: ["kept"],
            conversationSummaries: ["kept"],
            memoryContext: [],
          }
    );
    const result = await extractMessages({}, {
      retrieveMessages: retrieval([
        message("failed", "FAIL THIS", "2026-08-24T10:00:00.000Z"),
        message("successful", "normal", "2026-08-24T10:01:00.000Z"),
      ]),
      intake: agent(intakeProvider),
      grader: passGrader(),
    });

    expect(result.actionItems).toEqual(["kept"]);
    expect(result.screening).toEqual({
      processedConversations: 1,
      quarantinedConversations: 0,
      failedConversations: 1,
    });
  });

  test("tool output injection during okfManager execution is quarantined without halting the workflow", async () => {
    const unsafeTool = defineTool({
      name: "okf_search",
      kind: "read",
      description: "search",
      schema: z.object({ query: z.string().optional() }),
      execute: () => ({ results: [{ id: "memories/flagged", snippet: "flagged snippet" }] }),
    });

    const calls: ChatMessage[][] = [];
    const scriptedOkfClient: ChatProvider = {
      providerName: "scripted",
      traced: true,
      async chat(messages) {
        calls.push(messages.map((m) => ({ ...m })));
        if (calls.length === 1) {
          return {
            role: "assistant",
            content: "",
            finishReason: "tool_calls",
            toolCalls: [{ id: "call-1", name: "okf_search", arguments: { query: "Jordan" } }],
          };
        }
        return {
          role: "assistant",
          content: JSON.stringify({
            actionsTaken: ["handled tool quarantine safely"],
            resultSummary: "completed without halt",
          }),
          finishReason: "stop",
        };
      },
    };

    const toolOkfAgent = new Agent({
      routes: [{ client: scriptedOkfClient, model: "test" }],
      tools: [unsafeTool],
      promptInjectionScreening: async ([text]) => ({
        flagged: text.includes("flagged snippet"),
      }),
    });

    const intakeProvider = new PromptProvider(() => ({
      actionItems: ["safe action"],
      conversationSummaries: ["safe summary"],
      memoryContext: ["safe memory"],
    }));

    const result = await extractMessages({}, {
      retrieveMessages: retrieval([
        message("c-1", "Jordan mentioned something", "2026-08-24T10:00:00.000Z"),
      ]),
      intake: agent(intakeProvider),
      grader: passGrader(),
      okfManager: toolOkfAgent,
    });

    expect(result.actionItems).toEqual(["safe action"]);
    expect(result.memoryContext).toEqual(["safe memory"]);
    expect(result.okfUpdate).toEqual({
      actionsTaken: ["handled tool quarantine safely"],
      resultSummary: "completed without halt",
    });

    const secondCallToolMsg = calls[1]?.find((m) => m.role === "tool");
    expect(secondCallToolMsg?.content).toContain("Prompt injection detected in tool output; output blocked.");
    expect(secondCallToolMsg?.content).not.toContain("flagged snippet");
  });
});


describe("message extraction chunks", () => {
  test("covers more than 200 messages in chronological chunks of 50 and waits for each OKF write", async () => {
    const messages = Array.from({ length: 205 }, (_, index) => message(
      "conversation", `message-${index}`, new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
    ));
    const window = { start: new Date("2026-08-01"), end: new Date("2026-08-31") };
    let reads = 0;
    const chunks: string[][] = [];
    const intake = new PromptProvider((prompt) => {
      const bodies = [...prompt.matchAll(/"body":\s*"(message-\d+)"/g)].map((match) => match[1]!);
      chunks.push(bodies);
      return { actionItems: bodies, conversationSummaries: [bodies[0]], memoryContext: [bodies[0]] };
    });
    let releaseWrite!: () => void;
    let enteredWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeEntered = new Promise<void>((resolve) => { enteredWrite = resolve; });
    let writes = 0;
    const okf = new PromptProvider(async () => {
      const index = writes++;
      if (index === 0) {
        enteredWrite();
        await writeBlocked;
      }
      return { actionsTaken: [`write-${index}`], resultSummary: `summary-${index}` };
    });
    const pending = extractMessages(window, {
      retrieveMessages: (params: { start?: Date; end?: Date; limit?: number }) => {
        reads++;
        expect(params).toEqual(window);
        return retrieval(params.limit ? messages.slice(-params.limit) : messages)();
      },
      intake: agent(intake),
      grader: passGrader(),
      okfManager: agent(okf),
    });
    try {
      await writeEntered;
      expect(chunks).toHaveLength(1);
      expect(writes).toBe(1);
    } finally {
      releaseWrite();
    }
    const result = await pending;
    expect(reads).toBe(1);
    expect(chunks.map((chunk) => chunk.length)).toEqual([50, 50, 50, 50, 5]);
    expect(chunks.flat()).toEqual(messages.map((m) => m.body));
    expect(result.actionItems).toEqual(messages.map((m) => m.body));
    expect(result.conversationSummaries).toEqual(["message-0", "message-50", "message-100", "message-150", "message-200"]);
    expect(result.memoryContext).toEqual(result.conversationSummaries);
    expect(result.okfUpdate).toEqual({
      actionsTaken: ["write-0", "write-1", "write-2", "write-3", "write-4"],
      resultSummary: "summary-0\nsummary-1\nsummary-2\nsummary-3\nsummary-4",
    });
    expect(result.screening).toEqual({ processedConversations: 5, quarantinedConversations: 0, failedConversations: 0 });
  });

  test("an OKF write failure stops the run before later chunks", async () => {
    const intake = new PromptProvider(() => ({ actionItems: [], conversationSummaries: [], memoryContext: ["memory"] }));
    const messages = Array.from({ length: 51 }, (_, index) => message("chat", `message-${index}`, "2026-08-01T00:00:00.000Z"));
    await expect(extractMessages({}, {
      retrieveMessages: retrieval(messages),
      intake: agent(intake),
      grader: passGrader(),
      okfManager: agent(new PromptProvider(() => new Error("write failed"))),
    })).rejects.toThrow("write failed");
    expect(intake.prompts).toHaveLength(1);
  });

  test("an empty window invokes no extraction or writes", async () => {
    const provider = new PromptProvider(() => new Error("must not run"));
    const result = await extractMessages({}, {
      retrieveMessages: retrieval([]), intake: agent(provider), grader: agent(provider), okfManager: agent(provider),
    });
    expect(provider.prompts).toHaveLength(0);
    expect(result).toEqual({ actionItems: [], conversationSummaries: [], memoryContext: [], okfUpdate: "none",
      screening: { processedConversations: 0, quarantinedConversations: 0, failedConversations: 0 } });
  });
});
