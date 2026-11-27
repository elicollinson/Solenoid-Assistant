import { expect, test } from "bun:test";
import { createSecurity } from "@elicollinson/solenoid-security";
import { AssistantAgent, PromptInjectionDetectedError } from "./engine";
import type { ChatMessage, ChatProvider } from "./providers";
import { applyRunGuidance, withRunGuidance } from "./runGuidance";

const reply: ChatMessage = { role: "assistant", content: "done", finishReason: "stop" };

test("guidance remains operator input while external task data still receives blocking screening", async () => {
  let calls = 0;
  const screened: string[] = [];
  const captured: ChatMessage[][] = [];
  const client: ChatProvider = {
    providerName: "scripted",
    chat: async (messages) => {
      calls++;
      captured.push(structuredClone(messages));
      return reply;
    },
  };
  const security = createSecurity({
    provider: {
      async assess(parts) {
        const text = parts.join("\n");
        screened.push(text);
        const flagged = text.includes("flagged");
        return {
          flagged,
          blocked: flagged,
          label: flagged ? "MALICIOUS" : "BENIGN",
          score: flagged ? 1 : 0,
        };
      },
    },
  });
  const worker = new AssistantAgent({
    routes: [{ client, model: "scripted" }],
    screen: security.screen,
  });
  await withRunGuidance("flagged operator guidance", () => worker.run("clean external task"));
  expect(calls).toBe(1);
  expect(captured[0]?.at(-1)?.content).toContain("flagged operator guidance");

  // applyRunGuidance also marks guidance as origin: "operator", so screening observes without blocking.
  const explicitMessages = withRunGuidance("flagged operator guidance", () =>
    applyRunGuidance([{ role: "user", content: "clean external task" }]),
  );
  await worker.runMessages(explicitMessages);
  expect(calls).toBe(2);
  expect(screened).toContain("flagged operator guidance");

  await expect(withRunGuidance("clean operator guidance", () => worker.run("flagged external task")))
    .rejects.toBeInstanceOf(PromptInjectionDetectedError);
  expect(calls).toBe(2);
});

test("fallback routes receive one copy of guidance without mutating the supplied transcript", async () => {
  const captured: ChatMessage[][] = [];
  const first: ChatProvider = { providerName: "first", chat: async (messages) => {
    captured.push(structuredClone(messages));
    throw new Error("first route unavailable");
  } };
  const fallback: ChatProvider = { providerName: "fallback", chat: async (messages) => {
    captured.push(structuredClone(messages));
    return reply;
  } };
  const worker = new AssistantAgent({ routes: [{ client: first, model: "first" }, { client: fallback, model: "fallback" }] });
  const messages: ChatMessage[] = [{ role: "system", content: "Existing rules" }, { role: "user", content: "Existing task" }];
  const original = structuredClone(messages);
  const result = await withRunGuidance("One execution only", () => worker.runMessages(messages));
  expect(captured).toHaveLength(2);
  for (const request of captured) {
    expect(request.filter((m) => m.content.includes("One execution only"))).toHaveLength(1);
    expect(request[0]).toEqual(original[0]!);
    expect(request.at(-1)?.role).toBe("user");
    expect(request.at(-1)?.content).toContain("Existing task");
    expect(request.at(-1)?.content).toContain("One execution only");
  }
  expect(result.messages.some((m) => m.content.includes("One execution only"))).toBe(false);
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
