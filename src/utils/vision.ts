/**
 * Vision call: send an image to an Ollama vision model with a prompt and an
 * expected Zod response schema.
 *
 * The repo's `ChatProvider`/`ChatMessage` abstraction is text-only — the
 * `images` field on Ollama's `Message` type has no place in it. Rather than
 * extend the entire provider stack for one use case, this calls the Ollama
 * client directly, reusing the same env-var configuration and the same
 * structured-output machinery (`extractJson`, `toOutputFormat`) as `Agent`.
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import pLimit from "p-limit";
import {
  extractJson,
  toOutputFormat,
} from "../core/rawAgent";
import { log } from "../core/logger";
import { createOllamaClient } from "../core/ollama";
import { loadRuntimeConfig } from "../core/config";

export interface VisionOptions {
  /**
   * Ollama model name. Defaults to `process.env.IMAGE_MODEL`, falling back to
   * `process.env.MODEL` — set IMAGE_MODEL to a vision-capable cloud model.
   */
  model?: string;
  /** Ollama host. Defaults to the same env var as every other client. */
  host?: string;
  /** Bearer token. Defaults to the same env var as every other client. */
  apiKey?: string;
}

/** Default Ollama client constructed from the repo's standard env vars. */
function resolveModel(opts: VisionOptions): string {
  return opts.model ?? loadRuntimeConfig().imageModel;
}

/**
 * Send an image file to a vision model with a text prompt, returning a
 * structured response validated against `schema`.
 *
 * The image is base64-encoded and passed via Ollama's `images` field. The
 * schema is sent as `format` for constrained decoding (local Ollama) and also
 * appended as a system instruction (Ollama Cloud silently ignores `format`).
 * The response is recovered with `extractJson` and parsed with Zod, exactly
 * like `Agent.runInner` does for text-only structured calls.
 */
export async function describeImage<S extends z.ZodType>(
  imagePath: string,
  prompt: string,
  schema: S,
  opts: VisionOptions = {},
): Promise<z.infer<S>> {
  const client = createOllamaClient({ host: opts.host, apiKey: opts.apiKey });
  const model = resolveModel(opts);

  const imageBuffer = await readFile(imagePath);
  const base64 = imageBuffer.toString("base64");
  const imageSize = imageBuffer.length;

  log.debug(`vision: sending image to model`, {
    model,
    imagePath,
    imageSizeBytes: imageSize,
    base64Length: base64.length,
  });

  const format = toOutputFormat("vision_output", schema);

  let res;
  try {
    res = await client.chat({
      model,
      format: format.schema,
      think: false, // reasoning models route JSON to the thinking channel on Cloud
      messages: [
        {
          role: "user",
          content: prompt,
          images: [base64],
        },
        // Belt and braces: Ollama Cloud ignores `format`, so instruct explicitly.
        // Same pattern as OllamaProvider.chatInner.
        {
          role: "system",
          content:
            `Respond with a single JSON object matching this JSON schema, and nothing else ` +
            `— no markdown, no code fences, no commentary:\n${JSON.stringify(format.schema)}`,
        },
      ],
    });
  } catch (err) {
    // Ollama Cloud returns HTTP 500 as a generic "Internal Server Error (ref: ...)"
    // — the ref is their server-side trace. Log everything we know so the error
    // is debuggable without a round-trip to support: which model, which image,
    // how big it was, and the full error (including any status code the client
    // attaches).
    const e = err as Error & { status?: number; statusCode?: number };
    log.error(`vision: model call failed`, {
      model,
      imagePath,
      imageSizeBytes: imageSize,
      error: e.message,
      status: e.status ?? e.statusCode ?? "unknown",
      name: e.name,
    });
    throw err;
  }

  const content = res.message?.content ?? "";
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
