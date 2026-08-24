/**
 * Vision call: send an image to the configured vision model with a prompt and
 * an expected Zod response schema.
 *
 * Vision uses the same provider-normalized, deadline-aware Agent loop as text
 * tasks. Images are represented as normalized message parts and converted to
 * each provider's native shape by its adapter.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import pLimit from "p-limit";
import { Ollama } from "ollama";
import {
  Agent,
  DEFAULT_AGENT_TIMEOUT_MS,
  type ModelRouteInputChain,
} from "../core/rawAgent";
import { log } from "../core/logger";
import { createOllamaClient } from "../core/ollama";
import { loadRuntimeConfig } from "../core/config";
import {
  createModelRoute,
  createOpenAIClient,
  createOpenRouterClient,
} from "../core/providerFactory";
import { OllamaProvider, OpenAIProvider, OpenRouterProvider } from "../core/providers";

export interface VisionOptions {
  /** Override the complete ordered model route chain. */
  routes?: ModelRouteInputChain;
  /** Provider override. Defaults to `LLM_PROVIDER`. */
  provider?: "ollama" | "openai" | "openrouter";
  /**
   * Model name. Defaults to `process.env.IMAGE_MODEL`, falling back to
   * `process.env.MODEL` — set IMAGE_MODEL to a vision-capable cloud model.
   */
  model?: string;
  /** Ollama host override. */
  host?: string;
  /** OpenAI-compatible base URL override. */
  baseURL?: string;
  /** Bearer token override for the selected provider. */
  apiKey?: string;
  /** Override native vs. two-stage structured output behavior. */
  structuredOutputStrategy?: "native" | "two-stage";
  /** Per-provider-attempt timeout. Defaults to five minutes per image. */
  timeoutMs?: number;
}

function imageMimeType(imagePath: string): string {
  switch (extname(imagePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    case ".jpg":
    case ".jpeg":
    default:
      return "image/jpeg";
  }
}

/**
 * Send an image file to a vision model with a text prompt, returning a
 * structured response validated against `schema`.
 *
 * The image is base64-encoded and passed in the selected provider's native
 * image shape. The shared runner selects either native structured submission
 * (LM Studio/local backends) or a reasoning pass followed by a non-reasoning
 * serialization pass (Ollama Cloud by default).
 */
export async function describeImage<S extends z.ZodType>(
  imagePath: string,
  prompt: string,
  schema: S,
  opts: VisionOptions = {},
): Promise<z.infer<S>> {
  const config = loadRuntimeConfig();
  const explicitClient = opts.routes?.[0].client;
  const provider = explicitClient
    ? explicitClient instanceof Ollama
      ? "ollama"
      : explicitClient.providerName ?? explicitClient.constructor.name
    : opts.provider ?? config.llmProvider;
  const model = opts.routes?.[0].model ?? opts.model ?? config.imageModel;

  const imageBuffer = await readFile(imagePath);
  const base64 = imageBuffer.toString("base64");
  const imageSize = imageBuffer.length;

  log.debug(`vision: sending image to model`, {
    provider,
    model,
    imagePath,
    imageSizeBytes: imageSize,
    base64Length: base64.length,
  });

  try {
    let routes: ModelRouteInputChain;
    if (opts.routes) {
      routes = opts.routes;
    } else {
      const structuredOutputStrategy =
        opts.structuredOutputStrategy ?? config.structuredOutputStrategy;
      const chatProvider = provider === "openai"
        ? new OpenAIProvider(
            createOpenAIClient(
              { baseURL: opts.baseURL, apiKey: opts.apiKey },
              config,
            ),
            { structuredOutputStrategy },
          )
        : provider === "openrouter"
          ? new OpenRouterProvider(
              createOpenRouterClient(
                {
                  baseURL: opts.baseURL ?? config.openrouter.baseUrl,
                  apiKey: opts.apiKey ?? config.openrouter.apiKey,
                },
                config,
              ),
              { structuredOutputStrategy },
            )
          : new OllamaProvider(
              createOllamaClient(
                { host: opts.host, apiKey: opts.apiKey },
                config,
              ),
              { structuredOutputStrategy },
            );
      routes = [
        { client: chatProvider, model },
        ...config.modelRoutes.slice(1).map((route) => createModelRoute(route, config)),
      ];
    }
    const agent = new Agent({
      name: "vision-description",
      routes,
      systemPrompt:
        "Analyze the supplied image carefully and complete the requested task.",
      timeoutMs: opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    });
    return await agent.runMessages(
      [
        {
          role: "user",
          content: prompt,
          images: [{ data: base64, mimeType: imageMimeType(imagePath) }],
        },
      ],
      schema,
    );
  } catch (err) {
    const e = err as Error & { status?: number; statusCode?: number };
    log.error(`vision: run failed`, {
      provider,
      model,
      imagePath,
      imageSizeBytes: imageSize,
      error: e.message,
      status: e.status ?? e.statusCode ?? "unknown",
      name: e.name,
    });
    throw err;
  }
}

/**
 * Run `tasks` with at most `limit` in flight, preserving input order in the
 * output. Kept dependency-free; swap in p-limit if you'd rather.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Concurrency limit must be a positive integer, received ${limit}`);
  }
  const schedule = pLimit(limit);
  return Promise.all(items.map((item, index) => schedule(() => fn(item, index))));
}
