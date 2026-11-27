/**
 * Vision call: send an image to the configured vision model with a prompt and
 * an expected Zod response schema via `@elicollinson/solenoid-engine`'s
 * multimodal `Agent` and `OpenAICompatibleProvider`.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  Agent,
  OpenAICompatibleProvider,
  setTraceFilter,
  type ModelRoute,
  type ModelRouteChain,
} from "@elicollinson/solenoid-engine";
import pLimit from "p-limit";
import type { z } from "zod";
import {
  loadRuntimeConfig,
  type ModelProviderName,
  type RuntimeConfig,
} from "../core/config";
import { createEngineLogger } from "../core/engine";
import { log } from "../core/logger";
import { privateSourceContext } from "../core/privateSourceContext";
import {
  createLmStudioClient,
  createModelRoute,
  createOmlxClient,
  createOpenAIClient,
  createOpenRouterClient,
} from "../core/providerFactory";
import { createSecurityScreener } from "../safety/modelArmor";
import { visionImage } from "./visionImage";

// Ensure candidate screenshot spans are suppressed whenever privateSourceContext is active.
setTraceFilter(() => !privateSourceContext.getStore());

export interface VisionOptions {
  /** Override the complete ordered model route chain. */
  routes?: ModelRouteChain;
  /** Provider override. Defaults to `LLM_PROVIDER`. */
  provider?: ModelProviderName;
  /**
   * Model name. Defaults to `process.env.IMAGE_MODEL`, falling back to
   * `process.env.MODEL`.
   */
  model?: string;
  /** OpenAI-compatible base URL override. */
  baseURL?: string;
  /** Bearer token override for the selected provider. */
  apiKey?: string;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
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

function asEngineOpenAI(
  client: ReturnType<typeof createOmlxClient>,
): ConstructorParameters<typeof OpenAICompatibleProvider>[0] {
  return client as unknown as ConstructorParameters<typeof OpenAICompatibleProvider>[0];
}

function buildPrimaryRoute(
  provider: ModelProviderName,
  model: string,
  opts: VisionOptions,
  config: RuntimeConfig,
): ModelRoute {
  if (provider === "openrouter") {
    return {
      client: new OpenAICompatibleProvider(
        asEngineOpenAI(
          createOpenRouterClient(
            {
              baseURL: opts.baseURL ?? config.openrouter.baseUrl,
              apiKey: opts.apiKey ?? config.openrouter.apiKey,
            },
            config,
          ),
        ),
        "openrouter",
      ),
      model,
    };
  }
  if (provider === "lmstudio") {
    return {
      client: new OpenAICompatibleProvider(
        asEngineOpenAI(
          createLmStudioClient({ baseURL: opts.baseURL, apiKey: opts.apiKey }, config),
        ),
        "lmstudio",
      ),
      model,
    };
  }
  if (provider === "openai") {
    return {
      client: new OpenAICompatibleProvider(
        asEngineOpenAI(
          createOpenAIClient({ baseURL: opts.baseURL, apiKey: opts.apiKey }, config),
        ),
        "lmstudio",
      ),
      model,
    };
  }
  return {
    client: new OpenAICompatibleProvider(
      asEngineOpenAI(
        createOmlxClient({ baseURL: opts.baseURL, apiKey: opts.apiKey }, config),
      ),
      "omlx",
    ),
    model,
  };
}

/**
 * Send an image file to a vision model with a text prompt, returning a
 * structured response validated against `schema` via `submit_result`.
 */
export async function describeImage<S extends z.ZodType>(
  imagePath: string,
  prompt: string,
  schema: S,
  opts: VisionOptions = {},
): Promise<z.infer<S>> {
  const config = loadRuntimeConfig();
  const provider = opts.routes?.[0].client.providerName ?? opts.provider ?? config.llmProvider;
  const model = opts.routes?.[0].model ?? opts.model ?? config.imageModel;

  const imageBuffer = await readFile(imagePath);
  const image = await visionImage(imageBuffer, imageMimeType(imagePath));
  const imageSize = imageBuffer.length;

  log.debug("vision: sending image to model", {
    provider,
    model,
    imagePath,
    imageSizeBytes: imageSize,
    sentBytes: image.data.length,
  });

  try {
    const routes: ModelRouteChain = opts.routes
      ? opts.routes
      : [
          buildPrimaryRoute(opts.provider ?? config.llmProvider, model, opts, config),
          ...config.modelRoutes.slice(1).map((route) => createModelRoute(route, config)),
        ];

    const agent = new Agent({
      name: "vision-description",
      routes,
      systemPrompt:
        "Analyze the supplied image carefully and complete the requested task.",
      screen: createSecurityScreener(config),
      shouldTrace: () => !privateSourceContext.getStore(),
      logger: createEngineLogger("vision"),
    });

    const result = await agent.runMessages(
      [
        {
          role: "user",
          content: prompt,
          images: [image],
        },
      ],
      {
        schema,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    return result.output;
  } catch (err) {
    const e = err as Error & { status?: number; statusCode?: number };
    log.error("vision: run failed", {
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
 * Run `tasks` with at most `limit` in flight, preserving input order in the output.
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
