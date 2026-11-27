import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRunError,
  OpenAICompatibleProvider,
  ProviderStalledError,
} from "@elicollinson/solenoid-engine";
import {
  TraceFlags,
  trace,
  type Attributes,
  type Context,
  type Exception,
  type HrTime,
  type Link,
  type Span,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  type TimeInput,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";
import OpenAI from "openai";
import sharp from "sharp";
import { z } from "zod";
import { privateSourceContext } from "../core/privateSourceContext";
import { initDb, type Db } from "../db";
import { assetPath, candidate, stagePhoto } from "../sources/assets";
import { consumeScreenshot, modelUnavailable } from "../sources/consumer";
import { digest } from "../sources/store";
import { describeImage } from "./vision";
import { visionImage } from "./visionImage";

const descriptionSchema = z.object({
  app: z.string(),
  summary: z.string(),
  prominentText: z.array(z.string()),
});

type Description = z.infer<typeof descriptionSchema>;

interface RecordedSpan {
  tracerName: string;
  name: string;
  attributes: Record<string, unknown>;
  events: Array<{ name: string; attributes?: Record<string, unknown> }>;
  ended: boolean;
}

class RecordingTracerProvider implements TracerProvider {
  readonly spans: RecordedSpan[] = [];
  private seq = 0;

  getTracer(name: string): Tracer {
    const startSpan = (spanName: string, options?: SpanOptions): Span => {
      const id = ++this.seq;
      const recorded: RecordedSpan = {
        tracerName: name,
        name: spanName,
        attributes: { ...(options?.attributes as Record<string, unknown> | undefined) },
        events: [],
        ended: false,
      };
      this.spans.push(recorded);

      const ctx: SpanContext = {
        traceId: String(id).padStart(32, "0"),
        spanId: String(id).padStart(16, "0"),
        traceFlags: TraceFlags.SAMPLED,
      };

      const span: Span = {
        spanContext: () => ctx,
        setAttribute(key: string, value: unknown) {
          recorded.attributes[key] = value;
          return span;
        },
        setAttributes(attributes: Attributes) {
          Object.assign(recorded.attributes, attributes);
          return span;
        },
        addEvent(eventName: string, attributesOrStartTime?: Attributes | TimeInput) {
          const attrs =
            attributesOrStartTime &&
            typeof attributesOrStartTime === "object" &&
            !Array.isArray(attributesOrStartTime) &&
            !(attributesOrStartTime instanceof Date)
              ? (attributesOrStartTime as Record<string, unknown>)
              : undefined;
          recorded.events.push({ name: eventName, ...(attrs ? { attributes: attrs } : {}) });
          return span;
        },
        addLink(_link: Link) {
          return span;
        },
        addLinks(_links: Link[]) {
          return span;
        },
        setStatus(_status: SpanStatus) {
          return span;
        },
        updateName(newName: string) {
          recorded.name = newName;
          return span;
        },
        end(_endTime?: HrTime | number | Date) {
          recorded.ended = true;
        },
        isRecording: () => true,
        recordException(_exception: Exception, _time?: TimeInput) {},
      };
      return span;
    };

    const tracer: Tracer = {
      startSpan,
      startActiveSpan<F extends (span: Span) => unknown>(
        spanName: string,
        optionsOrFn: SpanOptions | F,
        contextOrFn?: Context | F,
        maybeFn?: F,
      ): ReturnType<F> {
        const fn =
          typeof optionsOrFn === "function"
            ? optionsOrFn
            : typeof contextOrFn === "function"
              ? contextOrFn
              : maybeFn!;
        const options = typeof optionsOrFn === "function" ? undefined : optionsOrFn;
        const span = startSpan(spanName, options);
        return fn(span) as ReturnType<F>;
      },
    };
    return tracer;
  }

  clear(): void {
    this.spans.length = 0;
  }
}

/** Build an SSE Response streaming a single `submit_result` tool call (OpenAI Chat Completions wire format). */
function sseSubmitResultResponse(payload: unknown): Response {
  const argsJson = JSON.stringify(payload);
  const chunks = [
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "vision-test",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_submit_1",
                type: "function",
                function: { name: "submit_result", arguments: argsJson },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "vision-test",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    },
  ];
  const sseBody = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(sseBody, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

interface CapturedWireRequest {
  url: string;
  body: Record<string, unknown>;
}

function createOfflineOpenAIProvider(
  dialect: "omlx" | "openrouter",
  result: Description,
  captured: CapturedWireRequest[],
): OpenAICompatibleProvider {
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    captured.push({ url, body });
    return sseSubmitResultResponse(result);
  }) as typeof fetch;

  const client = new OpenAI({
    baseURL: dialect === "omlx" ? "http://omlx.offline.test/v1" : "http://openrouter.offline.test/v1",
    apiKey: "test-key",
    maxRetries: 0,
    fetch: mockFetch,
  });
  return new OpenAICompatibleProvider(
    client as unknown as ConstructorParameters<typeof OpenAICompatibleProvider>[0],
    dialect,
  );
}

const ENV_KEYS = [
  "LLM_PROVIDER",
  "LLM_ROUTES",
  "MODEL",
  "IMAGE_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OMLX_BASE_URL",
  "OMLX_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "MODEL_ARMOR_ENABLED",
  "SOURCE_ASSET_DIR",
  "SOURCE_STAGING_DIR",
] as const;

let tempDir: string;
let imagePath: string;
let pngBytes: Buffer;
let savedEnv: Record<string, string | undefined>;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "vision-test-"));
  pngBytes = await sharp({
    create: { width: 24, height: 24, channels: 3, background: "#1e5aa0" },
  })
    .png()
    .toBuffer();
  imagePath = join(tempDir, "screenshot.png");
  await writeFile(imagePath, pngBytes);

  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.MODEL_ARMOR_ENABLED = "false";
});

afterEach(async () => {
  trace.disable();
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe("vision.ts engine migration cleanliness", () => {
  test("vision.ts uses @elicollinson/solenoid-engine with zero Ollama or Anthropic SDK usage", () => {
    const source = readFileSync(join(import.meta.dir, "vision.ts"), "utf8");
    expect(source).toContain("@elicollinson/solenoid-engine");
    expect(source).not.toMatch(/from\s+["']ollama["']/);
    expect(source).not.toMatch(/from\s+["']@anthropic-ai\/sdk["']/);
    expect(source).not.toMatch(/from\s+["']\.\.\/core\/ollama["']/);
    expect(source).not.toMatch(/from\s+["']\.\.\/core\/rawAgent["']/);
    expect(source).not.toMatch(/from\s+["']\.\.\/core\/providers["']/);
    expect(source).not.toContain("OllamaProvider");
    expect(source).not.toContain("createOllamaClient");
    expect(source).not.toContain("structuredOutputStrategy");
    expect(source).not.toContain("two-stage");
  });
});

describe("describeImage via solenoid-engine multimodal Agent & OpenAICompatibleProvider", () => {
  test("routes multimodal image payloads through OpenAICompatibleProvider on oMLX and OpenRouter", async () => {
    const expected: Description = {
      app: "Kindle",
      summary: "A book page discussing consensus algorithms",
      prominentText: ["Designing Data-Intensive Applications", "Chapter 9"],
    };

    for (const dialect of ["omlx", "openrouter"] as const) {
      const captured: CapturedWireRequest[] = [];
      const provider = createOfflineOpenAIProvider(dialect, expected, captured);
      const modelName = dialect === "omlx" ? "mlx-community/Qwen2.5-VL-7B" : "google/gemma-4-26b-a4b-it";

      const result = await describeImage(
        imagePath,
        "Describe this screenshot",
        descriptionSchema,
        { routes: [{ client: provider, model: modelName }] },
      );

      expect(result).toEqual(expected);
      expect(captured).toHaveLength(1);

      const req = captured[0]!.body;
      expect(req.model).toBe(modelName);
      expect(req.stream).toBe(true);
      expect(req.response_format).toBeUndefined();

      const tools = req.tools as Array<{ function?: { name?: string } }> | undefined;
      expect(tools?.some((t) => t.function?.name === "submit_result")).toBe(true);

      const messages = req.messages as Array<{ role: string; content: unknown }>;
      const userMessage = messages.find((m) => m.role === "user");
      expect(userMessage).toBeDefined();
      expect(Array.isArray(userMessage!.content)).toBe(true);

      const parts = userMessage!.content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      expect(parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "Describe this screenshot" }),
          expect.objectContaining({
            type: "image_url",
            image_url: { url: expect.stringMatching(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/) },
          }),
        ]),
      );
    }
  });

  test("falls back to OpenRouter when primary oMLX route stalls while preserving image parts", async () => {
    const expected: Description = {
      app: "Apple Books",
      summary: "Cover page for Dune",
      prominentText: ["DUNE", "Frank Herbert"],
    };
    const stallingProvider = {
      providerName: "omlx",
      async chat(): Promise<never> {
        throw new ProviderStalledError("first_byte", 300_000, "omlx");
      },
    };
    const captured: CapturedWireRequest[] = [];
    const fallbackProvider = createOfflineOpenAIProvider("openrouter", expected, captured);

    const result = await describeImage(imagePath, "Identify the media", descriptionSchema, {
      routes: [
        { client: stallingProvider, model: "mlx-community/Qwen2.5-VL-7B" },
        { client: fallbackProvider, model: "google/gemma-4-26b-a4b-it" },
      ],
    });

    expect(result).toEqual(expected);
    expect(captured).toHaveLength(1);
    const messages = captured[0]!.body.messages as Array<{ role: string; content: unknown }>;
    const userMessage = messages.find((m) => m.role === "user");
    expect(Array.isArray(userMessage?.content)).toBe(true);
    const parts = userMessage!.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.some((p) => p.type === "image_url" && p.image_url?.url.startsWith("data:image/"))).toBe(true);
  });

  test("honors IMAGE_MODEL route override when no explicit routes are supplied", async () => {
    const expected: Description = {
      app: "Letterboxd",
      summary: "Movie detail screen",
      prominentText: ["Arrival", "2016"],
    };
    const captured: CapturedWireRequest[] = [];

    process.env.LLM_ROUTES = JSON.stringify([
      { provider: "omlx", model: "mlx-community/text-only-default" },
    ]);
    process.env.MODEL = "mlx-community/text-only-default";
    process.env.IMAGE_MODEL = "mlx-community/qwen2.5-vl-override";
    process.env.OPENAI_BASE_URL = "http://omlx.offline.test/v1";
    process.env.OMLX_BASE_URL = "http://omlx.offline.test/v1";
    process.env.OPENROUTER_API_KEY = "";

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      captured.push({ url, body });
      return sseSubmitResultResponse(expected);
    }) as typeof fetch;

    const result = await describeImage(imagePath, "What movie is shown?", descriptionSchema);
    expect(result).toEqual(expected);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.body.model).toBe("mlx-community/qwen2.5-vl-override");

    const messages = captured[0]!.body.messages as Array<{ role: string; content: unknown }>;
    const userMessage = messages.find((m) => m.role === "user");
    expect(Array.isArray(userMessage?.content)).toBe(true);

    // Explicit opts.model overrides IMAGE_MODEL as well.
    captured.length = 0;
    await describeImage(imagePath, "What movie is shown?", descriptionSchema, {
      model: "mlx-community/explicit-opt-vision",
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.body.model).toBe("mlx-community/explicit-opt-vision");
  });
});

describe("describeImage tracing & privateSourceContext privacy guarantees", () => {
  test("strips raw base64 image bytes from all OTel spans while keeping metadata", async () => {
    const recorder = new RecordingTracerProvider();
    trace.disable();
    trace.setGlobalTracerProvider(recorder);

    const sent = await visionImage(await readFile(imagePath), "image/png");
    expect(sent.data.length).toBeGreaterThan(40);
    const rawSnippet = sent.data.slice(0, 40);

    const captured: CapturedWireRequest[] = [];
    const provider = createOfflineOpenAIProvider(
      "omlx",
      { app: "Photos", summary: "Blue test square", prominentText: [] },
      captured,
    );

    await describeImage(imagePath, "Inspect this image", descriptionSchema, {
      routes: [{ client: provider, model: "mlx-community/Qwen2.5-VL-7B" }],
    });

    expect(recorder.spans.length).toBeGreaterThan(0);
    const spanKinds = recorder.spans.map((s) => s.attributes["openinference.span.kind"]);
    expect(spanKinds).toContain("AGENT");
    expect(spanKinds).toContain("LLM");

    const serialized = JSON.stringify(recorder.spans);
    expect(serialized).not.toContain(sent.data);
    expect(serialized).not.toContain(rawSnippet);
    expect(serialized).toContain(sent.mimeType);
    expect(serialized).toContain(String(sent.data.length));
  });

  test("emits ZERO OTel spans when executed inside privateSourceContext.run(true, ...)", async () => {
    const recorder = new RecordingTracerProvider();
    trace.disable();
    trace.setGlobalTracerProvider(recorder);

    const captured: CapturedWireRequest[] = [];
    const expected: Description = {
      app: "Messages",
      summary: "Private candidate screenshot",
      prominentText: ["sensitive text"],
    };
    const provider = createOfflineOpenAIProvider("omlx", expected, captured);

    const result = await privateSourceContext.run(true, () =>
      describeImage(imagePath, "Classify private screenshot", descriptionSchema, {
        routes: [{ client: provider, model: "mlx-community/Qwen2.5-VL-7B" }],
      }),
    );

    expect(result).toEqual(expected);
    expect(recorder.spans).toEqual([]);
  });
});

describe("sources/consumer outage detection for solenoid-engine errors", () => {
  test("modelUnavailable recognizes ProviderStalledError and solenoid-engine route failure chains", () => {
    // Direct ProviderStalledError (first_byte & idle phases)
    expect(modelUnavailable(new ProviderStalledError("first_byte", 300_000, "omlx"))).toBe(true);
    expect(modelUnavailable(new ProviderStalledError("idle", 60_000, "openrouter"))).toBe(true);

    // Wrapped inside AgentRunError cause chain (as thrown after route fallback exhaustion)
    expect(
      modelUnavailable(
        new AgentRunError("All routes failed", {
          cause: new ProviderStalledError("first_byte", 300_000, "omlx"),
        }),
      ),
    ).toBe(true);
    expect(
      modelUnavailable(
        new AgentRunError("Route failed", {
          cause: new Error("connect ECONNREFUSED 127.0.0.1:8000"),
        }),
      ),
    ).toBe(true);
    expect(
      modelUnavailable(
        new AgentRunError("Upstream error", {
          cause: new Error("503 Service Unavailable"),
        }),
      ),
    ).toBe(true);

    // Baseline network/host outage strings continue to be recognized
    expect(modelUnavailable(new Error("429 Too Many Requests"))).toBe(true);
    expect(modelUnavailable(new Error("fetch failed"))).toBe(true);
    expect(modelUnavailable(new Error("400 No models loaded"))).toBe(true);

    // Non-outage / per-screenshot errors MUST NOT be treated as host outages
    expect(modelUnavailable(new AgentRunError("Structured output failed validation"))).toBe(false);
    expect(modelUnavailable(new AgentRunError("No answer after 25 model turns"))).toBe(false);
    expect(modelUnavailable(new Error("Screenshot classification failed"))).toBe(false);
    expect(modelUnavailable(new Error('400 "LM Link connection closed"'))).toBe(false);
  });

  test("consumeScreenshot preserves remaining attempts on ProviderStalledError and engine route outages", async () => {
    process.env.SOURCE_ASSET_DIR = join(tempDir, "assets");
    process.env.SOURCE_STAGING_DIR = join(tempDir, "staging");

    const db: Db = initDb(join(tempDir, "consumer.db"));
    try {
      const hash = digest(pngBytes);
      const photo = {
        uuid: "photo-stall-test-1",
        filename: "shot.png",
        date: "2026-09-01T00:00:00.000Z",
        width: 24,
        height: 24,
        hash,
      };
      await stagePhoto(photo, pngBytes, db);
      expect(candidate(hash, db)).toMatchObject({ status: "pending", attempts: 0 });

      // 1. Direct ProviderStalledError must NOT consume an attempt.
      await consumeScreenshot(db, async () => {
        throw new ProviderStalledError("first_byte", 300_000, "omlx");
      });
      expect(candidate(hash, db)).toMatchObject({ status: "failed", attempts: 0 });
      expect(candidate(hash, db)!.retry_at).toBeGreaterThan(Date.now());
      expect(await stat(assetPath(hash, ".png", true))).toBeTruthy();

      // 2. Wrapped engine route failure caused by idle stall must NOT consume an attempt.
      db.$client.query("UPDATE source_candidates SET retry_at=0 WHERE hash=?").run(hash);
      await consumeScreenshot(db, async () => {
        throw new AgentRunError("All routes failed", {
          cause: new ProviderStalledError("idle", 60_000, "omlx"),
        });
      });
      expect(candidate(hash, db)).toMatchObject({ status: "failed", attempts: 0 });
      expect(candidate(hash, db)!.retry_at).toBeGreaterThan(Date.now());

      // 3. Genuine non-outage error MUST increment attempts so broken inputs cannot loop forever.
      db.$client.query("UPDATE source_candidates SET retry_at=0 WHERE hash=?").run(hash);
      await consumeScreenshot(db, async () => {
        throw new AgentRunError("Structured output failed validation");
      });
      expect(candidate(hash, db)).toMatchObject({ status: "failed", attempts: 1 });
    } finally {
      db.$client.close();
    }
  });
});
