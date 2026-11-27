// Surface 6 — Gemini Live Voice Checkpoint Persistence, Bidirectional Voice <-> Typed Chat
// Handoff, 24-Turn Checkpoint Restore (incl. Extended Thinking Reconnect), and Concurrency Guard.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@ag-ui/core";
import {
  InteractionStatus,
  Live,
  LiveServerMessage,
  type LiveConnectParameters,
  type Session as LiveSdkSession,
} from "@google/genai";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  AppSettingsSchema,
  SOLENOID_METADATA_KEY,
  createHarness,
  defineTool,
  type AgentProfile,
  type AgentTool,
  type ChatMessage,
  type ChatOptions,
  type ChatProvider,
  type ExternalTurnInput,
} from "@elicollinson/solenoid-engine";
import { loadRuntimeConfig } from "../core/config";
import { createDb, runMigrations, type Db } from "../db";
import * as s from "../db/schema";
import { DrizzleCheckpointStore } from "../db/chatCheckpoints";
import { startConversation } from "../db/mutations/chat";
import { loadChat } from "../db/queries/chat";
import type { ChatEvent } from "../shared/chat";
import { SessionCoordinator } from "./coordinator";
import { GeminiLiveSession, type GeminiLiveEvent } from "./geminiLive";

type ScriptStep =
  | ChatMessage
  | Error
  | ((messages: ChatMessage[], opts: ChatOptions) => ChatMessage | Promise<ChatMessage>);

class RoleRoutedProvider implements ChatProvider {
  readonly providerName = "scripted";
  readonly parentCalls: ChatMessage[][] = [];
  readonly childCalls: ChatMessage[][] = [];

  constructor(
    private readonly parentSteps: ScriptStep[],
    private readonly childSteps: ScriptStep[] = [],
  ) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    const isParent =
      opts.tools.some((t) => t.function.name === "spawn_subagent") || this.childSteps.length === 0;
    const bucket = isParent ? this.parentCalls : this.childCalls;
    const queue = isParent ? this.parentSteps : this.childSteps;
    bucket.push(messages.map((m) => ({ ...m })));
    const step = queue.shift();
    if (!step) {
      throw new Error(`RoleRoutedProvider (${isParent ? "parent" : "child"}) exhausted`);
    }
    if (step instanceof Error) throw step;
    const msg = typeof step === "function" ? await step(messages, opts) : step;
    if (msg.content) opts.onDelta?.({ type: "text", text: msg.content });
    return msg;
  }
}

const say = (content: string): ChatMessage => ({ role: "assistant", content });
const call = (name: string, args: unknown, id = `call_${name}`): ChatMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name, arguments: args }],
});

class EventCollector {
  readonly events: ChatEvent[] = [];
  private readonly waiters: Array<{
    predicate: (event: ChatEvent) => boolean;
    resolve: (event: ChatEvent) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  readonly listener = (event: ChatEvent): void => {
    this.events.push(event);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i]!;
      if (waiter.predicate(event)) {
        clearTimeout(waiter.timer);
        this.waiters.splice(i, 1);
        waiter.resolve(event);
      }
    }
  };

  waitFor<T extends ChatEvent = ChatEvent>(
    predicate: (event: ChatEvent) => event is T,
    timeoutMs?: number,
  ): Promise<T>;
  waitFor(predicate: (event: ChatEvent) => boolean, timeoutMs?: number): Promise<ChatEvent>;
  waitFor(predicate: (event: ChatEvent) => boolean, timeoutMs = 2_000): Promise<ChatEvent> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<ChatEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for ChatEvent (saw: ${this.events.map((e) => e.type).join(", ")})`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }
}

interface ClientContentPayload {
  turns: Array<{ role: string; parts: Array<{ text: string }> }>;
  turnComplete: boolean;
}

let dir: string;
let db: Db;
let conversationId: string;
let activeCoordinators: SessionCoordinator[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "voice-checkpoint-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  conversationId = startConversation(db);
  activeCoordinators = [];
});

afterEach(async () => {
  for (const coordinator of activeCoordinators) {
    try {
      await coordinator.close();
    } catch {
      // Ignore cleanup errors during Wave 1 stub red phase.
    }
  }
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

async function buildCoordinator(options: {
  provider: ChatProvider;
  tools?: AgentTool[];
  canSpawn?: boolean;
}) {
  const store = new DrizzleCheckpointStore(db);
  const settings = AppSettingsSchema.parse({
    screening: { enabled: false },
    checkpoints: { enabled: true },
    device: { id: "server-1", name: "solenoid-server" },
  });
  const harness = await createHarness(settings, {
    checkpointStore: store,
    routes: [{ client: options.provider, model: "scripted" }],
    screener: null,
    baseTools: [],
  });
  const tools = options.tools ?? [];
  const profileFactory = (): AgentProfile => ({
    name: "chat",
    tools,
    canSpawn: options.canSpawn ?? false,
    routes: [{ client: options.provider, model: "scripted" }],
    screening: false,
  });
  const coordinator = new SessionCoordinator({
    db,
    harness,
    profileFactory,
  });
  activeCoordinators.push(coordinator);
  return { coordinator, store, harness };
}

/** Tracks `coordinator.appendVoiceTurn` calls and awaits all in-flight appends cleanly. */
function instrumentAppendVoiceTurn(coordinator: SessionCoordinator) {
  const recorded: Array<{ conversationId: string; input: ExternalTurnInput }> = [];
  const pending: Promise<void>[] = [];
  const original = coordinator.appendVoiceTurn.bind(coordinator);

  const spy = spyOn(coordinator, "appendVoiceTurn").mockImplementation((convId, input) => {
    recorded.push({ conversationId: convId, input });
    const promise = original(convId, input);
    pending.push(promise);
    return promise;
  });

  const flush = async () => {
    await Promise.resolve();
    await Promise.all(pending);
  };

  return { recorded, pending, spy, flush };
}

async function withMockedVoiceSession(
  coordinator: SessionCoordinator,
  run: (h: {
    session: GeminiLiveSession;
    events: GeminiLiveEvent[];
    connections: LiveConnectParameters[];
    clientContents: ClientContentPayload[];
    toolResponses: unknown[];
    receive: (message: Partial<LiveServerMessage>) => Promise<void>;
    addTool: (name: string, execute: (args: unknown) => Promise<unknown>) => void;
  }) => Promise<void>,
) {
  let latestConnection!: LiveConnectParameters;
  const events: GeminiLiveEvent[] = [];
  const connections: LiveConnectParameters[] = [];
  const clientContents: ClientContentPayload[] = [];
  const toolResponses: unknown[] = [];

  const connectSpy = spyOn(Live.prototype, "connect").mockImplementation(async (params) => {
    latestConnection = params;
    connections.push(params);
    return {
      close() {},
      sendToolResponse: (response: unknown) => toolResponses.push(response),
      sendClientContent: (content: unknown) => clientContents.push(content as ClientContentPayload),
    } as unknown as LiveSdkSession;
  });

  const session = new GeminiLiveSession({
    db,
    conversationId,
    config: loadRuntimeConfig({ GEMINI_API_KEY: "test-only" }),
    coordinator,
    onEvent: (event) => events.push(event),
  });

  try {
    await session.start();
    await latestConnection.callbacks.onmessage(
      Object.assign(new LiveServerMessage(), { setupComplete: {} }),
    );
    await run({
      session,
      events,
      connections,
      clientContents,
      toolResponses,
      receive: async (message) => {
        await latestConnection.callbacks.onmessage(Object.assign(new LiveServerMessage(), message));
      },
      addTool: (name, execute) => {
        const tools = (session as unknown as { toolsByName: Map<string, unknown> }).toolsByName;
        tools.set(name, { name, kind: "read", execute });
      },
    });
  } finally {
    session.close();
    connectSpy.mockRestore();
  }
}

// ---------------------------------------------------------------------------
// 1. Voice Persistence via coordinator.appendVoiceTurn (NOT legacy `messages`)
// ---------------------------------------------------------------------------

describe("GeminiLiveSession checkpoint persistence", () => {
  test("persists spoken user + assistant turns and voice tool calls via coordinator.appendVoiceTurn into checkpoint, NOT legacy messages table", async () => {
    const provider = new RoleRoutedProvider([]);
    const { coordinator, store } = await buildCoordinator({ provider });
    const tracked = instrumentAppendVoiceTurn(coordinator);

    await withMockedVoiceSession(coordinator, async ({ receive, addTool, toolResponses }) => {
      addTool("test_lookup", async () => ({ meeting: "Design review at noon" }));

      await receive({
        serverContent: {
          inputTranscription: { text: "When is my next meeting?", finished: true },
        },
      });
      await receive({
        toolCall: {
          functionCalls: [{ id: "vc-1", name: "test_lookup", args: { query: "next meeting" } }],
        },
        serverContent: {
          outputTranscription: { text: "Checking. " },
          interactionStatus: InteractionStatus.IN_PROGRESS,
        },
      });
      // Allow local tool execution microtask to finish before final spoken output.
      await Promise.resolve();
      expect(toolResponses).toHaveLength(1);

      await receive({
        serverContent: {
          outputTranscription: { text: "Your design review is at noon." },
          turnComplete: true,
          interactionStatus: InteractionStatus.IDLE,
        },
      });

      await tracked.flush();
    });

    // Must have persisted via coordinator.appendVoiceTurn with voice provenance & screened: false!
    expect(tracked.recorded.length).toBeGreaterThanOrEqual(1);
    const voiceWrite = tracked.recorded.find((r) => r.input.assistantText);
    expect(voiceWrite).toBeDefined();
    expect(voiceWrite!.conversationId).toBe(conversationId);
    expect(voiceWrite!.input).toMatchObject({
      source: "voice",
      model: "models/gemini-3.8-live-extended-thinking",
      screened: false,
      userText: "When is my next meeting?",
      assistantText: expect.stringContaining("Your design review is at noon."),
    });
    expect(voiceWrite!.input.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "test_lookup",
          ok: true,
        }),
      ]),
    );

    // Must NOT write to the legacy `messages` table when coordinator is injected!
    const legacyRows = db
      .select()
      .from(s.messages)
      .where(eq(s.messages.conversationId, conversationId))
      .all();
    expect(legacyRows).toHaveLength(0);

    // Checkpoint holds the voice turn stamped with `metadata.solenoid.source === 'voice'`.
    const loaded = await store.load(conversationId);
    expect(loaded).toBeDefined();
    const voiceMessages = loaded!.checkpoint.thread.filter(
      (m) => (m.metadata?.[SOLENOID_METADATA_KEY] as { source?: string } | undefined)?.source === "voice",
    );
    expect(voiceMessages.length).toBeGreaterThanOrEqual(2);

    // Unscreened voice tool outputs must NOT be falsely marked `screened: true`.
    const toolTranscriptEntries = loaded!.checkpoint.transcript.filter((m) => m.role === "tool");
    for (const entry of toolTranscriptEntries) {
      expect(entry.screened).not.toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Voice -> Typed Chat Handoff
// ---------------------------------------------------------------------------

describe("Voice -> Typed Chat handoff", () => {
  test("typed turn via SessionCoordinator.send() sees prior voice turns in its transcript and loadChat() marks them source: 'voice'", async () => {
    const provider = new RoleRoutedProvider([say("Your project codename is solstice-42.")]);
    const { coordinator } = await buildCoordinator({ provider });
    const tracked = instrumentAppendVoiceTurn(coordinator);

    await withMockedVoiceSession(coordinator, async ({ receive }) => {
      await receive({
        serverContent: {
          inputTranscription: { text: "My project codename is solstice-42.", finished: true },
        },
      });
      await receive({
        serverContent: {
          outputTranscription: { text: "Got it, solstice-42." },
          turnComplete: true,
          interactionStatus: InteractionStatus.IDLE,
        },
      });
      await tracked.flush();
    });

    // Right after voice ends, loadChat() hydrates the voice turns with `source: 'voice'`.
    const afterVoice = loadChat(db, conversationId);
    expect(afterVoice.voiceInvoked).toBe(true);
    expect(afterVoice.model).toBe("models/gemini-3.8-live-extended-thinking");
    expect(afterVoice.turns.map((t) => ({ by: t.by, body: t.body, source: t.source }))).toEqual([
      { by: "user", body: "My project codename is solstice-42.", source: "voice" },
      { by: "agent", body: "Got it, solstice-42.", source: "voice" },
    ]);

    // Continue the SAME conversation in typed chat!
    const collector = new EventCollector();
    const unsubscribe = coordinator.subscribe(conversationId, collector.listener);
    await coordinator.send(conversationId, "What is my project codename?");
    const reply = await collector.waitFor(
      (e): e is Extract<ChatEvent, { type: "message" }> => e.type === "message",
    );
    expect(reply.body).toBe("Your project codename is solstice-42.");

    // Model saw the voice turns in its transcript ahead of the typed question.
    const modelInput = provider.parentCalls[0]!.filter((m) => m.role !== "system").map((m) => m.content);
    expect(modelInput).toEqual([
      "My project codename is solstice-42.",
      "Got it, solstice-42.",
      "What is my project codename?",
    ]);

    // Reloaded transcript keeps `source: 'voice'` on the voice turns and distinguishes typed turns.
    const afterTyped = loadChat(db, conversationId);
    expect(afterTyped.turns).toHaveLength(4);
    expect(afterTyped.turns[0]?.source).toBe("voice");
    expect(afterTyped.turns[1]?.source).toBe("voice");
    expect(afterTyped.turns[2]?.source).not.toBe("voice");
    expect(afterTyped.turns[3]?.source).not.toBe("voice");

    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// 3. Typed Chat -> Voice Handoff & Extended Thinking Reconnect (24-Turn Cap)
// ---------------------------------------------------------------------------

describe("Typed Chat -> Voice handoff and Extended Thinking reconnect", () => {
  test("GeminiLiveSession restores prior typed checkpoint turns on connect", async () => {
    const provider = new RoleRoutedProvider([
      say("Noted: flight is BA-215."),
      say("Terminal 5."),
    ]);
    const { coordinator } = await buildCoordinator({ provider });

    const collector = new EventCollector();
    const unsubscribe = coordinator.subscribe(conversationId, collector.listener);

    await coordinator.send(conversationId, "My flight is BA-215.");
    await collector.waitFor((e) => e.type === "message" && e.body === "Noted: flight is BA-215.");
    await coordinator.send(conversationId, "Which terminal?");
    await collector.waitFor((e) => e.type === "message" && e.body === "Terminal 5.");
    unsubscribe();

    // Verify history lives in checkpoints, not legacy `messages`.
    expect(
      db.select().from(s.messages).where(eq(s.messages.conversationId, conversationId)).all(),
    ).toHaveLength(0);

    await withMockedVoiceSession(coordinator, async ({ clientContents }) => {
      expect(clientContents).toHaveLength(1);
      expect(clientContents[0]).toEqual({
        turns: [
          { role: "user", parts: [{ text: "My flight is BA-215." }] },
          { role: "model", parts: [{ text: "Noted: flight is BA-215." }] },
          { role: "user", parts: [{ text: "Which terminal?" }] },
          { role: "model", parts: [{ text: "Terminal 5." }] },
        ],
        turnComplete: false,
      });
    });
  });

  test("caps restored checkpoint history to the most recent 24 turns", async () => {
    const store = new DrizzleCheckpointStore(db);
    const transcript: ChatMessage[] = [];
    const thread: Message[] = [];
    // Seed 30 turns (15 user + 15 assistant) directly into the checkpoint store.
    for (let i = 1; i <= 15; i++) {
      const uText = `Turn ${i * 2 - 1} user`;
      const aText = `Turn ${i * 2} assistant`;
      transcript.push({ role: "user", content: uText, origin: "operator", screened: true });
      transcript.push({ role: "assistant", content: aText, screened: true });
      thread.push({ id: `u-${i}`, role: "user", content: uText });
      thread.push({ id: `a-${i}`, role: "assistant", content: aText });
    }
    await store.save({
      sessionId: conversationId,
      status: "idle",
      kind: "turn_end",
      device: { id: "server-1", name: "solenoid-server" },
      transcript,
      thread,
    });

    const { coordinator } = await buildCoordinator({ provider: new RoleRoutedProvider([]) });

    await withMockedVoiceSession(coordinator, async ({ clientContents }) => {
      expect(clientContents).toHaveLength(1);
      const turns = clientContents[0]!.turns;
      expect(turns).toHaveLength(24);
      // Oldest 6 turns (1..6) trimmed; turns 7..30 restored in order.
      expect(turns[0]).toEqual({ role: "user", parts: [{ text: "Turn 7 user" }] });
      expect(turns.at(-1)).toEqual({ role: "model", parts: [{ text: "Turn 30 assistant" }] });
      expect(clientContents[0]!.turnComplete).toBe(false);
    });
  });

  test("Extended Thinking reconnect restores voice turns directly from checkpoint history", async () => {
    const { coordinator } = await buildCoordinator({ provider: new RoleRoutedProvider([]) });
    const tracked = instrumentAppendVoiceTurn(coordinator);

    await withMockedVoiceSession(coordinator, async ({ session, receive, clientContents, connections }) => {
      await receive({
        serverContent: {
          inputTranscription: { text: "Remember orchid-9.", finished: true },
        },
      });
      await receive({
        serverContent: {
          outputTranscription: { text: "Noted orchid-9." },
          turnComplete: true,
          interactionStatus: InteractionStatus.IDLE,
        },
      });
      await tracked.flush();
      expect(tracked.recorded.length).toBeGreaterThanOrEqual(1);

      // Toggle Extended Thinking off -> reconnects to standard model and replays checkpoint history.
      await session.setExtendedThinking(false);
      expect(connections).toHaveLength(2);
      expect(connections[1]!.model).toBe("models/gemini-3.8-live");
      await receive({ setupComplete: {} });

      expect(clientContents).toEqual([
        {
          turns: [
            { role: "user", parts: [{ text: "Remember orchid-9." }] },
            { role: "model", parts: [{ text: "Noted orchid-9." }] },
          ],
          turnComplete: false,
        },
      ]);
    });

    // Still zero legacy `messages` rows written.
    expect(
      db.select().from(s.messages).where(eq(s.messages.conversationId, conversationId)).all(),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Concurrency Guard: Voice Turn vs Background Subagent `onAutoTurn`
// ---------------------------------------------------------------------------

describe("voice + background subagent concurrency guard", () => {
  test("voice turn finishing while background subagent onAutoTurn runs serializes cleanly with monotonic checkpoint.seq and zero lost turns", async () => {
    const childGate = Promise.withResolvers<void>();
    const autoTurnEntered = Promise.withResolvers<void>();
    const releaseAutoTurn = Promise.withResolvers<void>();

    const pingRead = defineTool({
      name: "ping_read",
      kind: "read",
      description: "Read test status.",
      schema: z.object({}),
      execute: () => ({ status: "ok" }),
    });

    const provider = new RoleRoutedProvider(
      [
        // Turn 1: parent spawns background subagent and finishes immediately
        call("spawn_subagent", { name: "watcher", task: "Check status", tools: ["ping_read"] }, "tc-watch"),
        say("Watcher is checking in the background."),
        // Turn 2 (onAutoTurn): pauses mid-flight while voice turn finishes!
        async () => {
          autoTurnEntered.resolve();
          await releaseAutoTurn.promise;
          return say("Watcher finished: everything looks green.");
        },
      ],
      [
        async () => {
          await childGate.promise;
          return call("ping_read", {}, "tc-ping");
        },
        say("All systems green."),
      ],
    );

    const { coordinator, store } = await buildCoordinator({
      provider,
      tools: [pingRead],
      canSpawn: true,
    });
    const tracked = instrumentAppendVoiceTurn(coordinator);
    const collector = new EventCollector();
    const unsubscribe = coordinator.subscribe(conversationId, collector.listener);

    await withMockedVoiceSession(coordinator, async ({ receive }) => {
      // 1. Typed turn spawns background subagent and completes.
      await coordinator.send(conversationId, "Start watcher in background");
      await collector.waitFor(
        (e) => e.type === "message" && e.body === "Watcher is checking in the background.",
      );

      // 2. Release subagent and wait until parent's `onAutoTurn` is actively mid-flight!
      childGate.resolve();
      await autoTurnEntered.promise;

      // 3. While `onAutoTurn` is mid-flight, finish a spoken voice turn.
      //    Do NOT await `idlePromise` before releasing `releaseAutoTurn` (avoids deadlock if awaited).
      await receive({
        serverContent: {
          inputTranscription: { text: "Quick spoken check-in.", finished: true },
        },
      });
      const idlePromise = receive({
        serverContent: {
          outputTranscription: { text: "Voice reply recorded cleanly." },
          turnComplete: true,
          interactionStatus: InteractionStatus.IDLE,
        },
      });

      // Give appendVoiceTurn a tick to enqueue behind the active onAutoTurn, then release onAutoTurn.
      await Bun.sleep(15);
      releaseAutoTurn.resolve();

      await idlePromise;
      await collector.waitFor(
        (e) => e.type === "message" && e.body === "Watcher finished: everything looks green.",
      );
      await tracked.flush();
    });

    unsubscribe();

    // Verify strictly monotonic checkpoint.seq values (1, 2, 3, ...) with zero gaps or duplicates.
    const seqRows = db.$client
      .query<{ seq: number }, [string]>(
        `SELECT seq FROM chat_checkpoints WHERE session_id = ?1 ORDER BY seq ASC`,
      )
      .all(conversationId);
    expect(seqRows.length).toBeGreaterThanOrEqual(3);
    expect(seqRows.map((r) => r.seq)).toEqual(seqRows.map((_, i) => i + 1));

    // Zero lost turns: typed turn, subagent synthesis turn, AND voice turn all survive in checkpoint + loadChat!
    const loaded = await store.load(conversationId);
    expect(loaded).toBeDefined();
    const transcriptAll = loaded!.checkpoint.transcript.map((m) => m.content).join("\n");
    expect(transcriptAll).toContain("Start watcher in background");
    expect(transcriptAll).toContain("Watcher finished: everything looks green.");
    expect(transcriptAll).toContain("Quick spoken check-in.");
    expect(transcriptAll).toContain("Voice reply recorded cleanly.");

    const chat = loadChat(db, conversationId);
    const bodies = chat.turns.map((t) => t.body).join("\n");
    expect(bodies).toContain("Start watcher in background");
    expect(bodies).toContain("Watcher finished: everything looks green.");
    expect(bodies).toContain("Quick spoken check-in.");
    expect(bodies).toContain("Voice reply recorded cleanly.");
  });
});
