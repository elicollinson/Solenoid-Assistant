import OpenAI from "openai";
import { loadRuntimeConfig, type RuntimeConfig } from "./config";
import { createOllamaClient } from "./ollama";
import {
  OllamaProvider,
  OpenAIProvider,
  type ChatProvider,
} from "./providers";

export interface OpenAIClientOptions {
  baseURL?: string;
  apiKey?: string;
}

/** Build an OpenAI-compatible client, including local servers such as LM Studio. */
export function createOpenAIClient(
  options: OpenAIClientOptions = {},
  config: RuntimeConfig = loadRuntimeConfig(),
): OpenAI {
  const baseURL = options.baseURL ?? config.openai.baseUrl;
  if (!baseURL) {
    throw new Error(
      "OPENAI_BASE_URL must be set when LLM_PROVIDER=openai " +
        "(for LM Studio, use http://<host>:1234/v1)",
    );
  }

  return new OpenAI({
    baseURL,
    // The SDK requires a value. LM Studio ignores this placeholder when API
    // authentication is disabled; when enabled, configure the real token.
    apiKey: options.apiKey ?? config.openai.apiKey ?? "lm-studio",
  });
}

/** Select the configured provider while preserving Ollama as the default. */
export function createChatProvider(
  config: RuntimeConfig = loadRuntimeConfig(),
): ChatProvider {
  if (config.llmProvider === "openai") {
    return new OpenAIProvider(createOpenAIClient({}, config));
  }
  return new OllamaProvider(createOllamaClient({}, config));
}
