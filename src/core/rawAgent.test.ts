import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  Agent,
  AgentTimeoutError,
  DEFAULT_AGENT_TIMEOUT_MS,
  extractJson,
} from "./rawAgent";
import { defineTool } from "./tools";
import type {
  ChatMessage,
  ChatOptions,
  ChatProvider,
  StructuredOutputStrategy,
} from "./providers";
import type { Reviewer } from "./reviewer";

class ScriptedProvider implements ChatProvider {
  readonly providerName = "scripted";
  readonly traced = true;
  readonly calls: ChatMessage[][] = [];
  readonly optsSeen: ChatOptions[] = [];

  constructor(
    private readonly script: Partial<ChatMessage>[],
    readonly structuredOutputStrategy: StructuredOutputStrategy = "native",
  ) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    this.calls.push(messages.map((message) => ({ ...message })));
    this.optsSeen.push(opts);
    const next = this.script[this.calls.length - 1];
    if (!next) throw new Error(`no scripted response for call ${this.calls.length}`);
    return { role: "assistant", content: "", finishReason: "stop", ...next };
  }
}

const schema = z.object({ ok: z.boolean() });

const submit = (args: unknown, id = "submit-1"): Partial<ChatMessage> => ({
  finishReason: "tool_calls",
  toolCalls: [{ id, name: "submit_result", arguments: args }],
});

describe("extractJson", () => {
  test("returns empty string when there is nothing to parse", () => {
    expect(extractJson("")).toBe("");
    expect(extractJson("   \n\t ")).toBe("");
  });

  test("peels off code fences and surrounding prose", () => {
    expect(extractJson('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
    expect(extractJson('Here you go: {"ok":true} — done')).toBe('{"ok":true}');
  });
});

describe("native structured trajectory", () => {
  test("allows a reasoning-only turn before terminal structured submission", async () => {
    const client = new ScriptedProvider([
      { thinking: "I should inspect this carefully." },
      submit({ ok: true }),
    ]);
    const agent = new Agent({ client, model: "test-model" });

    expect(await agent.run("grade it", schema)).toEqual({ ok: true });
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.at(-1)?.content).toContain("submit_result");
    expect(client.optsSeen.map((options) => options.think)).toEqual([true, true]);
    expect(client.optsSeen[0]?.tools.some((tool) => tool.function.name === "submit_result"))
      .toBe(true);
  });

  test("accepts valid JSON content when a backend does not call the terminal tool", async () => {
    const client = new ScriptedProvider([{ content: '{"ok":true}' }]);
    const agent = new Agent({ client, model: "test-model" });

    expect(await agent.run("grade it", schema)).toEqual({ ok: true });
  });

  test("returns validation feedback and accepts a corrected submission", async () => {
    const client = new ScriptedProvider([
      { content: '{"ok":"yes"}' },
      submit({ ok: false }),
    ]);
    const agent = new Agent({ client, model: "test-model" });

    expect(await agent.run("grade it", schema)).toEqual({ ok: false });
    expect(client.calls[1]?.at(-1)?.content).toContain("required schema");
  });

  test("continues a token-limited turn instead of treating it as final", async () => {
    const client = new ScriptedProvider([
      { content: '{"ok":', finishReason: "length" },
      submit({ ok: true }),
    ]);
    const agent = new Agent({ client, model: "test-model" });

    expect(await agent.run("grade it", schema)).toEqual({ ok: true });
    expect(client.calls[1]?.at(-1)?.content).toContain("submit_result");
  });

  test("can explicitly disable reasoning for native structured work", async () => {
    const client = new ScriptedProvider([submit({ ok: true })]);
    const agent = new Agent({
      client,
      model: "test-model",
      thinkOnStructured: false,
    });

    await agent.run("grade it", schema);
    expect(client.optsSeen[0]?.think).toBe(false);
  });
});

describe("two-stage structured trajectory", () => {
  test("reasons without constraints, then serializes without reasoning or tools", async () => {
    const client = new ScriptedProvider(
      [
        { content: "The completed answer is yes." },
        { content: '{"ok":true}' },
      ],
      "two-stage",
    );
    const agent = new Agent({ client, model: "test-model" });

    expect(await agent.run("grade it", schema)).toEqual({ ok: true });
    expect(client.optsSeen.map((options) => options.phase)).toEqual(["work", "serialize"]);
    expect(client.optsSeen.map((options) => options.think)).toEqual([true, false]);
    expect(client.optsSeen[0]?.format).toBeUndefined();
    expect(client.optsSeen[1]?.format?.name).toBe("agent_output");
    expect(client.optsSeen[1]?.tools).toEqual([]);
  });
});

describe("deadline and continuation", () => {
  test("uses a fifteen-minute default deadline", () => {
    expect(DEFAULT_AGENT_TIMEOUT_MS).toBe(900_000);
  });

  test("returns a typed timeout when a provider call never completes", async () => {
    const client: ChatProvider = {
      traced: true,
      providerName: "hanging",
      chat: async () => new Promise<ChatMessage>(() => {}),
    };
    const agent = new Agent({ client, model: "test-model", timeoutMs: 20 });

    const error = await agent.run("wait forever").catch((caught) => caught);
    expect(error).toBeInstanceOf(AgentTimeoutError);
    expect((error as AgentTimeoutError).code).toBe("AGENT_TIMEOUT");
    expect((error as AgentTimeoutError).timeoutMs).toBe(20);
  });

  test("retries transient provider failures within the same deadline", async () => {
    let calls = 0;
    const client: ChatProvider = {
      traced: true,
      providerName: "flaky",
      chat: async () => {
        calls++;
        if (calls === 1) {
          throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
        }
        return {
          role: "assistant",
          content: "",
          ...submit({ ok: true }),
        };
      },
    };
    const agent = new Agent({ client, model: "test-model", timeoutMs: 1_000 });

    expect(await agent.run("grade it", schema)).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  test("keeps an unstructured empty answer valid when there is no reasoning", async () => {
    const client = new ScriptedProvider([{ content: "" }]);
    const agent = new Agent({ client, model: "test-model" });
    expect(await agent.run("say nothing")).toBe("");
  });
});

describe("tools and reviewers", () => {
  test("does not impose a predefined tool-turn count", async () => {
    const tool = defineTool({
      name: "increment",
      description: "Increment",
      schema: z.object({ value: z.number() }),
      execute: ({ value }) => value + 1,
    });
    const toolTurn = (id: string, value: number): Partial<ChatMessage> => ({
      finishReason: "tool_calls",
      toolCalls: [{ id, name: "increment", arguments: { value } }],
    });
    const client = new ScriptedProvider([
      toolTurn("one", 1),
      toolTurn("two", 2),
      toolTurn("three", 3),
      { content: "done" },
    ]);
    const agent = new Agent({ client, model: "test-model", tools: [tool] });

    expect(await agent.run("keep going")).toBe("done");
    expect(client.calls).toHaveLength(4);
  });

  test("revises failed candidates with reviewer feedback", async () => {
    const client = new ScriptedProvider([
      { content: "first draft" },
      { content: "revised draft" },
    ]);
    const reviewer: Reviewer = {
      name: "Quality",
      review: async ({ output }) => ({
        passed: output === "revised draft",
        feedback: output === "revised draft" ? "Looks good" : "Be more specific",
      }),
    };
    const agent = new Agent({ client, model: "test-model", reviewers: [reviewer] });

    expect(await agent.run("write it")).toBe("revised draft");
    expect(client.calls[1]?.at(-1)?.content).toContain("Be more specific");
  });
});

describe("agent construction", () => {
  test("rejects invalid deadlines and duplicate components", () => {
    const client = new ScriptedProvider([]);
    expect(() => new Agent({ client, model: "test", timeoutMs: 0 })).toThrow(
      /positive finite/,
    );

    const tool = defineTool({
      name: "same",
      description: "same",
      schema: z.object({}),
      execute: () => null,
    });
    expect(() => new Agent({ client, model: "test", tools: [tool, tool] })).toThrow(
      /already registered/,
    );

    const reserved = defineTool({
      name: "submit_result",
      description: "reserved",
      schema: z.object({}),
      execute: () => null,
    });
    expect(() => new Agent({ client, model: "test", tools: [reserved] })).toThrow(
      /reserved/,
    );
  });
});
