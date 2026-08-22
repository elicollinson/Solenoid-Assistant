import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent, MAX_BLANK_RETRIES, extractJson } from "./rawAgent";
import { defineTool } from "./tools";
import type { ChatMessage, ChatOptions, ChatProvider } from "./providers";

// Replays a fixed list of assistant turns, one per chat() call, and records the
// message history it was handed each time. `traced: true` skips the tracing
// decorator so these tests exercise the loop alone.
class ScriptedProvider implements ChatProvider {
  readonly providerName = "scripted";
  readonly traced = true;
  readonly calls: ChatMessage[][] = [];
  readonly optsSeen: ChatOptions[] = [];

  constructor(private readonly script: Partial<ChatMessage>[]) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    this.calls.push(messages.map((m) => ({ ...m })));
    this.optsSeen.push(opts);
    const next = this.script[this.calls.length - 1];
    if (!next) throw new Error(`no scripted response for call ${this.calls.length}`);
    return { role: "assistant", content: "", ...next };
  }
}

const schema = z.object({ ok: z.boolean() });

const agentWith = (script: Partial<ChatMessage>[]) => {
  const client = new ScriptedProvider(script);
  return { client, agent: new Agent({ client, model: "test-model" }) };
};

describe("extractJson", () => {
  test("returns empty string when there is nothing to parse", () => {
    expect(extractJson("")).toBe("");
    expect(extractJson("   \n\t ")).toBe("");
  });

  test("passes through bare JSON", () => {
    expect(extractJson('{"ok":true}')).toBe('{"ok":true}');
    expect(extractJson("  [1,2]  ")).toBe("[1,2]");
  });

  test("peels off code fences and surrounding prose", () => {
    expect(extractJson('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
    expect(extractJson('Here you go: {"ok":true} — hope that helps')).toBe('{"ok":true}');
  });
});

describe("blank structured response", () => {
  test("retries and succeeds when the model recovers", async () => {
    const { client, agent } = agentWith([{ content: "" }, { content: '{"ok":true}' }]);

    expect(await agent.run("grade it", schema)).toEqual({ ok: true });
    expect(client.calls).toHaveLength(2);

    // The retry nudge is appended as a user turn before the second call. It is
    // deliberately positive-only — naming failure modes ("no reasoning") was
    // observed to prime models into reproducing them.
    const second = client.calls[1]!;
    expect(second.at(-1)).toMatchObject({ role: "user" });
    expect(second.at(-1)!.content).toContain("JSON object");
    expect(second.at(-1)!.content).not.toMatch(/no reasoning|no prose|no code fences/);
  });

  test("reasoning-only turns are retried too", async () => {
    const { agent } = agentWith([
      { content: "", thinking: "Let me average the scores..." },
      { content: '{"ok":false}' },
    ]);

    expect(await agent.run("grade it", schema)).toEqual({ ok: false });
  });

  test("gives up after MAX_BLANK_RETRIES with a distinct error, not a parse error", async () => {
    const blanks = Array.from({ length: MAX_BLANK_RETRIES + 1 }, () => ({ content: "" }));
    const { client, agent } = agentWith(blanks);

    // The regression this guards: an empty response used to reach JSON.parse
    // and surface as "JSON Parse error: Unexpected EOF" with a blank
    // "Model output:" tail, pointing at the parser instead of the empty turn.
    const err = await agent.run("grade it", schema).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Structured output missing");
    expect((err as Error).message).not.toContain("Unexpected EOF");
    expect((err as Error).message).not.toContain("failed validation");

    expect(client.calls).toHaveLength(MAX_BLANK_RETRIES + 1);
  });

  test("malformed-but-present output still reports as a validation failure", async () => {
    const { agent } = agentWith([{ content: '{"ok":"not-a-boolean"}' }]);

    const err = await agent.run("grade it", schema).catch((e: Error) => e);
    expect((err as Error).message).toContain("failed validation");
    expect((err as Error).message).not.toContain("Structured output missing");
  });

  test("unschemad calls are not retried — an empty answer is a valid string", async () => {
    const { client, agent } = agentWith([{ content: "" }]);

    expect(await agent.run("just chat")).toBe("");
    expect(client.calls).toHaveLength(1);
  });

  test("retry nudges also go out without thinking enabled", async () => {
    const { client, agent } = agentWith([{ content: "" }, { content: '{"ok":true}' }]);

    await agent.run("grade it", schema);
    expect(client.optsSeen.map((o) => o.think)).toEqual([false, false]);
  });

  test("blank turns do not consume the maxIterations budget", async () => {
    // One tool round is allowed; the blank turn that follows must still get its
    // retry rather than being cut off as though it had done work.
    const client = new ScriptedProvider([{ content: "" }, { content: '{"ok":true}' }]);
    const agent = new Agent({ client, model: "test-model", maxIterations: 1 });

    expect(await agent.run("grade it", schema)).toEqual({ ok: true });
  });
});

describe("think on structured calls", () => {
  test("schema-constrained calls suppress thinking by default", async () => {
    // With no reasoning channel open, the JSON has nowhere to go but content —
    // this is what prevents blank structured replies at the source, rather
    // than retrying them after the fact.
    const { client, agent } = agentWith([{ content: '{"ok":true}' }]);

    await agent.run("grade it", schema);
    expect(client.optsSeen[0]!.think).toBe(false);
  });

  test("unschemad calls keep the agent's think level", async () => {
    const { client, agent } = agentWith([{ content: "hi" }]);

    await agent.run("just chat");
    expect(client.optsSeen[0]!.think).toBe(true);
  });

  test("thinkOnStructured opts a structured call back into thinking", async () => {
    const client = new ScriptedProvider([{ content: '{"ok":true}' }]);
    const agent = new Agent({ client, model: "test-model", thinkOnStructured: true });

    await agent.run("grade it", schema);
    expect(client.optsSeen[0]!.think).toBe(true);
  });
});

describe("agent construction", () => {
  test("rejects invalid iteration limits and duplicate tool names", () => {
    const client = new ScriptedProvider([]);
    expect(() => new Agent({ client, model: "test", maxIterations: 0 })).toThrow(
      /positive integer/,
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
  });
});
