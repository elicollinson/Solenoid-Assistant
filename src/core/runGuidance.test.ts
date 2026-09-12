import { expect, test } from "bun:test";
import { Agent, PromptInjectionDetectedError } from "./rawAgent";
import type { ChatMessage, ChatProvider } from "./providers";
import { applyRunGuidance, withRunGuidance } from "./runGuidance";

const reply: ChatMessage = { role: "assistant", content: "done", finishReason: "stop" };

test("guidance remains operator input while external task data still receives blocking screening", async () => {
  let calls = 0;
  const screened: string[] = [];
  const client: ChatProvider = { providerName: "scripted", traced: true, chat: async () => { calls++; return reply; } };
  const worker = new Agent({
    routes: [{ client, model: "scripted" }],
    promptInjectionScreening: async (parts) => {
      const text = parts.join("\n");
      screened.push(text);
      return { flagged: text.includes("flagged") };
    },
  });
  await withRunGuidance("flagged operator guidance", () => worker.run("clean external task"));
  expect(calls).toBe(1);
  expect(screened).toContain("flagged operator guidance");
  await expect(withRunGuidance("clean operator guidance", () => worker.run("flagged external task")))
    .rejects.toBeInstanceOf(PromptInjectionDetectedError);
  expect(calls).toBe(1);
});

test("fallback routes receive one copy of guidance without mutating the supplied transcript", async () => {
  const captured: ChatMessage[][] = [];
  const first: ChatProvider = { providerName: "first", traced: true, chat: async (messages) => {
    captured.push(structuredClone(messages));
    throw new Error("first route unavailable");
  } };
  const fallback: ChatProvider = { providerName: "fallback", traced: true, chat: async (messages) => {
    captured.push(structuredClone(messages));
    return reply;
  } };
  const worker = new Agent({ routes: [{ client: first, model: "first" }, { client: fallback, model: "fallback" }], promptInjectionScreening: false });
  const messages: ChatMessage[] = [{ role: "system", content: "Existing rules" }, { role: "user", content: "Existing task" }];
  const original = structuredClone(messages);
  await withRunGuidance("One execution only", () => worker.runMessages(messages));
  expect(captured).toHaveLength(2);
  for (const request of captured) {
    expect(request.filter((m) => m.content === "One execution only")).toHaveLength(1);
    expect(request[0]).toEqual(original[0]!);
    expect(request.at(-1)).toEqual(original[1]!);
  }
  expect(messages).toEqual(original);
});

test("an empty nested execution clears inherited guidance and restores the parent scope afterwards", async () => {
  const task: ChatMessage[] = [{ role: "user", content: "Task" }];
  await withRunGuidance("parent focus", async () => {
    expect(applyRunGuidance(task).some((m) => m.content === "parent focus")).toBe(true);
    await withRunGuidance(undefined, async () => {
      await Promise.resolve();
      expect(applyRunGuidance(task)).toBe(task);
    });
    expect(applyRunGuidance(task).some((m) => m.content === "parent focus")).toBe(true);
  });
  expect(applyRunGuidance(task)).toBe(task);
});
