import OpenAI from "openai";
import {
  loadRuntimeConfig,
  type ModelRouteConfig,
  type RuntimeConfig,
} from "./config";
import { createOllamaClient } from "./ollama";
import {
  OllamaProvider,
  OpenAIProvider,
  OpenRouterProvider,
  type ChatProvider,
} from "./providers";
import type { ModelRoute, ModelRouteChain } from "./rawAgent";

export interface OpenAIClientOptions {
  baseURL?: string;
  apiKey?: string;
}

export interface OpenRouterClientOptions {
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

/** Build the OpenRouter OpenAI-compatible client without credential crossover. */
export function createOpenRouterClient(
  options: OpenRouterClientOptions = {},
  config: RuntimeConfig = loadRuntimeConfig(),
): OpenAI {
  const apiKey = options.apiKey ?? config.openrouter.apiKey;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY must be set for OpenRouter routes");
  return new OpenAI({
    baseURL: options.baseURL ?? config.openrouter.baseUrl,
    apiKey,
  });
}

/** Select the configured provider while preserving Ollama as the default. */
export function createChatProvider(
  config: RuntimeConfig = loadRuntimeConfig(),
): ChatProvider {
  return createModelRoute(config.modelRoutes[0]!, config).client;
}

function createProviderForRoute(
  route: ModelRouteConfig,
  config: RuntimeConfig,
): ChatProvider {
  if (route.provider === "openrouter") {
    return new OpenRouterProvider(
      createOpenRouterClient({}, config),
      { structuredOutputStrategy: route.structuredOutputStrategy },
    );
  }
  if (route.provider === "openai") {
    return new OpenAIProvider(createOpenAIClient({}, config), {
      structuredOutputStrategy: route.structuredOutputStrategy,
    });
  }
  return new OllamaProvider(createOllamaClient({}, config), {
    structuredOutputStrategy: route.structuredOutputStrategy,
  });
}

/** Resolve one declarative route using its provider-specific connection. */
export function createModelRoute(
  route: ModelRouteConfig,
  config: RuntimeConfig = loadRuntimeConfig(),
): ModelRoute {
  return {
    client: createProviderForRoute(route, config),
    model: route.model,
  };
}

/** Resolve the configured ordered model route chain into provider clients. */
export function createModelRoutes(
  config: RuntimeConfig = loadRuntimeConfig(),
  options: { primaryModel?: string } = {},
): ModelRouteChain {
  const routes = config.modelRoutes.map((route, index) => ({
    ...createModelRoute(route, config),
    ...(index === 0 && options.primaryModel
      ? { model: options.primaryModel }
      : {}),
  }));
  if (!routes[0]) throw new Error("At least one model route must be configured");
  return routes as unknown as ModelRouteChain;
}
