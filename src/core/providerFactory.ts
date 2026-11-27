import OpenAI from "openai";
import {
  OpenAICompatibleProvider,
  stallGuardedFetch,
  type ChatProvider,
  type ModelRoute,
  type ModelRouteChain,
  type ReasoningDialect,
} from "@elicollinson/solenoid-engine";
import {
  loadRuntimeConfig,
  type ModelRouteConfig,
  type RuntimeConfig,
} from "./config";

/** Longest timer supported by JS runtimes; stallGuardedFetch owns silence timeouts. */
const NO_TIMEOUT_MS = 2 ** 31 - 1;
const DEFAULT_FIRST_BYTE_MS = 5 * 60_000;
const DEFAULT_IDLE_MS = 60_000;

export interface OpenAIClientOptions {
  baseURL?: string;
  apiKey?: string;
}

export interface OpenRouterClientOptions {
  baseURL?: string;
  apiKey?: string;
}

function guardedFetch(provider: ReasoningDialect): typeof fetch {
  // Delegate through globalThis.fetch dynamically so offline tests intercepting
  // fetch always capture calls cleanly while live runs keep stall detection.
  return stallGuardedFetch(
    {
      firstByteMs: DEFAULT_FIRST_BYTE_MS,
      idleMs: DEFAULT_IDLE_MS,
      provider,
    },
    ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      globalThis.fetch(input, init)) as typeof fetch,
  );
}

function buildClient(
  baseURL: string,
  apiKey: string,
  dialect: ReasoningDialect,
): OpenAI {
  return new OpenAI({
    baseURL,
    apiKey,
    // Agent owns bounded retries and route fallback; stall guard owns timeouts.
    maxRetries: 0,
    timeout: NO_TIMEOUT_MS,
    fetch: guardedFetch(dialect),
  });
}

function asEngineOpenAI(
  client: OpenAI,
): ConstructorParameters<typeof OpenAICompatibleProvider>[0] {
  return client as unknown as ConstructorParameters<typeof OpenAICompatibleProvider>[0];
}

/** Build an oMLX OpenAI-compatible client (default local MLX backend). */
export function createOmlxClient(
  options: OpenAIClientOptions = {},
  config: RuntimeConfig = loadRuntimeConfig(),
): OpenAI {
  const baseURL = options.baseURL ?? config.omlx.baseUrl;
  const apiKey = options.apiKey ?? config.omlx.apiKey ?? "omlx";
  return buildClient(baseURL, apiKey, "omlx");
}

/** Build an LM Studio OpenAI-compatible client. */
export function createLmStudioClient(
  options: OpenAIClientOptions = {},
  config: RuntimeConfig = loadRuntimeConfig(),
): OpenAI {
  const baseURL = options.baseURL ?? config.lmstudio.baseUrl;
  const apiKey = options.apiKey ?? config.lmstudio.apiKey ?? "lm-studio";
  return buildClient(baseURL, apiKey, "lmstudio");
}

/** Build an OpenAI-compatible client for explicit OPENAI_BASE_URL configurations. */
export function createOpenAIClient(
  options: OpenAIClientOptions = {},
  config: RuntimeConfig = loadRuntimeConfig(),
): OpenAI {
  const baseURL = options.baseURL ?? config.openai.baseUrl;
  if (!baseURL) {
    throw new Error(
      "OPENAI_BASE_URL must be set when LLM_PROVIDER=openai " +
        "(for local servers, use e.g. http://<host>:8000/v1 or http://<host>:1234/v1)",
    );
  }
  const apiKey = options.apiKey ?? config.openai.apiKey ?? "lm-studio";
  return buildClient(baseURL, apiKey, "lmstudio");
}

/** Build the OpenRouter OpenAI-compatible client without credential crossover. */
export function createOpenRouterClient(
  options: OpenRouterClientOptions = {},
  config: RuntimeConfig = loadRuntimeConfig(),
): OpenAI {
  const apiKey = options.apiKey ?? config.openrouter.apiKey;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY must be set for OpenRouter routes");
  return buildClient(
    options.baseURL ?? config.openrouter.baseUrl,
    apiKey,
    "openrouter",
  );
}

/** Select the primary configured provider. */
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
    return new OpenAICompatibleProvider(
      asEngineOpenAI(createOpenRouterClient({}, config)),
      "openrouter",
    );
  }
  if (route.provider === "lmstudio") {
    return new OpenAICompatibleProvider(
      asEngineOpenAI(createLmStudioClient({}, config)),
      "lmstudio",
    );
  }
  if (route.provider === "openai") {
    return new OpenAICompatibleProvider(
      asEngineOpenAI(createOpenAIClient({}, config)),
      "lmstudio",
    );
  }
  return new OpenAICompatibleProvider(
    asEngineOpenAI(createOmlxClient({}, config)),
    "omlx",
  );
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
    ...(index === 0 && options.primaryModel ? { model: options.primaryModel } : {}),
  }));
  if (!routes[0]) throw new Error("At least one model route must be configured");
  return routes as unknown as ModelRouteChain;
}
