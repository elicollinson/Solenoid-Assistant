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
  test("cancellation during an in-flight intake starts no fallback, later chunk, grade, or write", async () => {
    const controller = new AbortController();
    let release!: (message: ChatMessage) => void;
    const held = new Promise<ChatMessage>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary: ChatProvider = {
      providerName: "held-primary",
      traced: true,
      chat: async () => {
        primaryCalls++;
        entered();
        return held;
      },
    };
    const fallback: ChatProvider = {
      providerName: "forbidden-fallback",
      traced: true,
      chat: async () => {
        fallbackCalls++;
        return { role: "assistant", content: "must not run" };
      },
    };
    const intake = new Agent({
      routes: [
        { client: primary, model: "primary" },
        { client: fallback, model: "fallback" },
      ],
      promptInjectionScreening: false,
    });
    const grader = new PromptProvider(() => ({ memoryRelevance: 10, memoryActionability: 10 }));
    const writer = new PromptProvider(() => ({ actionsTaken: ["write"], resultSummary: "write" }));
    const messages = Array.from({ length: 51 }, (_, index) =>
      message("one-conversation", `message-${index}`, "2026-08-01T00:00:00.000Z")
    );

    const pending = extractMessages({}, {
      signal: controller.signal,
      retrieveMessages: retrieval(messages),
      intake,
      grader: agent(grader),
      okfManager: agent(writer),
    });
    await started;
    controller.abort(new Error("stopped by user"));
    await expect(pending).rejects.toThrow("stopped by user");
    release({
      role: "assistant",
      content: JSON.stringify({
        actionItems: [],
        conversationSummaries: ["late"],
        memoryContext: ["late"],
      }),
    });
    await Promise.resolve();

    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(0);
    expect(grader.prompts).toHaveLength(0);
    expect(writer.prompts).toHaveLength(0);
  });

  test("covers more than 200 messages in hard-capped batches and waits for each OKF write", async () => {
    const messages = Array.from({ length: 205 }, (_, index) => message(
      `conversation-${Math.floor(index / 50)}`, `message-${index}`, new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
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

  test("splits oversized interleaved conversations with complete ordered coverage", async () => {
    const sizes = [20, 30, 205, 25, 26];
    // Interleave messages so each conversation crosses raw 50-message boundaries.
    const messages = Array.from({ length: 205 }, (_, index) => sizes.flatMap((size, conversation) =>
      index < size ? [message(`chat-${conversation}`, `message-${conversation}-${index}`,
        new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString())] : []
    )).flat();
    const seen: string[][] = [];
    const writes: string[][] = [];
    let batch: string[] = [];
    const intake = new PromptProvider((prompt) => {
      const bodies = [...prompt.matchAll(/"body":\s*"(message-\d+-\d+)"/g)].map((match) => match[1]!);
      seen.push(bodies);
      batch.push(bodies[0]!);
      return { actionItems: bodies, conversationSummaries: [bodies[0]], memoryContext: [bodies[0]] };
    });
    const result = await extractMessages({}, {
      retrieveMessages: retrieval(messages), intake: agent(intake), grader: passGrader(),
      okfManager: agent(new PromptProvider(() => {
        writes.push(batch);
        batch = [];
        return { actionsTaken: ["updated"], resultSummary: "updated" };
      })),
    });
    expect(seen.every((part) => part.length <= 50)).toBe(true);
    expect(seen.flat()).toEqual([
      ...Array.from({ length: 20 }, (_, index) => `message-0-${index}`),
      ...Array.from({ length: 30 }, (_, index) => `message-1-${index}`),
      ...Array.from({ length: 205 }, (_, index) => `message-2-${index}`),
      ...Array.from({ length: 25 }, (_, index) => `message-3-${index}`),
      ...Array.from({ length: 26 }, (_, index) => `message-4-${index}`),
    ]);
    expect(writes).toHaveLength(9);
    expect(result.actionItems).toEqual(seen.flat());
    expect(result.conversationSummaries).toEqual(seen.map((part) => part[0]!));
    expect(result.screening).toEqual({ processedConversations: 5, quarantinedConversations: 0, failedConversations: 0 });
  });

  test("keeps 50 messages in one extraction and splits 51 into 50 plus 1", async () => {
    for (const count of [50, 51]) {
      const intake = new PromptProvider((prompt) => ({
        actionItems: [...prompt.matchAll(/"body":\s*"(boundary-\d+)"/g)].map((match) => match[1]!),
        conversationSummaries: ["chunk summary"],
        memoryContext: [],
      }));
      const messages = Array.from({ length: count }, (_, index) =>
        message("boundary-chat", `boundary-${index}`, "2026-08-01T00:00:00.000Z")
      );
      const result = await extractMessages({}, {
        retrieveMessages: retrieval(messages), intake: agent(intake), grader: passGrader(),
      });
      expect(intake.prompts).toHaveLength(count === 50 ? 1 : 2);
      expect(intake.prompts.map((prompt) =>
        [...prompt.matchAll(/"body":\s*"boundary-\d+"/g)].length
      )).toEqual(count === 50 ? [50] : [50, 1]);
      expect(result.actionItems).toEqual(messages.map(({ body }) => body));
    }
  });

  test("carries a bounded summary only from prior chunks of the same conversation", async () => {
    const longSummary = `FIRST-${"x".repeat(2_100)}-TAIL`;
    const intake = new PromptProvider((prompt) => {
      const body = prompt.match(/"body":\s*"([^"]+)"/)?.[1] ?? "";
      return {
        actionItems: [],
        conversationSummaries: [
          body === "a-0"
            ? longSummary
            : body === "a-50"
            ? "cumulative-first-and-second"
            : `summary-${body}`,
        ],
        memoryContext: [],
      };
    });
    const messages = [
      ...Array.from({ length: 101 }, (_, index) => message("chat-a", `a-${index}`, "2026-08-01T00:00:00.000Z")),
      ...Array.from({ length: 49 }, (_, index) => message("chat-b", `b-${index}`, "2026-08-01T00:00:00.000Z")),
    ];
    await extractMessages({}, {
      retrieveMessages: retrieval(messages), intake: agent(intake), grader: passGrader(),
    });

    const firstA = intake.prompts.find((prompt) => prompt.includes('"body":"a-0"'))!;
    const secondA = intake.prompts.find((prompt) => prompt.includes('"body":"a-50"'))!;
    const thirdA = intake.prompts.find((prompt) => prompt.includes('"body":"a-100"'))!;
    const firstB = intake.prompts.find((prompt) => prompt.includes('"body":"b-0"'))!;
    expect(firstA).not.toContain("Earlier Context From This Conversation");
    expect(secondA).toContain("Earlier Context From This Conversation");
    expect(secondA).toContain("FIRST-");
    expect(secondA).toContain("-TAIL");
    expect(secondA).toContain("[…summary bounded…]");
    expect(thirdA).toContain("cumulative-first-and-second");
    expect(thirdA).not.toContain(longSummary);
    expect(firstB).not.toContain("Earlier Context From This Conversation");
    expect(firstB).not.toContain("-TAIL");
  });

  test("does not carry output from a quarantined chunk into later context", async () => {
    const prompts: string[] = [];
    const intake = new PromptProvider((prompt) => {
      prompts.push(prompt);
      const body = prompt.match(/"body":\s*"([^"]+)"/)?.[1] ?? "";
      return { actionItems: [], conversationSummaries: [`safe-summary-${body}`], memoryContext: [] };
    });
    const messages = Array.from({ length: 101 }, (_, index) =>
      message("quarantine-chat", index === 50 ? "QUARANTINE-ME" : `q-${index}`, "2026-08-01T00:00:00.000Z")
    );
    await extractMessages({}, {
      retrieveMessages: retrieval(messages),
      intake: agent(intake, async (parts) => ({ flagged: parts.some((part) => part.includes("QUARANTINE-ME")) })),
      grader: passGrader(),
    });
    const third = prompts.find((prompt) => prompt.includes('"body":"q-100"'))!;
    expect(third).toContain("safe-summary-q-0");
    expect(third).not.toContain("QUARANTINE-ME");
    expect(third).not.toContain("safe-summary-QUARANTINE-ME");
  });

  test("an OKF write failure stops the run before later chunks", async () => {
    const intake = new PromptProvider(() => ({ actionItems: [], conversationSummaries: [], memoryContext: ["memory"] }));
    const messages = Array.from({ length: 51 }, (_, index) => message(`chat-${Math.floor(index / 50)}`, `message-${index}`, "2026-08-01T00:00:00.000Z"));
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


describe("message memory write isolation", () => {
  test("a non-PI content block stops only its memory update", async () => {
    const writes = new PromptProvider((prompt) => ({
      actionsTaken: [prompt.includes("blocked-memory") ? "blocked-result" : "safe-write"],
      resultSummary: "done",
    }));
    const result = await extractMessages({}, {
      retrieveMessages: retrieval([
        message("blocked", "blocked-source", "2026-08-01T00:00:00.000Z"),
        message("safe", "safe-source", "2026-08-01T00:01:00.000Z"),
      ]),
      intake: agent(new PromptProvider((prompt) => ({
        actionItems: [], conversationSummaries: [],
        memoryContext: [prompt.includes("blocked-source") ? "blocked-memory" : "safe-memory"],
      }))),
      grader: passGrader(),
      okfManager: agent(writes, async (parts) => ({
        flagged: false,
        blocked: parts.some((part) => part.includes("blocked-result")),
        matchedFilters: ["rai"],
      })),
    });

    expect(result.okfUpdate).toEqual({ actionsTaken: ["safe-write"], resultSummary: "done" });
    expect(result.memoryContext).toEqual(["safe-memory"]);
    expect(result.screening.quarantinedMemoryUpdates).toBe(1);
    expect(writes.prompts).toHaveLength(2);
  });

  test("a model-output detection stops only its conversation and later writes and batches remain sequential", async () => {
    const messages = [25, 25, 50].flatMap((size, conversation) =>
      Array.from({ length: size }, (_, index) => message(`chat-${conversation}`, `source-${conversation}-${index}`, "2026-08-01T00:00:00.000Z"))
    );
    const intake = new PromptProvider((prompt) => {
      const source = prompt.match(/source-(\d+)-/)![1];
      return { actionItems: [], conversationSummaries: [`summary-${source}`], memoryContext: [`memory-${source}`] };
    });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const writes = new PromptProvider(async (prompt) => {
      if (prompt.includes("memory-0")) return { actionsTaken: ["blocked-output"], resultSummary: "blocked-output" };
      if (prompt.includes("memory-1")) { entered(); await blocked; }
      return { actionsTaken: [prompt.includes("memory-1") ? "write-1" : "write-2"], resultSummary: "safe" };
    });
    const pending = extractMessages({}, {
      retrieveMessages: retrieval(messages), intake: agent(intake), grader: passGrader(),
      okfManager: agent(writes, async (parts) => ({ flagged: parts.some((part) => part.includes("blocked-output")) })),
    });
    try {
      await started;
      expect(intake.prompts).toHaveLength(2);
      expect(writes.prompts).toHaveLength(2);
    } finally { release(); }
    const result = await pending;
    expect(writes.prompts).toHaveLength(3);
    for (const [index, prompt] of writes.prompts.entries()) {
      expect(prompt).toContain(`memory-${index}`);
      for (let other = 0; other < 3; other++) if (other !== index) expect(prompt).not.toContain(`memory-${other}`);
    }
    expect(result.okfUpdate).toEqual({ actionsTaken: ["write-1", "write-2"], resultSummary: "safe\nsafe" });
    expect(result.screening.quarantinedMemoryUpdates).toBe(1);
    expect(result.memoryContext).toEqual(["memory-1", "memory-2"]);
    expect(result.conversationSummaries).toEqual(["summary-0", "summary-1", "summary-2"]);
  });

  test("a late model-output detection does not retry an already completed tool write", async () => {
    let toolWrites = 0;
    const writeTool = defineTool({
      name: "record_memory", kind: "write", description: "record memory",
      schema: z.object({}), execute: () => { toolWrites++; return { ok: true }; },
    });
    const provider: ChatProvider = {
      providerName: "late-detection", traced: true,
      async chat(messages) {
        const input = messages.find((m) => m.role === "user")?.content ?? "";
        if (input.includes("late-memory")) {
          if (!messages.some((m) => m.role === "tool")) return {
            role: "assistant", content: "", finishReason: "tool_calls",
            toolCalls: [{ id: "write-once", name: "record_memory", arguments: {} }],
          };
          return { role: "assistant", content: JSON.stringify({ actionsTaken: ["blocked-output"], resultSummary: "blocked-output" }), finishReason: "stop" };
        }
        return { role: "assistant", content: JSON.stringify({ actionsTaken: ["safe update"], resultSummary: "safe" }), finishReason: "stop" };
      },
    };
    const result = await extractMessages({}, {
      retrieveMessages: retrieval([message("late", "late-source", "2026-08-01T00:00:00.000Z"), message("safe", "safe-source", "2026-08-01T00:01:00.000Z")]),
      intake: agent(new PromptProvider((prompt) => ({ actionItems: [], conversationSummaries: [], memoryContext: [prompt.includes("late-source") ? "late-memory" : "safe-memory"] }))),
      grader: passGrader(),
      okfManager: new Agent({ routes: [{ client: provider, model: "test" }], tools: [writeTool],
        promptInjectionScreening: async (parts) => ({ flagged: parts.some((part) => part.includes("blocked-output")) }),
      }),
    });
    expect(toolWrites).toBe(1);
    expect(result.screening.quarantinedMemoryUpdates).toBe(1);
    expect(result.okfUpdate).toEqual({ actionsTaken: ["safe update"], resultSummary: "safe" });
  });

  test("a writer scanner outage still halts instead of being treated as a detection", async () => {
    const intake = new PromptProvider(() => ({ actionItems: [], conversationSummaries: [], memoryContext: ["memory"] }));
    const messages = Array.from({ length: 100 }, (_, index) => message(`chat-${Math.floor(index / 50)}`, "body", "2026-08-01T00:00:00.000Z"));
    await expect(extractMessages({}, {
      retrieveMessages: retrieval(messages), intake: agent(intake), grader: passGrader(),
      okfManager: agent(new PromptProvider(() => ({ actionsTaken: [], resultSummary: "unused" })), async () => { throw new Error("scanner unavailable"); }),
    })).rejects.toThrow("Prompt injection screening failed");
    expect(intake.prompts).toHaveLength(1);
  });
});
