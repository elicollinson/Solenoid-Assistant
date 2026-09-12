import {
  GoogleGenAI,
  Modality,
  MediaResolution,
  ThinkingLevel,
  type FunctionDeclaration,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";
import type { Db } from "../db";
import { TOOL_GROUP_CATALOG, buildToolGroups, type ToolGroupContext } from "../tools/groups";
import { ToolBelt, loaderName } from "../core/toolGroups";
import { chatSystemPrompt } from "../prompts";
import { today } from "../agents/chat";
import { appendAgentMessage, appendUserMessage, markConversationVoiceInvoked } from "../db/mutations/chat";
import { displayArg, displayDuration, displayName, summarize } from "./turn";
import { log } from "../core/logger";
import { withConsent } from "../core/consent";
import { directConsent } from "../workflows/permissions";
import { newWriteCall, withWriteCall, recordWriteResponse } from "../core/writeExecution";

export interface WavConversionOptions {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
}

export function parseMimeType(mimeType: string): WavConversionOptions {
  const [fileType, ...params] = mimeType.split(";").map((s) => s.trim());
  const [, format] = (fileType ?? "").split("/");

  const options: WavConversionOptions = {
    numChannels: 1,
    sampleRate: 24000,
    bitsPerSample: 16,
  };

  if (format && format.startsWith("L")) {
    const bits = parseInt(format.slice(1), 10);
    if (!isNaN(bits)) {
      options.bitsPerSample = bits;
    }
  }

  for (const param of params) {
    const [key, value] = param.split("=").map((s) => s.trim());
    if (key === "rate" && value) {
      const rate = parseInt(value, 10);
      if (!isNaN(rate)) {
        options.sampleRate = rate;
      }
    }
  }

  return options;
}

export function createWavHeader(dataLength: number, options: WavConversionOptions): Buffer {
  const { numChannels, sampleRate, bitsPerSample } = options;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const buffer = Buffer.alloc(44);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLength, 40);

  return buffer;
}

export function convertToWav(rawData: string[], mimeType: string): Buffer {
  const options = parseMimeType(mimeType);
  const buffers = rawData.map((data) => Buffer.from(data, "base64"));
  const totalLength = buffers.reduce((acc, b) => acc + b.length, 0);
  const header = createWavHeader(totalLength, options);
  return Buffer.concat([header, ...buffers]);
}

export type GeminiLiveEvent =
  | { type: "ready"; model: string; conversationId: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "text"; text: string }
  | { type: "user_text"; text: string }
  | {
      type: "tool";
      name: string;
      kind: "read" | "write";
      arg: string | null;
      duration: string;
      ok: boolean;
    }
  | { type: "opened"; group: string }
  | { type: "interrupted" }
  | { type: "turn_complete"; agentText: string; toolSummary: string | null }
  | { type: "error"; message: string }
  | { type: "close"; reason?: string };

export interface GeminiLiveSessionOptions {
  db: Db;
  conversationId: string;
  config?: RuntimeConfig;
  onEvent: (event: GeminiLiveEvent) => void;
}

interface ExecutableTool {
  name: string;
  kind: "read" | "write";
  group?: string;
  isLoader?: boolean;
  execute: (args: unknown) => Promise<unknown>;
}

const ALLOWED_GEMINI_SCHEMA_KEYS = new Set([
  "default",
  "description",
  "enum",
  "example",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "nullable",
  "pattern",
  "properties",
  "propertyOrdering",
  "required",
  "title",
  "type",
]);

/**
 * Strips unsupported JSON Schema keywords (e.g. $schema, additionalProperties, exclusiveMinimum),
 * flattens anyOf unions, and normalizes schemas into the Gemini FunctionDeclaration Schema format.
 */
export function sanitizeGeminiSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) {
    return schema.map(sanitizeGeminiSchema);
  }

  const raw = schema as Record<string, unknown>;

  // 1. Flatten anyOf into a single schema
  if (Array.isArray(raw.anyOf)) {
    let isNullable = raw.nullable === true;
    const nonNullBranches: Array<Record<string, unknown>> = [];

    for (const branch of raw.anyOf) {
      if (branch && typeof branch === "object") {
        const b = branch as Record<string, unknown>;
        if (b.type === "null") {
          isNullable = true;
        } else {
          nonNullBranches.push(b);
        }
      }
    }

    if (nonNullBranches.length > 0) {
      const primary = nonNullBranches[0]!;
      const merged = { ...raw, ...primary };
      delete merged.anyOf;
      if (isNullable) merged.nullable = true;
      return sanitizeGeminiSchema(merged);
    }
  }

  const clean: Record<string, unknown> = {};

  // Convert exclusiveMinimum / exclusiveMaximum to standard minimum / maximum
  let minimum = typeof raw.minimum === "number" ? raw.minimum : undefined;
  if (typeof raw.exclusiveMinimum === "number") {
    if (raw.type === "integer" || raw.type === "INTEGER") {
      minimum = raw.exclusiveMinimum + 1;
    } else {
      minimum = raw.exclusiveMinimum;
    }
  }

  let maximum = typeof raw.maximum === "number" ? raw.maximum : undefined;
  if (typeof raw.exclusiveMaximum === "number") {
    if (raw.type === "integer" || raw.type === "INTEGER") {
      maximum = raw.exclusiveMaximum - 1;
    } else {
      maximum = raw.exclusiveMaximum;
    }
  }

  // Convert const: "val" to enum: ["val"] (only if non-empty string)
  let enumVals = Array.isArray(raw.enum) ? raw.enum : undefined;
  if (raw.const !== undefined && raw.const !== "" && raw.const !== null && !enumVals) {
    enumVals = [String(raw.const)];
  }

  // Filter out empty strings, whitespace-only strings, and nulls from enum
  if (enumVals) {
    enumVals = enumVals.map(String).filter((v) => v.trim().length > 0);
    if (enumVals.length === 0) enumVals = undefined;
  }

  for (const [key, value] of Object.entries(raw)) {
    if (
      key === "$schema" ||
      key === "additionalProperties" ||
      key === "exclusiveMinimum" ||
      key === "exclusiveMaximum" ||
      key === "const" ||
      key === "anyOf"
    ) {
      continue;
    }

    if (!ALLOWED_GEMINI_SCHEMA_KEYS.has(key)) {
      continue;
    }

    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const cleanProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        cleanProps[propName] = sanitizeGeminiSchema(propSchema);
      }
      clean.properties = cleanProps;
    } else if (key === "items") {
      clean.items = sanitizeGeminiSchema(value);
    } else {
      clean[key] = value;
    }
  }

  if (minimum !== undefined) clean.minimum = minimum;
  if (maximum !== undefined) clean.maximum = maximum;
  if (enumVals !== undefined) clean.enum = enumVals;

  if (typeof clean.type === "string") {
    clean.type = clean.type.toUpperCase();
  }

  // If format is date-time, remove lengthy ECMAScript regex patterns
  if (clean.format === "date-time") {
    delete clean.pattern;
  }

  return clean;
}

export class GeminiLiveSession {
  private readonly db: Db;
  private readonly conversationId: string;
  private readonly config: RuntimeConfig;
  private readonly onEvent: (event: GeminiLiveEvent) => void;
  private session?: Session;
  private closed = false;
  private readonly toolsByName = new Map<string, ExecutableTool>();
  private readonly declarations: FunctionDeclaration[] = [];
  private currentTurnText = "";
  private currentTurnCalls: Array<{ name: string }> = [];
  private openedGroups = new Set<string>();

  constructor(options: GeminiLiveSessionOptions) {
    this.db = options.db;
    this.conversationId = options.conversationId;
    this.config = options.config ?? loadRuntimeConfig();
    this.onEvent = options.onEvent;

    this.initTools();
  }

  private initTools(): void {
    const context: ToolGroupContext = { db: this.db };
    const groups = buildToolGroups(context, Object.keys(TOOL_GROUP_CATALOG), { trust: "full" });
    const belt = new ToolBelt(groups);

    // 1. Group loaders
    for (const group of groups) {
      const loader = loaderName(group.name);
      this.toolsByName.set(loader, {
        name: loader,
        kind: "read",
        group: group.name,
        isLoader: true,
        execute: async () => belt.briefingFor(group.name),
      });

      this.declarations.push({
        name: loader,
        description: `Load schema, tools and instructions for the ${group.name} group: ${group.summary}`,
        parameters: {
          type: "OBJECT",
          properties: {},
        } as unknown as FunctionDeclaration["parameters"],
      });

      // 2. Member tools in this group
      for (const tool of group.tools) {
        const func = tool.definition.function;
        this.toolsByName.set(func.name, {
          name: func.name,
          kind: tool.kind,
          group: group.name,
          execute: async (args: unknown) => tool.execute(args as never),
        });

        this.declarations.push({
          name: func.name,
          description: func.description,
          parameters: sanitizeGeminiSchema(func.parameters) as unknown as FunctionDeclaration["parameters"],
        });
      }
    }
  }

  async start(): Promise<void> {
    const apiKey = this.config.gemini.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not set in environment or config");
    }

    const ai = new GoogleGenAI({ apiKey });
    const model = this.config.gemini.liveModel || "models/gemini-3.1-flash-live-preview";

    const datedPrompt = `${chatSystemPrompt()}\n\n${today()}`;

    // Mark conversation as voice-invoked in the DB
    markConversationVoiceInvoked(this.db, this.conversationId, model);

    const liveConfig = {
      responseModalities: [Modality.AUDIO],
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.MINIMAL,
      },
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: this.config.gemini.voice || "Sulafat",
          },
        },
      },
      contextWindowCompression: {
        triggerTokens: "104857",
        slidingWindow: { targetTokens: "52428" },
      },
      systemInstruction: {
        parts: [{ text: datedPrompt }],
      },
      tools: [
        { functionDeclarations: this.declarations },
        { googleSearch: {} },
      ],
    };

    try {
      this.session = await ai.live.connect({
        model,
        callbacks: {
          onopen: () => {
            log.info("Gemini Live connection opened", { conversationId: this.conversationId });
            this.onEvent({ type: "ready", model, conversationId: this.conversationId });
          },
          onmessage: async (message: LiveServerMessage) => {
            await this.handleMessage(message);
          },
          onerror: (e: ErrorEvent) => {
            log.warn("Gemini Live connection error", { error: e.message });
            this.onEvent({ type: "error", message: e.message });
          },
          onclose: (e: CloseEvent) => {
            log.info("Gemini Live connection closed", { reason: e.reason });
            this.onEvent({ type: "close", reason: e.reason });
          },
        },
        config: liveConfig,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Failed to connect to Gemini Live", { error: msg });
      this.onEvent({ type: "error", message: msg });
      throw err;
    }
  }

  private async handleMessage(message: LiveServerMessage): Promise<void> {
    // 1. Tool calls
    if (message.toolCall?.functionCalls && this.session) {
      for (const call of message.toolCall.functionCalls) {
        if (!call.id || !call.name) continue;
        const tool = this.toolsByName.get(call.name);
        const started = performance.now();
        const audit = newWriteCall({ origin: "voice", actor: "agent", deferResponse: true });
        let result: unknown;
        let ok = true;

        if (tool?.isLoader && tool.group) {
          this.openedGroups.add(tool.group);
          this.onEvent({ type: "opened", group: tool.group });
        }

        try {
          if (!tool) {
            result = { error: `Tool "${call.name}" is not registered` };
            ok = false;
          } else {
            result = await withConsent(directConsent({ db: this.db, slug: "voice" }),
              () => withWriteCall(audit, () => tool.execute(call.args)));
          }
        } catch (err) {
          ok = false;
          result = { error: err instanceof Error ? err.message : String(err) };
        }

        const elapsed = performance.now() - started;

        if (!tool?.isLoader) {
          this.currentTurnCalls.push({ name: call.name });
          this.onEvent({
            type: "tool",
            name: displayName(call.name),
            kind: tool?.kind ?? "read",
            arg: displayArg(call.args),
            duration: displayDuration(elapsed),
            ok,
          });
        }

        try {
          this.session.sendToolResponse({
            functionResponses: [
              {
                id: call.id,
                name: call.name,
                response: typeof result === "object" && result !== null ? (result as Record<string, unknown>) : { output: String(result) },
              },
            ],
          });
          if (tool?.kind === "write") recordWriteResponse(audit, "delivered");
        } catch (err) {
          if (tool?.kind === "write") recordWriteResponse(audit, "failed");
          log.warn("Failed to send tool response to Gemini Live", {
            tool: call.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 2. Server content / Audio / Text
    if (message.serverContent?.modelTurn?.parts) {
      for (const part of message.serverContent.modelTurn.parts) {
        if (part.inlineData?.data) {
          this.onEvent({
            type: "audio",
            data: part.inlineData.data,
            mimeType: part.inlineData.mimeType ?? "audio/pcm;rate=24000",
          });
        }
        if (part.text) {
          this.currentTurnText += part.text;
          this.onEvent({ type: "text", text: part.text });
        }
      }
    }

    // 3. User interruption signal
    if (message.serverContent?.interrupted) {
      this.onEvent({ type: "interrupted" });
    }

    // 4. Turn complete
    if (message.serverContent?.turnComplete) {
      const body = this.currentTurnText.trim();
      const toolSummary = summarize(this.currentTurnCalls);
      const note = this.openedGroups.size ? `opened ${[...this.openedGroups].join(", ")}` : null;

      if (body || this.currentTurnCalls.length) {
        try {
          appendAgentMessage(this.db, this.conversationId, body || "(Voice response)", { toolSummary, note }, new Date());
        } catch (err) {
          log.warn("Failed to persist Gemini Live turn", { error: err instanceof Error ? err.message : String(err) });
        }
      }

      this.onEvent({
        type: "turn_complete",
        agentText: body,
        toolSummary,
      });

      // Reset turn accumulator
      this.currentTurnText = "";
      this.currentTurnCalls = [];
      this.openedGroups.clear();
    }
  }

  sendAudio(base64Pcm: string): void {
    if (this.closed || !this.session) return;
    try {
      this.session.sendRealtimeInput({
        audio: {
          mimeType: "audio/pcm;rate=16000",
          data: base64Pcm,
        },
      });
    } catch (err) {
      log.warn("Failed to send audio chunk to Gemini Live", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  sendText(text: string): void {
    if (this.closed || !this.session) return;
    try {
      appendUserMessage(this.db, this.conversationId, text, new Date());
      this.onEvent({ type: "user_text", text });
      this.session.sendClientContent({
        turns: [
          {
            role: "user",
            parts: [{ text }],
          },
        ],
        turnComplete: true,
      });
    } catch (err) {
      log.warn("Failed to send text to Gemini Live", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session?.close();
    } catch {
      // Ignored
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
