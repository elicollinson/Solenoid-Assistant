import { describe, expect, mock, test } from "bun:test";
import type OpenAI from "openai";
import { OpenAIProvider } from "./providers";

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
});
