import { describe, expect, mock, test } from "bun:test";
import type { OpenAICompatibleClient } from "@elicollinson/solenoid-engine";
import { OpenAICompatibleProvider } from "./providers";

async function* chunkStream(chunks: unknown[]): AsyncIterable<any> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("OpenAICompatibleProvider", () => {
  test("disables reasoning and captures LM Studio reasoning content", async () => {
    const create = mock(async (_request: unknown) =>
      chunkStream([
        {
          choices: [
            {
              delta: {
                role: "assistant",
                reasoning_content: "reasoned first",
                content: "done",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 2,
            total_tokens: 5,
          },
        },
      ]),
    );
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAICompatibleClient;

    const result = await new OpenAICompatibleProvider(client, "lmstudio").chat(
      [{ role: "user", content: "test" }],
      { model: "qwen/qwen3.5-9b", tools: [], think: false },
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      stream: true,
      reasoning_effort: "none",
    });
    expect(result.content).toBe("done");
    expect(result.thinking).toBe("reasoned first");
    expect(result.usage).toEqual({
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
    });
  });

  test("converts normalized images and exposes the finish reason", async () => {
    const create = mock(async (_request: unknown) =>
      chunkStream([
        {
          choices: [
            {
              finish_reason: "length",
              delta: { role: "assistant", content: "partial" },
            },
          ],
        },
      ]),
    );
    const client = {
      chat: { completions: { create } },
    } as unknown as OpenAICompatibleClient;

    const result = await new OpenAICompatibleProvider(client, "omlx").chat(
      [
        {
          role: "user",
          content: "inspect",
          images: [{ mimeType: "image/png", data: "YWJj" }],
        },
      ],
      { model: "google/gemma-4-26b-a4b", tools: [], think: true },
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
    ["null", null],
    ["omitted", undefined],
  ])(
    "accepts %s content when the assistant returns a tool call",
    async (_label, content) => {
      const client = {
        chat: {
          completions: {
            create: mock(async () =>
              chunkStream([
                {
                  choices: [
                    {
                      finish_reason: "tool_calls",
                      delta: {
                        role: "assistant",
                        ...(content !== undefined ? { content } : {}),
                        tool_calls: [
                          {
                            index: 0,
                            id: "call_1",
                            type: "function",
                            function: { name: "lookup", arguments: '{"id":1}' },
                          },
                        ],
                      },
                    },
                  ],
                },
              ]),
            ),
          },
        },
      } as unknown as OpenAICompatibleClient;

      const result = await new OpenAICompatibleProvider(client, "omlx").chat(
        [{ role: "user", content: "test" }],
        { model: "compatible-model", tools: [] },
      );

      expect(result.content).toBe("");
      expect(result.toolCalls).toEqual([
        { id: "call_1", name: "lookup", arguments: { id: 1 } },
      ]);
    },
  );

  test("preserves an abort reason instead of resolving on an aborted stream", async () => {
    const controller = new AbortController();
    const reason = new Error("workflow stopped");
    const client = {
      chat: {
        completions: {
          create: mock(async () => {
            controller.abort(reason);
            return chunkStream([]);
          }),
        },
      },
    } as unknown as OpenAICompatibleClient;

    const operation = new OpenAICompatibleProvider(client, "openrouter").chat(
      [{ role: "user", content: "test" }],
      { model: "compatible-model", tools: [], signal: controller.signal },
    );

    await expect(operation).rejects.toBe(reason);
  });
});
