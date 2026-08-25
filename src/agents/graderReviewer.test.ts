import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../core/rawAgent";
import type { ChatMessage, ChatOptions, ChatProvider } from "../core/providers";
import { createGraderReviewer } from "./graderReviewer";

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

function reviewedAgent(client: ScriptedProvider, graderPrompt?: string | ((vars: {
  output: string;
  messages: ChatMessage[];
}) => string)): Agent {
  return new Agent({
    routes: [{ client, model: "test-model" }],
    promptInjectionScreening: false,
    reviewers: [createGraderReviewer({ client, model: "test-model", graderPrompt })],
  });
}

describe("grader reviewer", () => {
  test("uses a custom prompt and accepts a passing candidate", async () => {
    const client = new ScriptedProvider(["candidate", passingGrade]);
    const agent = reviewedAgent(client, ({ output }) => `CUSTOM GRADER: ${output}`);

    expect(await agent.run("write it")).toBe("candidate");
    expect(client.calls[1]?.[0]).toEqual({
      role: "user",
      content: "CUSTOM GRADER: candidate",
    });
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

    expect(await reviewedAgent(client).run("write it")).toBe("revised draft");
    expect(client.calls[2]?.at(-1)).toEqual({
      role: "system",
      content: "Grader Feedback: Be more specific",
    });
  });

  test("retains base-agent structured-output continuation", async () => {
    const client = new ScriptedProvider(["", '{"ok":true}', passingGrade]);

    expect(await reviewedAgent(client).run("write it", z.object({ ok: z.boolean() }))).toEqual({
      ok: true,
    });
    expect(client.calls[1]?.at(-1)?.content).toContain("submit_result");
  });
});
