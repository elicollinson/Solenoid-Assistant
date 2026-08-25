import { describe, expect, test } from "bun:test";
import { Agent } from "../core/rawAgent";
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
    const result = this.reply(prompt);
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
});
