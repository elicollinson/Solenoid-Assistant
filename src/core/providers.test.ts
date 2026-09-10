import { describe, expect, mock, test } from "bun:test";
import type OpenAI from "openai";
import type { Ollama } from "ollama";
import { OllamaProvider, OpenAIProvider, ProviderResponseError } from "./providers";

describe("OpenAIProvider", () => {
  test("disables reasoning and captures LM Studio reasoning content", async () => {
    const create = mock(async (_request: unknown) => ({
      choices: [
        {
          message: {
            role: "assistant" as const,
            content: "done",
            reasoning_content: "reasoned first",
            tool_calls: [],
          },
        },
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
      },
    }));
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const result = await new OpenAIProvider(client).chat(
      [{ role: "user", content: "test" }],
      { model: "qwen/qwen3.5-9b", tools: [], think: false },
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ reasoning_effort: "none" });
    expect(result.content).toBe("done");
    expect(result.thinking).toBe("reasoned first");
  });

  test("converts normalized images and exposes the finish reason", async () => {
    const create = mock(async (_request: unknown) => ({
      choices: [
        {
          finish_reason: "length" as const,
          message: { role: "assistant" as const, content: "partial" },
        },
      ],
    }));
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAI;

    const result = await new OpenAIProvider(client).chat(
      [
        {
          role: "user",
          content: "inspect",
          images: [{ mimeType: "image/png", data: "YWJj" }],
        },
      ],
      { model: "qwen/qwen3.5-9b", tools: [], think: true },
    );

    const request = create.mock.calls[0]?.[0] as {
      messages: Array<{ content: unknown }>;
    };
    expect(request.messages[0]?.content).toEqual([
      { type: "text", text: "inspect" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,YWJj" },
      },
    ]);
    expect(result.finishReason).toBe("length");
  });

  test.each([
    ["a missing choices collection", {}, "choices"],
    ["an empty choices collection", { choices: [] }, "choices"],
    [
      "a missing assistant message",
      { choices: [{ finish_reason: "stop" }] },
      "choices.0.message",
    ],
    [
      "missing assistant content",
      { choices: [{ message: { role: "assistant" } }] },
      "choices.0.message.content",
    ],
    [
      "non-string assistant content",
      { choices: [{ message: { role: "assistant", content: { text: "wrong shape" } } }] },
      "choices.0.message.content",
    ],
  ])("reports a typed error for %s", async (_label, response, expectedPath) => {
    const client = {
      chat: { completions: { create: mock(async () => response) } },
    } as unknown as OpenAI;

    const operation = new OpenAIProvider(client).chat(
      [{ role: "user", content: "test" }],
      { model: "compatible-model", tools: [] },
    );

    const error = await operation.catch((caught) => caught);
    expect(error).toBeInstanceOf(ProviderResponseError);
    expect(error).toMatchObject({
      name: "ProviderResponseError",
      code: "INVALID_PROVIDER_RESPONSE",
      provider: "openai",
    });
    expect(error.message).toContain(expectedPath);
  });

  test.each([["null", null], ["omitted", undefined]])(
    "accepts %s content when the assistant returns a tool call",
    async (_label, content) => {
      const client = {
        chat: {
          completions: {
            create: mock(async () => ({
              choices: [{
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  ...(content !== undefined ? { content } : {}),
                  tool_calls: [{
                    id: "call_1",
                    type: "function",
                    function: { name: "lookup", arguments: '{"id":1}' },
                  }],
                },
              }],
            })),
          },
        },
      } as unknown as OpenAI;

      const result = await new OpenAIProvider(client).chat(
        [{ role: "user", content: "test" }],
        { model: "compatible-model", tools: [] },
      );

      expect(result.content).toBe("");
      expect(result.toolCalls).toEqual([{ id: "call_1", name: "lookup", arguments: { id: 1 } }]);
    },
  );

  test("preserves an abort reason instead of replacing it with a response error", async () => {
    const controller = new AbortController();
    const reason = new Error("workflow stopped");
    const client = {
      chat: {
        completions: {
          create: mock(async () => {
            controller.abort(reason);
            return { choices: [] };
          }),
        },
      },
    } as unknown as OpenAI;

    const operation = new OpenAIProvider(client).chat(
      [{ role: "user", content: "test" }],
      { model: "compatible-model", tools: [], signal: controller.signal },
    );

    await expect(operation).rejects.toBe(reason);
  });
});

describe("OllamaProvider", () => {
  test("aggregates a cancellable stream into one normalized turn", async () => {
    const abort = mock(() => {});
    const chat = mock(async (_request: unknown) => ({
      abort,
      async *[Symbol.asyncIterator]() {
        yield {
          message: { role: "assistant", thinking: "considering ", content: "part " },
          done_reason: "",
        };
        yield {
          message: { role: "assistant", thinking: "done", content: "two" },
          done_reason: "stop",
          prompt_eval_count: 4,
          eval_count: 3,
        };
      },
    }));
    const client = { chat } as unknown as Ollama;

    const result = await new OllamaProvider(client).chat(
      [{ role: "user", content: "test" }],
      { model: "qwen", tools: [], think: true },
    );

    expect(chat.mock.calls[0]?.[0]).toMatchObject({ stream: true });
    expect(result.content).toBe("part two");
    expect(result.thinking).toBe("considering done");
    expect(result.finishReason).toBe("stop");
    expect(result.usage?.totalTokens).toBe(7);
  });
});
