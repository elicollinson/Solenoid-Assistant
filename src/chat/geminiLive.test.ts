import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GeminiLiveSession,
  convertToWav,
  createWavHeader,
  parseMimeType,
  sanitizeGeminiSchema,
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

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
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
    markConversationVoiceInvoked(db, conversationId, "models/gemini-3.1-flash-live-preview");

    const chat = loadChat(db, conversationId);
    expect(chat.voiceInvoked).toBe(true);
    expect(chat.model).toBe("models/gemini-3.1-flash-live-preview");
  });
});
