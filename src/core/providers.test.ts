import { describe, expect, mock, test } from "bun:test";
import type OpenAI from "openai";
import type { Ollama } from "ollama";
import { OllamaProvider, OpenAIProvider } from "./providers";

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
