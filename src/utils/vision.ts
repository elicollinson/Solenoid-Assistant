/**
 * Vision call: send an image to the configured vision model with a prompt and
 * an expected Zod response schema.
 *
 * The repo's `ChatProvider`/`ChatMessage` abstraction is text-only — the
 * multimodal message shape has no place in it. Rather than extend the entire
 * provider stack for one use case, this calls the selected Ollama or
 * OpenAI-compatible client directly, reusing the same runtime configuration
 * and structured-output machinery (`extractJson`, `toOutputFormat`) as `Agent`.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import pLimit from "p-limit";
import {
  extractJson,
  toOutputFormat,
} from "../core/rawAgent";
import { log } from "../core/logger";
import { createOllamaClient } from "../core/ollama";
import { loadRuntimeConfig } from "../core/config";
import { createOpenAIClient } from "../core/providerFactory";

export interface VisionOptions {
  /** Provider override. Defaults to `LLM_PROVIDER`. */
  provider?: "ollama" | "openai";
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
 * image shape. The schema is sent as `format` (Ollama) or `response_format`
 * (OpenAI-compatible) and repeated as a system instruction. The response is
 * recovered with `extractJson` and parsed with Zod, exactly like
 * `Agent.runInner` does for text-only structured calls.
 */
export async function describeImage<S extends z.ZodType>(
  imagePath: string,
  prompt: string,
  schema: S,
  opts: VisionOptions = {},
): Promise<z.infer<S>> {
  const config = loadRuntimeConfig();
  const provider = opts.provider ?? config.llmProvider;
  const model = opts.model ?? config.imageModel;

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

  const format = toOutputFormat("vision_output", schema);
  const formatInstruction =
    `Respond with a single JSON object matching this JSON schema, and nothing else ` +
    `— no markdown, no code fences, no commentary:\n${JSON.stringify(format.schema)}`;

  let content: string;
  try {
    if (provider === "openai") {
      const client = createOpenAIClient(
        { baseURL: opts.baseURL, apiKey: opts.apiKey },
        config,
      );
      const res = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: formatInstruction },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:${imageMimeType(imagePath)};base64,${base64}`,
                },
              },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: format.name,
            schema: format.schema,
          },
        },
      });
      content = res.choices[0]?.message.content ?? "";
    } else {
      const client = createOllamaClient(
        { host: opts.host, apiKey: opts.apiKey },
        config,
      );
      const res = await client.chat({
        model,
        format: format.schema,
        think: false, // reasoning models route JSON to the thinking channel on Cloud
        messages: [
          { role: "system", content: formatInstruction },
          {
            role: "user",
            content: prompt,
            images: [base64],
          },
        ],
      });
      content = res.message?.content ?? "";
    }
  } catch (err) {
    const e = err as Error & { status?: number; statusCode?: number };
    log.error(`vision: model call failed`, {
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

  const json = extractJson(content);

  if (!json) {
    log.warn(`vision: model returned no content`, {
      model,
      imagePath,
      rawSnippet: content.slice(0, 200),
    });
    throw new Error(
      `Vision call returned no content to parse. Model may have spent the turn on reasoning. ` +
        `Raw output: "${content.slice(0, 200)}"`,
    );
  }

  try {
    return schema.parse(JSON.parse(json));
  } catch (err) {
    log.warn(`vision: output failed validation`, {
      model,
      imagePath,
      error: err instanceof Error ? err.message : String(err),
      jsonSnippet: json.slice(0, 200),
    });
    throw new Error(
      `Vision output failed validation: ${err instanceof Error ? err.message : String(err)}\n` +
        `Model output: ${content.slice(0, 500)}`,
    );
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
