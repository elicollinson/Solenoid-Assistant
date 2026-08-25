import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  Agent,
  AgentTimeoutError,
  PromptInjectionDetectedError,
  PromptInjectionScreeningError,
} from "../core/rawAgent";
import { fanout, fulfilled, rejected, runIsolated } from "./fanout";
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
  promptInjectionScreening: false,
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

describe("runIsolated", () => {
  test("bounds concurrency and preserves positional results", async () => {
    const input = Array.from({ length: 12 }, (_, index) => index);
    let active = 0;
    let peak = 0;
    const batch = await runIsolated({
      items: input,
      key: (item) => `item-${item}`,
      concurrency: 3,
      execute: async (item) => {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep((12 - item) % 4);
        active--;
        return item * 2;
      },
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(batch.results.map((result) => result.index)).toEqual(input);
    expect(batch.results.map((result) =>
      result.status === "fulfilled" ? result.value : null
    )).toEqual(input.map((item) => item * 2));
    expect(batch).toMatchObject({ completed: 12, quarantined: 0, failed: 0 });
  });

  test("quarantines detections at any agent boundary while siblings continue", async () => {
    const batch = await runIsolated({
      items: ["input", "model", "ok"],
      key: (item) => item,
      concurrency: 2,
      execute: async (item) => {
        if (item === "input") throw new PromptInjectionDetectedError("input");
        if (item === "model") throw new PromptInjectionDetectedError("model_output");
        return "done";
      },
    });

    expect(batch.results).toEqual([
      {
        status: "quarantined",
        key: "input",
        index: 0,
        reason: "prompt_injection",
        boundary: "input",
      },
      {
        status: "quarantined",
        key: "model",
        index: 1,
        reason: "prompt_injection",
        boundary: "model_output",
      },
      { status: "fulfilled", key: "ok", index: 2, value: "done" },
    ]);
    expect(batch).toMatchObject({ completed: 1, quarantined: 2, failed: 0 });
  });

  test("records ordinary errors and continues", async () => {
    const batch = await runIsolated({
      items: [0, 1, 2],
      key: (item) => item,
      concurrency: 2,
      execute: (item) => {
        if (item === 1) throw "ordinary failure";
        return item;
      },
    });
    expect(batch.completed).toBe(2);
    expect(batch.failed).toBe(1);
    expect(batch.results[1]?.status).toBe("rejected");
    expect((batch.results[1] as { reason: Error }).reason.message).toBe(
      "ordinary failure",
    );
  });

  test("scanner failure stops scheduling new work and rejects the batch", async () => {
    const started: number[] = [];
    const promise = runIsolated({
      items: [0, 1, 2, 3, 4],
      key: (item) => item,
      concurrency: 2,
      execute: async (item) => {
        started.push(item);
        if (item === 0) throw new PromptInjectionScreeningError();
        await Bun.sleep(5);
        return item;
      },
    });

    await expect(promise).rejects.toBeInstanceOf(PromptInjectionScreeningError);
    expect(started.every((item) => item < 2)).toBe(true);
  });

  test("rejects duplicate and invalid keys before executing anything", async () => {
    let executions = 0;
    const duplicate = runIsolated({
      items: ["a", "b"],
      key: () => "same",
      concurrency: 1,
      execute: () => executions++,
    });
    await expect(duplicate).rejects.toThrow(/Duplicate isolation key/);

    const invalid = runIsolated({
      items: ["a"],
      key: () => "" as string,
      concurrency: 1,
      execute: () => executions++,
    });
    await expect(invalid).rejects.toThrow(/Invalid isolation key/);
    expect(executions).toBe(0);
  });

  test("empty input returns an empty summary", async () => {
    const batch = await runIsolated({
      items: [] as string[],
      key: (item) => item,
      concurrency: 8,
      execute: (item) => item,
    });
    expect(batch).toEqual({
      results: [],
      completed: 0,
      quarantined: 0,
      failed: 0,
    });
  });

  test("nested iterators contain detection at the nearest boundary", async () => {
    const outer = await runIsolated({
      items: ["conversation-a", "conversation-b"],
      key: (item) => item,
      concurrency: 2,
      execute: async (conversation) => runIsolated({
        items: conversation === "conversation-a" ? ["safe", "bad"] : ["safe"],
        key: (item, index) => `${conversation}-${index}-${item}`,
        concurrency: 2,
        execute: (item) => {
          if (item === "bad") throw new PromptInjectionDetectedError("input");
          return item;
        },
      }),
    });

    expect(outer.completed).toBe(2);
    expect(outer.quarantined).toBe(0);
    const inner = outer.results[0];
    expect(inner?.status).toBe("fulfilled");
    if (inner?.status === "fulfilled") expect(inner.value.quarantined).toBe(1);
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
