import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent, AgentTimeoutError } from "../core/rawAgent";
import { fanout, fulfilled, rejected } from "./fanout";
import type { ChatMessage, ChatProvider } from "../core/providers";
import type { PromptTemplate } from "../prompts";

// Replies based on the item text in the prompt rather than call order, so
// results stay deterministic even when calls run concurrently.
class KeyedProvider implements ChatProvider {
  readonly providerName = "keyed";
  readonly traced = true;

  constructor(private readonly reply: (userText: string) => Partial<ChatMessage>) {}

  async chat(messages: ChatMessage[]): Promise<ChatMessage> {
    const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return { role: "assistant", content: "", ...this.reply(user) };
  }
}

const schema = z.object({ item: z.string() });
const prompt: PromptTemplate<{ item: string }> = ({ item }) => `grade ${item}`;
const items = [{ item: "a" }, { item: "b" }, { item: "c" }];

const agentThat = (
  reply: (userText: string) => Partial<ChatMessage>,
  timeoutMs?: number,
) => new Agent({
  routes: [{ client: new KeyedProvider(reply), model: "test-model" }],
  timeoutMs,
});

describe("fanout", () => {
  test("one failing item no longer sinks the batch", async () => {
    // The regression this guards: with Promise.all, item "b" rejecting rejected
    // the whole fanout and 502'd the calling endpoint.
    const agent = agentThat((text) => {
      if (text.includes("b")) throw new Error("grader exploded");
      return { content: JSON.stringify({ item: text.replace("grade ", "") }) };
    });

    const results = await fanout(items, agent, prompt, schema, 8);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ status: "fulfilled", value: { item: "a" } });
    expect(results[2]).toEqual({ status: "fulfilled", value: { item: "c" } });
    expect(results[1]!.status).toBe("rejected");
  });

  test("outcomes stay positionally aligned with the input under concurrency", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ item: `i${i}` }));
    // Every third item fails, so a misalignment would show up immediately.
    const agent = agentThat((text) => {
      const n = Number(text.replace("grade i", ""));
      if (n % 3 === 0) throw new Error(`fail ${n}`);
      return { content: JSON.stringify({ item: `i${n}` }) };
    });

    const results = await fanout(many, agent, prompt, schema, 4);

    expect(results).toHaveLength(12);
    results.forEach((r, n) => {
      if (n % 3 === 0) {
        expect(r.status).toBe("rejected");
      } else {
        expect(r).toEqual({ status: "fulfilled", value: { item: `i${n}` } });
      }
    });
  });

  test("normalizes non-Error rejections so callers can always read .message", async () => {
    const agent = agentThat(() => {
      throw "just a string";
    });

    const [only] = await fanout([{ item: "a" }], agent, prompt, schema, 1);

    expect(only!.status).toBe("rejected");
    const reason = (only as { reason: Error }).reason;
    expect(reason).toBeInstanceOf(Error);
    expect(reason.message).toBe("just a string");
  });

  test("a timed-out structured response becomes a rejected item, not a poisoned batch", async () => {
    const agent = agentThat(
      (text) => text.includes("b")
        ? { content: "" }
        : { content: JSON.stringify({ item: "ok" }) },
      20,
    );

    const results = await fanout(items, agent, prompt, schema, 8);

    expect(fulfilled(results)).toHaveLength(2);
    expect(rejected(results)[0]).toBeInstanceOf(AgentTimeoutError);
  });

  test("empty input yields empty output", async () => {
    const results = await fanout([], agentThat(() => ({ content: "{}" })), prompt, schema, 4);
    expect(results).toEqual([]);
  });
});

describe("fulfilled / rejected", () => {
  const mixed = [
    { status: "fulfilled" as const, value: 1 },
    { status: "rejected" as const, reason: new Error("nope") },
    { status: "fulfilled" as const, value: 3 },
  ];

  test("fulfilled keeps only values, closing the gaps", () => {
    expect(fulfilled(mixed)).toEqual([1, 3]);
  });

  test("rejected keeps only reasons", () => {
    expect(rejected(mixed).map((e) => e.message)).toEqual(["nope"]);
  });

  test("both are empty-safe", () => {
    expect(fulfilled([])).toEqual([]);
    expect(rejected([])).toEqual([]);
  });
});
