import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Behavior, InteractionStatus, ThinkingLevel, Live, LiveServerMessage, type LiveServerContent, type LiveConnectParameters, type Session } from "@google/genai";
import { loadRuntimeConfig } from "../core/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GeminiLiveSession,
  convertToWav,
  createWavHeader,
  parseMimeType,
  sanitizeGeminiSchema,
  type GeminiLiveEvent,
} from "./geminiLive";
import { createDb, runMigrations, type Db } from "../db";
import { loadChat } from "../db/queries/chat";
import { markConversationVoiceInvoked, startConversation } from "../db/mutations/chat";

let dir: string;
let db: Db;
let conversationId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gemini-live-test-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  conversationId = startConversation(db);
});

describe("Gemini 3.8 Live protocol", () => {
  test("connects with high thinking and persists spoken transcripts without model thoughts", async () => {
    let connection!: LiveConnectParameters;
    const events: GeminiLiveEvent[] = [];
    const connect = spyOn(Live.prototype, "connect").mockImplementation(async (params) => {
      connection = params;
      return { close() {} } as Session;
    });
    const session = new GeminiLiveSession({
      db,
      conversationId,
      config: loadRuntimeConfig({ GEMINI_API_KEY: "test-only" }),
      onEvent: (event) => events.push(event),
    });
    try {
      await session.start();
      const receive = (serverContent: LiveServerContent) =>
        connection.callbacks.onmessage(Object.assign(new LiveServerMessage(), { serverContent }));
      expect(connection.model).toBe("models/gemini-3.8-live-extended-thinking");
      expect(connection.config?.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.HIGH });
      expect(connection.config?.outputAudioTranscription).toEqual({});
      const tools = connection.config?.tools as Array<{ functionDeclarations?: Array<{ behavior?: Behavior }> }>;
      const declarations = tools.flatMap((tool) => tool.functionDeclarations ?? []);
      expect(declarations.length).toBeGreaterThan(50);
      expect(declarations.every((tool) => tool.behavior === Behavior.NON_BLOCKING)).toBe(true);
      expect(loadChat(db, conversationId).model).toBe(connection.model);

      await receive({
        modelTurn: { parts: [
          { text: "Internal reasoning", thought: true },
          { text: "Duplicate model text" },
          { inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } },
        ] },
        outputTranscription: { text: "Your next " },
      });
      await receive({
        outputTranscription: { text: "meeting is at noon.", finished: true },
        turnComplete: true,
        interactionStatus: InteractionStatus.IDLE,
      });
      expect(loadChat(db, conversationId).turns.map((turn) => turn.body)).toEqual([
        "Your next meeting is at noon.",
      ]);
      expect(events).toContainEqual({ type: "audio", data: "AAAA", mimeType: "audio/pcm;rate=24000" });

      // An interrupted turn is saved once and cannot bleed into the next answer.
      await receive({
        outputTranscription: { text: "I can also" },
        interrupted: true,
        turnComplete: true,
        interactionStatus: InteractionStatus.IDLE,
      });
      await receive({
        outputTranscription: { text: "Okay, stopping." },
        turnComplete: true,
        interactionStatus: InteractionStatus.IDLE,
      });
      expect(events).toContainEqual({ type: "interrupted" });
      expect(loadChat(db, conversationId).turns.map((turn) => turn.body)).toEqual([
        "Your next meeting is at noon.", "I can also", "Okay, stopping.",
      ]);
    } finally {
      session.close();
      connect.mockRestore();
    }
  });
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

async function withLiveHarness(
  run: (h: {
    session: GeminiLiveSession;
    connection: LiveConnectParameters;
    events: GeminiLiveEvent[];
    responses: unknown[];
    receive: (message: Partial<LiveServerMessage>) => Promise<void>;
    addTool: (execute: () => Promise<unknown>) => void;
  }) => Promise<void>,
  env: Record<string, string> = {},
) {
  let connection!: LiveConnectParameters;
  const events: GeminiLiveEvent[] = [];
  const responses: unknown[] = [];
  const connect = spyOn(Live.prototype, "connect").mockImplementation(async (params) => {
    connection = params;
    return { close() {}, sendToolResponse: (response: unknown) => responses.push(response) } as unknown as Session;
  });
  const session = new GeminiLiveSession({ db, conversationId,
    config: loadRuntimeConfig({ GEMINI_API_KEY: "test-only", ...env }), onEvent: (event) => events.push(event) });
  try {
    await session.start();
    await run({ session, connection, events, responses,
      receive: async (message) => { await connection.callbacks.onmessage(Object.assign(new LiveServerMessage(), message)); },
      addTool: (execute) => {
        const tools = (session as unknown as { toolsByName: Map<string, unknown> }).toolsByName;
        tools.set("test_lookup", { name: "test_lookup", kind: "read", execute });
      },
    });
  } finally {
    session.close();
    connect.mockRestore();
  }
}

test("keeps audio responsive while tools run and completes only at server IDLE", async () => {
  await withLiveHarness(async ({ session, receive, addTool, responses, events }) => {
    let resolveTool!: (value: unknown) => void;
    addTool(() => new Promise((resolve) => { resolveTool = resolve; }));
    await receive({ toolCall: { functionCalls: [{ id: "lookup-1", name: "test_lookup", args: {} }] },
      serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAA" } }] },
        outputTranscription: { text: "Checking that." }, turnComplete: true,
        interactionStatus: InteractionStatus.IN_PROGRESS } });
    expect(events.some((event) => event.type === "audio")).toBe(true);
    expect(events).toContainEqual({ type: "audio_turn_complete" });
    expect(events).toContainEqual({ type: "interaction_status", working: true });
    expect(loadChat(db, conversationId).turns).toHaveLength(0);
    expect(responses).toHaveLength(0);
    // Even an early IDLE must not finalize while a local tool is unfinished.
    await receive({ serverContent: { interactionStatus: InteractionStatus.IDLE } });
    expect(loadChat(db, conversationId).turns).toHaveLength(0);
    resolveTool({ answer: "noon" });
    await Promise.resolve();
    expect(responses).toEqual([{ functionResponses: [{ id: "lookup-1", name: "test_lookup", response: { answer: "noon" } }] }]);
    await receive({ serverContent: { outputTranscription: { text: "It is at noon." }, turnComplete: true,
      interactionStatus: InteractionStatus.IN_PROGRESS } });
    expect(loadChat(db, conversationId).turns).toHaveLength(0);
    await receive({ serverContent: { interactionStatus: InteractionStatus.IDLE } });
    await receive({ serverContent: { interactionStatus: InteractionStatus.IDLE } });
    session.close(); // Closing an already-persisted interaction must not duplicate it.
    const turns = loadChat(db, conversationId).turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]!.body).toBe("Checking that.\nIt is at noon.");
    expect(turns[0]!.toolSummary).toContain("lookup");
    expect(events.filter((event) => event.type === "turn_complete")).toHaveLength(1);
  });
});

for (const closeVia of ["stop", "disconnect"] as const) {
  test(`preserves partial speech and completed tool summaries on ${closeVia}`, async () => {
    await withLiveHarness(async ({ session, connection, receive, addTool, responses, events }) => {
      addTool(async () => ({ answer: "noon" }));
      await receive({ toolCall: { functionCalls: [{ id: "completed", name: "test_lookup" }] } });
      await Promise.resolve();
      expect(responses).toHaveLength(1);

      let resolvePending!: (value: unknown) => void;
      addTool(() => new Promise((resolve) => { resolvePending = resolve; }));
      await receive({ toolCall: { functionCalls: [{ id: "pending", name: "test_lookup" }] },
        serverContent: { outputTranscription: { text: "Your meeting is at noon. Checking the location." },
          turnComplete: true, interactionStatus: InteractionStatus.IN_PROGRESS } });
      expect(loadChat(db, conversationId).turns).toHaveLength(0);

      if (closeVia === "stop") session.close();
      else connection.callbacks.onclose?.({ reason: "Connection lost" } as CloseEvent);
      session.close(); // A later socket callback/cleanup must be harmless.
      resolvePending({ answer: "late result" });
      await Promise.resolve();
      await receive({ serverContent: { outputTranscription: { text: "Late speech" }, interactionStatus: InteractionStatus.IDLE } });

      const turns = loadChat(db, conversationId).turns;
      expect(turns).toHaveLength(1);
      expect(turns[0]!.body).toBe("Your meeting is at noon. Checking the location.");
      expect(turns[0]!.toolSummary).toBe("1 tool call · test.lookup");
      expect(responses).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn_complete")).toHaveLength(1);
    });
  });
}

test("closing an empty voice session does not create a transcript", async () => {
  await withLiveHarness(async ({ session, events }) => {
    session.close();
    expect(loadChat(db, conversationId).turns).toHaveLength(0);
    expect(events.filter((event) => event.type === "turn_complete")).toHaveLength(0);
  });
});

for (const stop of ["cancel", "close"] as const) {
  test(`does not deliver stale tool results after ${stop}`, async () => {
    await withLiveHarness(async ({ session, receive, addTool, responses, events }) => {
      let resolveTool!: (value: unknown) => void;
      addTool(() => new Promise((resolve) => { resolveTool = resolve; }));
      await receive({ toolCall: { functionCalls: [{ id: "lookup-1", name: "test_lookup" }] } });
      if (stop === "close") session.close();
      else await receive({ toolCallCancellation: { ids: ["lookup-1"] } });
      resolveTool({ answer: "obsolete" });
      await Promise.resolve();
      expect(responses).toHaveLength(0);
      expect(events.filter((event) => event.type === "tool")).toHaveLength(0);
    });
  });
}

test("standard 3.8 override omits thinking and retains blocking tool behavior", async () => {
  await withLiveHarness(async ({ connection, receive }) => {
    expect(connection.config).not.toHaveProperty("thinkingConfig");
    const tools = connection.config?.tools as Array<{ functionDeclarations?: Array<{ behavior?: Behavior }> }>;
    expect(tools.flatMap((tool) => tool.functionDeclarations ?? []).every((tool) => tool.behavior === Behavior.BLOCKING)).toBe(true);
    await receive({ serverContent: { outputTranscription: { text: "Hello." }, turnComplete: true } });
    expect(loadChat(db, conversationId).turns[0]!.body).toBe("Hello.");
  }, { GEMINI_LIVE_MODEL: "models/gemini-3.8-live" });
});

describe("WAV & MIME helpers", () => {
  test("parseMimeType parses standard Gemini Live audio formats", () => {
    const parsed16k = parseMimeType("audio/pcm;rate=16000");
    expect(parsed16k).toEqual({
      numChannels: 1,
      sampleRate: 16000,
      bitsPerSample: 16,
    });

    const parsed24k = parseMimeType("audio/pcm;rate=24000");
    expect(parsed24k).toEqual({
      numChannels: 1,
      sampleRate: 24000,
      bitsPerSample: 16,
    });

    const parsedL16 = parseMimeType("audio/L16;rate=8000");
    expect(parsedL16).toEqual({
      numChannels: 1,
      sampleRate: 8000,
      bitsPerSample: 16,
    });
  });

  test("createWavHeader produces valid 44-byte RIFF/WAVE header", () => {
    const options = { numChannels: 1, sampleRate: 24000, bitsPerSample: 16 };
    const dataLength = 4800; // 100ms of 24kHz 16-bit mono
    const header = createWavHeader(dataLength, options);

    expect(header.length).toBe(44);
    expect(header.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(header.readUInt32LE(4)).toBe(36 + dataLength);
    expect(header.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(header.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(header.readUInt16LE(20)).toBe(1); // PCM
    expect(header.readUInt16LE(22)).toBe(1); // 1 channel
    expect(header.readUInt32LE(24)).toBe(24000); // 24kHz
    expect(header.subarray(36, 40).toString("ascii")).toBe("data");
    expect(header.readUInt32LE(40)).toBe(dataLength);
  });

  test("convertToWav merges PCM base64 chunks with header", () => {
    // 4 bytes of dummy PCM data in base64: [0x00, 0x01, 0x02, 0x03]
    const chunk = Buffer.from([0x00, 0x01, 0x02, 0x03]).toString("base64");
    const wav = convertToWav([chunk, chunk], "audio/pcm;rate=24000");

    expect(wav.length).toBe(44 + 8);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.readUInt32LE(40)).toBe(8);
  });
});

describe("sanitizeGeminiSchema", () => {
  test("strips unsupported keywords and normalizes types and ranges", () => {
    const input = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          exclusiveMinimum: 0,
          maximum: 100,
        },
        action: {
          type: "string",
          const: "publish",
        },
      },
      required: ["action"],
    };

    const sanitized = sanitizeGeminiSchema(input) as Record<string, unknown>;

    expect(sanitized).not.toHaveProperty("$schema");
    expect(sanitized).not.toHaveProperty("additionalProperties");
    expect(sanitized.type).toBe("OBJECT");

    const props = sanitized.properties as Record<string, Record<string, unknown>>;
    expect(props.limit).not.toHaveProperty("exclusiveMinimum");
    expect(props.limit!.minimum).toBe(1);
    expect(props.limit!.maximum).toBe(100);
    expect(props.limit!.type).toBe("INTEGER");

    expect(props.action).not.toHaveProperty("const");
    expect(props.action!.enum).toEqual(["publish"]);
  });

  test("flattens anyOf unions and prevents empty string enums (such as clearable dueAt)", () => {
    const input = {
      type: "object",
      properties: {
        dueAt: {
          anyOf: [
            {
              type: "string",
              format: "date-time",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
              description: "An ISO 8601 instant",
            },
            {
              type: "string",
              const: "",
            },
          ],
        },
        staleAfter: {
          anyOf: [
            { type: "string" },
            { type: "null" },
          ],
        },
      },
    };

    const sanitized = sanitizeGeminiSchema(input) as Record<string, unknown>;
    const props = sanitized.properties as Record<string, Record<string, unknown>>;

    expect(props.dueAt).not.toHaveProperty("anyOf");
    expect(props.dueAt!.type).toBe("STRING");
    expect(props.dueAt!.format).toBe("date-time");
    expect(props.dueAt).not.toHaveProperty("pattern");
    expect(props.dueAt).not.toHaveProperty("enum");

    expect(props.staleAfter).not.toHaveProperty("anyOf");
    expect(props.staleAfter!.type).toBe("STRING");
    expect(props.staleAfter!.nullable).toBe(true);
  });
});

describe("GeminiLiveSession tool initialization", () => {
  test("registers all tools and strips incompatible keywords from all schemas", () => {
    const session = new GeminiLiveSession({
      db,
      conversationId,
      onEvent: () => {},
    });

    // Access private declarations for testing
    const decls = (session as unknown as { declarations: Array<{ name: string; parameters?: Record<string, unknown> }> }).declarations;
    expect(decls.length).toBeGreaterThan(50);

    // Verify loaders are present
    const loaders = decls.filter((d) => d.name.startsWith("get_") && d.name.endsWith("_tools"));
    expect(loaders.length).toBeGreaterThanOrEqual(10);

    // Recursively check all parameters for forbidden keys
    function assertNoForbiddenKeys(obj: unknown) {
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
      const rec = obj as Record<string, unknown>;
      expect(rec).not.toHaveProperty("$schema");
      expect(rec).not.toHaveProperty("additionalProperties");
      expect(rec).not.toHaveProperty("exclusiveMinimum");
      expect(rec).not.toHaveProperty("exclusiveMaximum");
      expect(rec).not.toHaveProperty("anyOf");

      if (Array.isArray(rec.enum)) {
        for (const item of rec.enum) {
          expect(typeof item).toBe("string");
          expect(item.trim().length).toBeGreaterThan(0);
        }
      }

      if (rec.properties && typeof rec.properties === "object") {
        for (const child of Object.values(rec.properties)) {
          assertNoForbiddenKeys(child);
        }
      }
      if (rec.items && typeof rec.items === "object") {
        assertNoForbiddenKeys(rec.items);
      }
    }

    for (const decl of decls) {
      if (decl.parameters) {
        assertNoForbiddenKeys(decl.parameters);
      }
    }
  });

  test("tracks conversation voice invocation in database", () => {
    markConversationVoiceInvoked(db, conversationId, "models/gemini-3.8-live-extended-thinking");

    const chat = loadChat(db, conversationId);
    expect(chat.voiceInvoked).toBe(true);
    expect(chat.model).toBe("models/gemini-3.8-live-extended-thinking");
  });
});
