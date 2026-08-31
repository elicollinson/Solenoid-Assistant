// A conversation, end to end, against a scripted model.
//
// The thing under test is not the agent and not the tables — both have their
// own files — but the seam between them, which is where all the interesting
// failures live: a run that stops mid-turn and comes back, a question nobody
// answers, and a screen that reloads while one is open and has to find the same
// buttons the stream drew.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatAgent } from "../agents/chat";
import type { ChatMessage, ChatOptions, ChatProvider } from "../core/providers";
import { createDb, runMigrations, type Db } from "../db";
import { loadChat } from "../db/queries/chat";
import { startConversation } from "../db/mutations/chat";
import { NotWaitingError, answerApproval, isHeld, runChatTurn } from "./session";
import type { ChatEvent } from "./turn";

class ScriptedProvider implements ChatProvider {
  readonly providerName = "scripted";
  readonly traced = true;
  calls = 0;

  constructor(private readonly script: Partial<ChatMessage>[]) {}

  async chat(_messages: ChatMessage[], _opts: ChatOptions): Promise<ChatMessage> {
    const next = this.script[this.calls++];
    if (!next) throw new Error(`no scripted response for call ${this.calls}`);
    return { role: "assistant", content: "", finishReason: "stop", ...next };
  }
}

let dir: string;
let db: Db;
let conversationId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chat-session-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  conversationId = startConversation(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The agent, with a scripted model and the injection screen out of the way —
 *  it has its own tests, and it needs a 200MB model this one should not load. */
function agentFor(script: Partial<ChatMessage>[]): ChatAgent {
  return new ChatAgent({
    routes: [{ client: new ScriptedProvider(script), model: "scripted" }],
    context: { db, okf: { root: join(dir, "okf"), actor: "chat/test" } },
    promptInjectionScreening: false,
  });
}

const call = (name: string, args: unknown, id = "call-1"): Partial<ChatMessage> => ({
  finishReason: "tool_calls",
  toolCalls: [{ id, name, arguments: args }],
});

/** Drain a turn to the end. Only safe when nothing in it stops to ask. */
async function drain(events: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const seen: ChatEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe("a turn that only reads", () => {
  test("runs the read without asking, and writes the reply down", async () => {
    const agent = agentFor([
      call("get_reminders_tools", {}),
      { ...call("reminders_list", {}, "call-2"), content: "Let me look." },
      { content: "Nothing is due today." },
    ]);

    const events = await drain(runChatTurn(db, agent, conversationId, "anything due?"));
    const types = events.map((event) => event.type);

    expect(types).not.toContain("approval");
    expect(events.find((e) => e.type === "opened")).toMatchObject({ group: "reminders" });
    // The sentence before the act reaches the screen ahead of the call.
    expect(types.indexOf("say")).toBeLessThan(types.lastIndexOf("tool"));
    expect(events.find((e) => e.type === "tool")).toMatchObject({
      name: "reminders.list",
      kind: "read",
      ok: true,
    });
    expect(events.at(-1)).toMatchObject({ type: "message", body: "Nothing is due today." });

    const chat = loadChat(db, conversationId);
    expect(chat.turns.map((turn) => turn.by)).toEqual(["user", "agent"]);
    // The loader is not drawn as a tool call — it did no work.
    expect(chat.turns[1]?.toolSummary).toBe("1 tool call · reminders.list");
    expect(chat.turns[1]?.note).toBe("opened reminders");
    expect(chat.waiting).toBe(0);
  });
});

describe("a turn that wants to write", () => {
  const script = () => [
    call("get_reminders_tools", {}),
    {
      ...call("reminders_create", { title: "Call the plumber" }, "call-2"),
      content: "I'll set a reminder to call the plumber.",
    },
    { content: "Done — it's set for tomorrow." },
  ];

  test("stops, asks, and goes ahead when you say so", async () => {
    const events = runChatTurn(db, agentFor(script()), conversationId, "remind me to call the plumber");
    const seen: ChatEvent[] = [];

    for await (const event of events) {
      seen.push(event);
      if (event.type === "approval") {
        // The bubble is a real row before the stream mentions it, so a reload
        // right here finds the same question and the same two buttons.
        const reloaded = loadChat(db, conversationId);
        const open = reloaded.turns.find((turn) => turn.approval?.state === "open");
        expect(open?.approval?.choices.map((choice) => choice.label)).toEqual([
          "Go ahead",
          "Not this one",
        ]);
        expect(reloaded.waiting).toBe(1);
        expect(isHeld(event.decisionId)).toBe(true);

        const goAhead = event.actions.find((action) => action.stance === "affirm")!;
        expect(answerApproval(db, goAhead.id)).toMatchObject({ outcome: "approved" });
      }
    }

    expect(seen.find((e) => e.type === "settled")).toMatchObject({ outcome: "approved" });
    // It ran: a write tool reports as a write, and it reports success.
    expect(seen.find((e) => e.type === "tool")).toMatchObject({
      name: "reminders.create",
      kind: "write",
    });
    expect(seen.at(-1)).toMatchObject({ type: "message" });

    const chat = loadChat(db, conversationId);
    const bubble = chat.turns.find((turn) => turn.approval)!;
    expect(bubble.approval).toMatchObject({ state: "resolved" });
    // Two sentences and two writes: which button, written the moment it was
    // pressed, and what the call did, which was not knowable until it returned.
    expect(bubble.approval?.settled).toContain('You said "Go ahead"');
    expect(bubble.approval?.settled).toContain("reminders.create ran and finished");
    expect(chat.waiting).toBe(0);
  });

  test("tells the model plainly when you say no, and writes nothing", async () => {
    const events = runChatTurn(db, agentFor(script()), conversationId, "remind me to call the plumber");
    const seen: ChatEvent[] = [];

    for await (const event of events) {
      seen.push(event);
      if (event.type === "approval") {
        const no = event.actions.find((action) => action.stance === "quiet")!;
        expect(answerApproval(db, no.id)).toMatchObject({ outcome: "declined" });
      }
    }

    expect(seen.find((e) => e.type === "settled")).toMatchObject({ outcome: "declined" });
    // No `tool` event at all: the call never ran, so there is nothing to draw.
    expect(seen.filter((e) => e.type === "tool")).toEqual([]);
    expect(db.$client.query("select count(*) as n from reminders").get()).toMatchObject({ n: 0 });

    const chat = loadChat(db, conversationId);
    const settled = chat.turns.find((turn) => turn.approval)?.approval?.settled ?? "";
    expect(settled).toContain('You said "Not this one"');
    // Nothing about a call, because there was no call. The second sentence is
    // only ever written by the tool actually running.
    expect(settled).not.toContain("ran and finished");
  });

  test("gives up rather than waiting forever, and says so", async () => {
    const events = runChatTurn(db, agentFor(script()), conversationId, "remind me", {
      approvalMs: 20,
    });
    const seen = await drain(events);

    expect(seen.find((e) => e.type === "settled")).toMatchObject({ outcome: "expired" });
    expect(seen.filter((e) => e.type === "tool")).toEqual([]);

    const chat = loadChat(db, conversationId);
    expect(chat.turns.find((turn) => turn.approval)?.approval).toMatchObject({
      state: "expired",
      settled: "No answer — nothing was written.",
    });
  });

  test("the facts under the ask name the call and what it was called with", async () => {
    const events = runChatTurn(db, agentFor(script()), conversationId, "remind me", {
      approvalMs: 20,
    });
    const approval = (await drain(events)).find((e) => e.type === "approval")!;
    expect(approval.facts).toContainEqual(["Call", "reminders.create"]);
    expect(approval.facts).toContainEqual(["title", "Call the plumber"]);
    // The ask is the agent's own sentence, not the tool's identifier.
    expect(approval.title).not.toContain("reminders_create");
    expect(approval.title.length).toBeGreaterThan(10);
    // The design's three other fields on the bubble: a reference you can read
    // out, why it is asking, and what is true while it waits.
    expect(approval.ref).toMatch(/^ap\/\d{4}-\d+$/);
    expect(approval.why ?? "").not.toBe("");
    expect(approval.hold).toContain("Nothing has been written");
  });
});

describe("answering something nobody is holding", () => {
  test("is refused rather than silently doing nothing", async () => {
    const events = runChatTurn(db, agentFor([{ content: "ok" }]), conversationId, "hello");
    await drain(events);
    // A decision id that never existed, and one that did but is long settled,
    // both land the same way: there is no run to release.
    expect(() => answerApproval(db, "no-such-action")).toThrow();
  });

  test("a second answer to the same question is refused, not applied twice", async () => {
    let actionId: string | undefined;
    const events = runChatTurn(
      db,
      agentFor([
        call("get_reminders_tools", {}),
        call("reminders_create", { title: "x" }, "call-2"),
        { content: "done" },
      ]),
      conversationId,
      "remind me",
    );

    for await (const event of events) {
      if (event.type === "approval") {
        actionId = event.actions[0]!.id;
        answerApproval(db, actionId);
      }
    }
    // The run has finished and let go, so the second attempt cannot find it.
    expect(() => answerApproval(db, actionId!)).toThrow();
  });
});

describe("the transcript the model is given back", () => {
  test("carries what you said and what it said, and what you answered", async () => {
    await drain(
      runChatTurn(db, agentFor([{ content: "Nothing is due." }]), conversationId, "anything due?"),
    );

    let secondTurnSaw: ChatMessage[] = [];
    class Recording extends ScriptedProvider {
      override async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
        // Copied: the loop pushes the reply onto this very array afterwards,
        // so a reference would show the turn plus its own answer.
        secondTurnSaw = messages.map((message) => ({ ...message }));
        return super.chat(messages, opts);
      }
    }
    const agent = new ChatAgent({
      routes: [{ client: new Recording([{ content: "Still nothing." }]), model: "scripted" }],
      context: { db, okf: { root: join(dir, "okf"), actor: "chat/test" } },
      promptInjectionScreening: false,
    });
    await drain(runChatTurn(db, agent, conversationId, "and now?"));

    const spoken = secondTurnSaw.filter((message) => message.role !== "system");
    expect(spoken.map((message) => message.content)).toEqual([
      "anything due?",
      "Nothing is due.",
      "and now?",
    ]);
    // The origins are the whole point — see src/safety/trust.ts. Nothing in a
    // chat's own replay defaults to `external`, which would abort on a flag.
    expect(spoken.map((message) => message.origin)).toEqual(["operator", "agent", "operator"]);
  });
});

describe("NotWaitingError", () => {
  test("names the decision, so a 410 says which question went stale", () => {
    expect(new NotWaitingError("01ABC").message).toContain("01ABC");
  });
});
