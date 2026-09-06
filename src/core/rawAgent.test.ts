import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  Agent,
  AgentTimeoutError,
  DEFAULT_AGENT_TIMEOUT_MS,
  PromptInjectionDetectedError,
  PromptInjectionScreeningError,
  extractJson,
  isPromptInjectionDetectedError,
  isPromptInjectionScreeningError,
  type ModelRouteInputChain,
} from "./rawAgent";
import { defineTool } from "./tools";
import { authoredText } from "../safety/authoredText";
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
const routes = (client: ChatProvider, model = "test-model") =>
  [{ client, model }] as const;

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
    const agent = new Agent({ routes: routes(client), promptInjectionScreening: false });

    expect(await agent.run("grade it", schema)).toEqual({ ok: true });
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.at(-1)?.content).toContain("submit_result");
    expect(client.optsSeen.map((options) => options.think)).toEqual([true, true]);
    expect(client.optsSeen[0]?.tools.some((tool) => tool.function.name === "submit_result"))
      .toBe(true);
  });

  test("accepts valid JSON content when a backend does not call the terminal tool", async () => {
    const client = new ScriptedProvider([{ content: '{"ok":true}' }]);
    const agent = new Agent({ routes: routes(client), promptInjectionScreening: false });

    expect(await agent.run("grade it", schema)).toEqual({ ok: true });
  });

  test("returns validation feedback and accepts a corrected submission", async () => {
    const client = new ScriptedProvider([
      { content: '{"ok":"yes"}' },
      submit({ ok: false }),
    ]);
    const agent = new Agent({ routes: routes(client), promptInjectionScreening: false });

    expect(await agent.run("grade it", schema)).toEqual({ ok: false });
    expect(client.calls[1]?.at(-1)?.content).toContain("required schema");
  });

  test("continues a token-limited turn instead of treating it as final", async () => {
    const client = new ScriptedProvider([
      { content: '{"ok":', finishReason: "length" },
      submit({ ok: true }),
    ]);
    const agent = new Agent({ routes: routes(client), promptInjectionScreening: false });

    expect(await agent.run("grade it", schema)).toEqual({ ok: true });
    expect(client.calls[1]?.at(-1)?.content).toContain("submit_result");
  });

  test("can explicitly disable reasoning for native structured work", async () => {
    const client = new ScriptedProvider([submit({ ok: true })]);
    const agent = new Agent({
      routes: routes(client),
      thinkOnStructured: false,
      promptInjectionScreening: false,
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
    const agent = new Agent({ routes: routes(client), promptInjectionScreening: false });

    expect(await agent.run("grade it", schema)).toEqual({ ok: true });
    expect(client.optsSeen.map((options) => options.phase)).toEqual(["work", "serialize"]);
    expect(client.optsSeen.map((options) => options.think)).toEqual([true, false]);
    expect(client.optsSeen[0]?.format).toBeUndefined();
    expect(client.optsSeen[1]?.format?.name).toBe("agent_output");
    expect(client.optsSeen[1]?.tools).toEqual([]);
  });
});

describe("deadline and continuation", () => {
  test("uses a five-minute default deadline", () => {
    expect(DEFAULT_AGENT_TIMEOUT_MS).toBe(300_000);
  });

  test("returns a typed timeout when a provider call never completes", async () => {
    const client: ChatProvider = {
      traced: true,
      providerName: "hanging",
      chat: async () => new Promise<ChatMessage>(() => {}),
    };
    const agent = new Agent({ routes: routes(client), timeoutMs: 20, promptInjectionScreening: false });

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
    const agent = new Agent({ routes: routes(client), timeoutMs: 1_000, promptInjectionScreening: false });

    expect(await agent.run("grade it", schema)).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  test("keeps an unstructured empty answer valid when there is no reasoning", async () => {
    const client = new ScriptedProvider([{ content: "" }]);
    const agent = new Agent({ routes: routes(client), promptInjectionScreening: false });
    expect(await agent.run("say nothing")).toBe("");
  });

  test("advances through every route from the original input until one succeeds", async () => {
    const primary = new ScriptedProvider([{ finishReason: "refusal" }]);
    const second = new ScriptedProvider([{ finishReason: "refusal" }]);
    const third = new ScriptedProvider([submit({ ok: true })]);
    let reviewedRoute: string | undefined;
    const reviewer: Reviewer = {
      name: "route-check",
      review: async ({ client, model }) => {
        reviewedRoute = `${client?.providerName}/${model}`;
        return { passed: true, feedback: "ok" };
      },
    };
    const agent = new Agent({
      routes: [
        { client: primary, model: "primary-model" },
        { client: second, model: "second-model" },
        { client: third, model: "third-model" },
      ],
      reviewers: [reviewer],
      promptInjectionScreening: false,
    });

    expect(await agent.run("grade it", schema)).toEqual({ ok: true });
    expect(primary.optsSeen[0]?.model).toBe("primary-model");
    expect(second.optsSeen[0]?.model).toBe("second-model");
    expect(third.optsSeen[0]?.model).toBe("third-model");
    expect(third.calls[0]?.some((message) => message.finishReason === "refusal"))
      .toBe(false);
    expect(third.calls[0]?.some((message) => message.content === "grade it"))
      .toBe(true);
    expect(reviewedRoute).toBe("scripted/third-model");
  });

  test("gives each route attempt a fresh deadline", async () => {
    const primary: ChatProvider = {
      traced: true,
      providerName: "hanging-primary",
      chat: async () => new Promise<ChatMessage>(() => {}),
    };
    const fallback = new ScriptedProvider([{ content: "recovered" }]);
    const agent = new Agent({
      routes: [
        { client: primary, model: "primary-model" },
        { client: fallback, model: "fallback-model" },
      ],
      timeoutMs: 20,
      promptInjectionScreening: false,
    });

    expect(await agent.run("recover this")).toBe("recovered");
  });
});

describe("prompt-injection screening", () => {
  const benign = async () => ({ flagged: false });

  test("detection is terminal and does not advance model routes", async () => {
    const primary = new ScriptedProvider([{ content: "should not run" }]);
    const fallback = new ScriptedProvider([{ content: "should not run" }]);
    const rejectedText = "private rejected payload";
    const agent = new Agent({
      routes: [
        { client: primary, model: "primary" },
        { client: fallback, model: "fallback" },
      ],
      promptInjectionScreening: async ([text]) => ({
        flagged: text.includes(rejectedText),
      }),
    });

    const error = await agent.run(rejectedText).catch((caught) => caught);
    expect(error).toBeInstanceOf(PromptInjectionDetectedError);
    expect(isPromptInjectionDetectedError(error)).toBe(true);
    expect((error as Error).message).not.toContain(rejectedText);
    expect((error as PromptInjectionDetectedError).boundary).toBe("input");
    expect(primary.calls).toHaveLength(0);
    expect(fallback.calls).toHaveLength(0);
  });

  test("malicious model output terminates the route chain", async () => {
    const primary = new ScriptedProvider([{ content: "malicious output" }]);
    const fallback = new ScriptedProvider([{ content: "fallback" }]);
    const agent = new Agent({
      routes: [
        { client: primary, model: "primary" },
        { client: fallback, model: "fallback" },
      ],
      promptInjectionScreening: async ([text]) => ({
        flagged: text === "malicious output",
      }),
    });

    const error = await agent.run("benign input").catch((caught) => caught);
    expect(isPromptInjectionDetectedError(error)).toBe(true);
    expect((error as PromptInjectionDetectedError).boundary).toBe("model_output");
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(0);
  });

  test("tool and reviewer outputs are independently screened", async () => {
    const tool = defineTool({
      name: "external",
      kind: "read",
      description: "external data",
      schema: z.object({}),
      execute: () => "unsafe tool result",
    });
    const toolClient = new ScriptedProvider([{
      finishReason: "tool_calls",
      toolCalls: [{ id: "tool-1", name: "external", arguments: {} }],
    }]);
    const toolAgent = new Agent({
      routes: routes(toolClient),
      tools: [tool],
      promptInjectionScreening: async ([text]) => ({
        flagged: text === "unsafe tool result",
      }),
    });
    const toolError = await toolAgent.run("benign").catch((caught) => caught);
    expect((toolError as PromptInjectionDetectedError).boundary).toBe("tool_output");

    const reviewer: Reviewer = {
      name: "unsafe-reviewer",
      review: async () => ({ passed: false, feedback: "unsafe feedback" }),
    };
    const reviewAgent = new Agent({
      routes: routes(new ScriptedProvider([{ content: "candidate" }])),
      reviewers: [reviewer],
      promptInjectionScreening: async ([text]) => ({
        flagged: text === "unsafe feedback",
      }),
    });
    const reviewError = await reviewAgent.run("benign").catch((caught) => caught);
    expect((reviewError as PromptInjectionDetectedError).boundary).toBe("reviewer_output");
  });

  test("scanner failure is typed, safe, and terminal", async () => {
    const primary = new ScriptedProvider([{ content: "unused" }]);
    const fallback = new ScriptedProvider([{ content: "unused" }]);
    const agent = new Agent({
      routes: [
        { client: primary, model: "primary" },
        { client: fallback, model: "fallback" },
      ],
      promptInjectionScreening: async () => {
        throw new Error("backend accidentally echoed sensitive input");
      },
    });

    const error = await agent.run("sensitive input").catch((caught) => caught);
    expect(error).toBeInstanceOf(PromptInjectionScreeningError);
    expect(isPromptInjectionScreeningError(error)).toBe(true);
    expect((error as Error).message).toBe("Prompt injection screening failed");
    expect(primary.calls).toHaveLength(0);
    expect(fallback.calls).toHaveLength(0);
  });

  test("screening can be explicitly disabled", async () => {
    const client = new ScriptedProvider([{ content: "ok" }]);
    const agent = new Agent({
      routes: routes(client),
      promptInjectionScreening: false,
    });
    expect(await agent.run("anything")).toBe("ok");
    expect(await benign()).toEqual({ flagged: false });
  });

  test("type guards work across package boundaries without instanceof", () => {
    expect(isPromptInjectionDetectedError({
      code: "PROMPT_INJECTION_DETECTED",
      boundary: "input",
    })).toBe(true);
    expect(isPromptInjectionScreeningError({
      code: "PROMPT_INJECTION_SCREENING_FAILED",
    })).toBe(true);
  });
});

describe("tools and reviewers", () => {
  test("does not impose a predefined tool-turn count", async () => {
    const tool = defineTool({
      name: "increment",
      kind: "read",
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
    const agent = new Agent({ routes: routes(client), tools: [tool], promptInjectionScreening: false });

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
    const agent = new Agent({ routes: routes(client), reviewers: [reviewer], promptInjectionScreening: false });

    expect(await agent.run("write it")).toBe("revised draft");
    expect(client.calls[1]?.at(-1)?.content).toContain("Be more specific");
  });
});

describe("agent construction", () => {
  test("rejects invalid deadlines and duplicate components", () => {
    const client = new ScriptedProvider([]);
    expect(() => new Agent({
      routes: [] as unknown as ModelRouteInputChain,
    })).toThrow(/At least one model route/);
    expect(() => new Agent({ routes: routes(client, "test"), timeoutMs: 0 })).toThrow(
      /positive finite/,
    );

    const tool = defineTool({
      name: "same",
      kind: "read",
      description: "same",
      schema: z.object({}),
      execute: () => null,
    });
    expect(() => new Agent({ routes: routes(client, "test"), tools: [tool, tool] })).toThrow(
      /already registered/,
    );

    const reserved = defineTool({
      name: "submit_result",
      description: "reserved",
      kind: "read",
      schema: z.object({}),
      execute: () => null,
    });
    expect(() => new Agent({ routes: routes(client, "test"), tools: [reserved] })).toThrow(
      /reserved/,
    );
  });
});

// ---------------------------------------------------------------------------
// The trust boundary: who wrote the text, not where it turned up.
// ---------------------------------------------------------------------------

describe("trust boundary", () => {
  const flagged = "the text that trips the classifier";
  const screener = async (parts: readonly string[]) => ({
    flagged: parts.join("\n").includes(flagged),
    score: 0.9,
  });

  test("text of undeclared origin aborts, because external is the default", async () => {
    const client = new ScriptedProvider([{ content: "unreachable" }]);
    const agent = new Agent({
      routes: routes(client),
      promptInjectionScreening: screener,
    });

    const error = await agent.runMessages([{ role: "user", content: flagged }])
      .catch((caught) => caught);
    expect(isPromptInjectionDetectedError(error)).toBe(true);
    expect(client.calls).toHaveLength(0);
  });

  // The operator is the principal. A false positive here would refuse them
  // their own assistant, and there is no privilege for them to escalate to.
  test("the same text declared operator is observed, and the run continues", async () => {
    const client = new ScriptedProvider([{ content: "done" }]);
    const agent = new Agent({
      routes: routes(client),
      promptInjectionScreening: screener,
    });

    const result = await agent.runMessages([
      { role: "user", content: flagged, origin: "operator" },
    ]);
    expect(result).toBe("done");
    expect(client.calls).toHaveLength(1);
  });

  // Origin is per message, so an operator asking about a document does not
  // launder the document.
  test("an operator message does not cover external text beside it", async () => {
    const client = new ScriptedProvider([{ content: "unreachable" }]);
    const agent = new Agent({
      routes: routes(client),
      promptInjectionScreening: screener,
    });

    const error = await agent.runMessages([
      { role: "user", content: "what does this page say?", origin: "operator" },
      { role: "user", content: flagged, origin: "external" },
    ]).catch((caught) => caught);

    expect(isPromptInjectionDetectedError(error)).toBe(true);
    expect(client.calls).toHaveLength(0);
  });

  // The message-extraction and screenshot workflows put a stranger's text into
  // the opening transcript. Reading "the first user message" as the operator
  // would have quietly stopped quarantining them.
  test("an injection split across two external messages is still seen whole", async () => {
    const client = new ScriptedProvider([{ content: "unreachable" }]);
    const seen: string[] = [];
    const agent = new Agent({
      routes: routes(client),
      promptInjectionScreening: async (parts) => {
        const combined = parts.join("\n");
        seen.push(combined);
        return { flagged: combined.includes("SPLIT") && combined.includes("OVERRIDE") };
      },
    });

    const error = await agent.runMessages([
      { role: "user", content: "SPLIT" },
      { role: "user", content: "OVERRIDE" },
    ]).catch((caught) => caught);

    expect(isPromptInjectionDetectedError(error)).toBe(true);
    expect(seen[0]).toContain("SPLIT\nOVERRIDE");
  });

  test("authored text is subtracted before the screener sees anything", async () => {
    const authored =
      "Read one suggestion in full before revising it, so you are sharpening what is there.";
    authoredText.register("test:authored", authored);

    const seen: string[] = [];
    const echo = defineTool({
      name: "echo_authored",
      kind: "read",
      description: "Return a block of text this repository wrote, and nothing else at all.",
      schema: z.object({}),
      execute: () => authored,
    });
    const client = new ScriptedProvider([
      { finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "echo_authored", arguments: {} }] },
      { content: "done" },
    ]);
    const agent = new Agent({
      routes: routes(client),
      tools: [echo],
      promptInjectionScreening: async (parts) => {
        const combined = parts.join("\n");
        seen.push(combined);
        return { flagged: combined.includes("sharpening what is there") };
      },
    });

    // Would abort if the tool result reached the screener; it redacts to
    // nothing, so the screen is skipped for it entirely.
    expect(await agent.runMessages([
      { role: "user", content: "go on then", origin: "operator" },
    ])).toBe("done");
    expect(seen.length).toBeGreaterThan(0); // the screen did run, on other text
    expect(seen.some((part) => part.includes("sharpening what is there"))).toBe(false);
  });
});

describe("what a tool call came back with", () => {
  /** Reach the protected seam the way ChatAgent does, without a chat. */
  const outcomeOf = async (tool: ReturnType<typeof defineTool>) => {
    const agent = new Agent({
      routes: routes(new ScriptedProvider([{ content: "unused" }])),
      tools: [tool],
      promptInjectionScreening: false,
    });
    const session = (agent as unknown as { groups: { session(): unknown } }).groups.session();
    return (agent as unknown as {
      invokeTool: (
        n: string,
        a: unknown,
        s: AbortSignal | undefined,
        sess: unknown,
      ) => Promise<{ ok: boolean; output: string }>;
    }).invokeTool(tool.definition.function.name, {}, undefined, session);
  };

  test("a successful call is a success however its output happens to read", async () => {
    // The failure this replaced: `ok` was read off the front of the string, so
    // a tool that answered with somebody else's prose — an MCP server relays
    // one verbatim — was recorded as a write that had been allowed and failed.
    const relay = defineTool({
      name: "relay_remote_text",
      description: "Hand back exactly what the far end said, whatever that was.",
      kind: "read",
      schema: z.object({}),
      execute: () => "Error: the printer is out of paper, they said.",
    });
    expect(await outcomeOf(relay)).toEqual({
      ok: true,
      output: "Error: the printer is out of paper, they said.",
    });
  });

  test("a throwing call is a failure, and the model is told rather than thrown at", async () => {
    const broken = defineTool({
      name: "break_on_purpose",
      description: "Always throws, so the loop's error path can be exercised.",
      kind: "write",
      schema: z.object({}),
      execute: () => {
        throw new Error("the printer is out of paper");
      },
    });
    expect(await outcomeOf(broken)).toEqual({
      ok: false,
      output: "Error: the printer is out of paper",
    });
  });

  test("a name the model has not unlocked is a failure with the instruction in it", async () => {
    const anything = defineTool({
      name: "anything_at_all",
      description: "Present only so the agent under test has something registered.",
      kind: "read",
      schema: z.object({}),
      execute: () => "fine",
    });
    const agent = new Agent({
      routes: routes(new ScriptedProvider([{ content: "unused" }])),
      tools: [anything],
      promptInjectionScreening: false,
    });
    const session = (agent as unknown as { groups: { session(): unknown } }).groups.session();
    const outcome = await (agent as unknown as {
      invokeTool: (
        n: string,
        a: unknown,
        s: AbortSignal | undefined,
        sess: unknown,
      ) => Promise<{ ok: boolean; output: string }>;
    }).invokeTool("no_such_tool", {}, undefined, session);
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain("unknown tool");
  });
});
