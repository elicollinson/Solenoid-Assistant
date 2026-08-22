import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ChatMessage, ChatOptions, ChatProvider } from "../core/providers";
import { GeneratorGrader } from "./generatorGrader";

class ScriptedProvider implements ChatProvider {
  readonly providerName = "scripted";
  readonly traced = true;
  readonly calls: ChatMessage[][] = [];

  constructor(private readonly script: string[]) {}

  async chat(messages: ChatMessage[], _opts: ChatOptions): Promise<ChatMessage> {
    this.calls.push(messages.map((message) => ({ ...message })));
    const content = this.script[this.calls.length - 1];
    if (content === undefined) throw new Error("No scripted response");
    return { role: "assistant", content };
  }
}

const passingGrade = JSON.stringify({
  accuracy: 9,
  specificity: 8,
  constraintAdherence: 8,
  feedback: "Good response",
});

describe("GeneratorGrader", () => {
  test("uses a custom grader prompt and returns a passing candidate", async () => {
    const client = new ScriptedProvider(["candidate", passingGrade]);
    const agent = new GeneratorGrader({
      client,
      model: "test-model",
      graderPrompt: ({ output }) => `CUSTOM GRADER: ${output}`,
    });

    expect(await agent.run("write it")).toBe("candidate");
    expect(client.calls[1]?.[0]?.content).toBe("CUSTOM GRADER: candidate");
  });

  test("computes pass/fail in code and revises a failed candidate", async () => {
    const failingGrade = JSON.stringify({
      accuracy: 7,
      specificity: 7,
      constraintAdherence: 7,
      feedback: "Be more specific",
    });
    const client = new ScriptedProvider([
      "first draft",
      failingGrade,
      "revised draft",
      passingGrade,
    ]);
    const agent = new GeneratorGrader({ client, model: "test-model" });

    expect(await agent.run("write it")).toBe("revised draft");
    expect(client.calls[2]?.at(-1)).toEqual({
      role: "system",
      content: "Grader Feedback: Be more specific",
    });
  });

  test("retains structured-output blank retries in its independent loop", async () => {
    const client = new ScriptedProvider(["", '{"ok":true}', passingGrade]);
    const agent = new GeneratorGrader({ client, model: "test-model" });

    expect(await agent.run("write it", z.object({ ok: z.boolean() }))).toEqual({ ok: true });
    expect(client.calls[1]?.at(-1)?.content).toContain("JSON object");
  });
});
