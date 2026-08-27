import { z } from "zod";

const optionalEnvString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional(),
);

const runtimeConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  /**
   * Which interface to listen on. Loopback by default, which is a deliberate
   * change of posture rather than a shrug: this server answers questions about
   * the user's messages, contacts, calendar and screenshots, and holds no
   * authentication of any kind. Bound to 0.0.0.0 it is that, offered to
   * everyone on whatever wifi the laptop is on.
   *
   * Reaching it from another device is what `tailscale serve` is for — the
   * daemon proxies from the tailnet to 127.0.0.1, so the app is reachable by
   * exactly the machines the tailnet already vouches for and by nothing else.
   * See `bun run serve:tailscale`.
   *
   * `HOST=0.0.0.0` puts it back, for a LAN you actually trust.
   */
  HOST: optionalEnvString.default("127.0.0.1"),
  LLM_PROVIDER: z.enum(["ollama", "openai", "openrouter"]).default("ollama"),
  LLM_ROUTES: optionalEnvString,
  MODEL: optionalEnvString.default("glm-5.2"),
  IMAGE_MODEL: optionalEnvString,
  OLLAMA_API_URL: optionalEnvString.default("https://ollama.com"),
  OLLAMA_API_KEY: optionalEnvString,
  OPENAI_BASE_URL: optionalEnvString,
  OPENAI_API_KEY: optionalEnvString,
  OPENROUTER_BASE_URL: optionalEnvString.default("https://openrouter.ai/api/v1"),
  OPENROUTER_API_KEY: optionalEnvString,
  OPENROUTER_MODEL: optionalEnvString.default("google/gemma-4-31b-it"),
  STRUCTURED_OUTPUT_STRATEGY: z.enum(["native", "two-stage"]).optional(),
  PROMPT_GUARD_MODEL_PATH: optionalEnvString.default(
    "models/prompt-guard-2-86m",
  ),
  PROMPT_GUARD_DEVICE: z.enum(["cpu", "webgpu"]).default("cpu"),
  PROMPT_GUARD_THRESHOLD: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().min(0).max(1).default(0.5),
  ),
  PROMPT_GUARD_BATCH_SIZE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(128).default(16),
  ),
  PROMPT_GUARD_CHUNK_OVERLAP: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(0).max(509).default(32),
  ),
  PHOENIX_TRACING_ENABLED: optionalEnvString.default("true"),
  PHOENIX_COLLECTOR_ENDPOINT: optionalEnvString.default("http://localhost:6006"),
  PHOENIX_PROJECT_NAME: optionalEnvString.default("solenoid-assistant"),
  /**
   * Structured logging. The console half is always on; the VictoriaLogs half
   * is best-effort and never in the way of a request — see src/core/logging.
   */
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** How the console line is written. `auto` is pretty on a TTY, JSON off it. */
  LOG_FORMAT: z.enum(["auto", "pretty", "json"]).default("auto"),
  /** The `service` field on every record. Each entrypoint sets its own default. */
  LOG_SERVICE: optionalEnvString,
  VICTORIALOGS_ENABLED: optionalEnvString.default("true"),
  VICTORIALOGS_ENDPOINT: optionalEnvString.default("http://localhost:9428"),
  VICTORIALOGS_BATCH_SIZE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(10_000).default(200),
  ),
  VICTORIALOGS_FLUSH_MS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(50).max(60_000).default(2_000),
  ),
  /** Records held in memory before the oldest are dropped. Bounded on purpose:
   *  a collector that is down must cost memory, not availability. */
  VICTORIALOGS_QUEUE_LIMIT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(100).max(1_000_000).default(10_000),
  ),
  VICTORIALOGS_TIMEOUT_MS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(100).max(60_000).default(5_000),
  ),
  NOTION_API_TOKEN: optionalEnvString,
  NOTION_DS_BOOKS: optionalEnvString,
  NOTION_DS_MOVIES: optionalEnvString,
  NOTION_DS_TV: optionalEnvString,
  NOTION_DS_MUSIC: optionalEnvString,
  NOTION_DS_GAMES: optionalEnvString,
  TAVILY_API_KEY: optionalEnvString,
});

export interface RuntimeConfig {
  port: number;
  /** The interface to bind. Loopback unless HOST says otherwise. */
  host: string;
  llmProvider: ModelProviderName;
  model: string;
  imageModel: string;
  structuredOutputStrategy: "native" | "two-stage";
  modelRoutes: [ModelRouteConfig, ...ModelRouteConfig[]];
  ollama: {
    host: string;
    apiKey?: string;
  };
  openai: {
    baseUrl?: string;
    apiKey?: string;
  };
  openrouter: {
    baseUrl: string;
    apiKey?: string;
    model: string;
  };
  promptGuard: {
    modelPath: string;
    device: "cpu" | "webgpu";
    threshold: number;
    batchSize: number;
    chunkOverlap: number;
  };
  phoenix: {
    enabled: boolean;
    collectorEndpoint: string;
    projectName: string;
  };
  logging: {
    level: LogLevelName;
    format: "auto" | "pretty" | "json";
    /** Undefined until an entrypoint names itself; LOG_SERVICE overrides both. */
    service?: string;
    victoriaLogs: {
      enabled: boolean;
      /** Base URL. The ingest path is appended by the sink. */
      endpoint: string;
      batchSize: number;
      flushMs: number;
      queueLimit: number;
      timeoutMs: number;
    };
  };
  notion: {
    apiToken?: string;
    dataSourceIds: {
      book?: string;
      movie?: string;
      tv?: string;
      music?: string;
      game?: string;
    };
  };
  tavily: {
    apiKey?: string;
  };
}

export type ModelProviderName = "ollama" | "openai" | "openrouter";

export type LogLevelName = "debug" | "info" | "warn" | "error";

export interface ModelRouteConfig {
  provider: ModelProviderName;
  model: string;
  structuredOutputStrategy: "native" | "two-stage";
}

const modelRouteInputSchema = z.object({
  provider: z.enum(["ollama", "openai", "openrouter"]),
  model: z.string().trim().min(1),
  structuredOutputStrategy: z.enum(["native", "two-stage"]).optional(),
});

function defaultStructuredOutputStrategy(
  provider: ModelProviderName,
  ollamaHost: string,
): "native" | "two-stage" {
  if (provider !== "ollama") return "native";
  try {
    return new URL(ollamaHost).hostname === "ollama.com" ? "two-stage" : "native";
  } catch {
    return "native";
  }
}

function parseModelRoutes(
  raw: string,
  globalStrategy: "native" | "two-stage" | undefined,
  ollamaHost: string,
): [ModelRouteConfig, ...ModelRouteConfig[]] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `LLM_ROUTES must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const routes = z.array(modelRouteInputSchema).min(1).parse(json);
  return routes.map((route) => ({
    provider: route.provider,
    model: route.model,
    structuredOutputStrategy:
      route.structuredOutputStrategy ??
      globalStrategy ??
      defaultStructuredOutputStrategy(route.provider, ollamaHost),
  })) as [ModelRouteConfig, ...ModelRouteConfig[]];
}

export function loadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const parsed = runtimeConfigSchema.parse(env);
  const legacyPrimaryRoute: ModelRouteConfig = {
    provider: parsed.LLM_PROVIDER,
    model: parsed.MODEL,
    structuredOutputStrategy:
      parsed.STRUCTURED_OUTPUT_STRATEGY ??
      defaultStructuredOutputStrategy(parsed.LLM_PROVIDER, parsed.OLLAMA_API_URL),
  };
  const modelRoutes: [ModelRouteConfig, ...ModelRouteConfig[]] = parsed.LLM_ROUTES
    ? parseModelRoutes(
        parsed.LLM_ROUTES,
        parsed.STRUCTURED_OUTPUT_STRATEGY,
        parsed.OLLAMA_API_URL,
      )
    : [
        legacyPrimaryRoute,
        ...(parsed.OPENROUTER_API_KEY && parsed.LLM_PROVIDER !== "openrouter"
          ? [{
              provider: "openrouter" as const,
              model: parsed.OPENROUTER_MODEL,
              structuredOutputStrategy: "native" as const,
            }]
          : []),
      ];
  const primaryRoute = modelRoutes[0]!;
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    llmProvider: primaryRoute.provider,
    model: primaryRoute.model,
    imageModel: parsed.IMAGE_MODEL ?? primaryRoute.model,
    structuredOutputStrategy: primaryRoute.structuredOutputStrategy,
    modelRoutes,
    ollama: {
      host: parsed.OLLAMA_API_URL,
      ...(parsed.OLLAMA_API_KEY ? { apiKey: parsed.OLLAMA_API_KEY } : {}),
    },
    openai: {
      ...(parsed.OPENAI_BASE_URL ? { baseUrl: parsed.OPENAI_BASE_URL } : {}),
      ...(parsed.OPENAI_API_KEY ? { apiKey: parsed.OPENAI_API_KEY } : {}),
    },
    openrouter: {
      baseUrl: parsed.OPENROUTER_BASE_URL,
      ...(parsed.OPENROUTER_API_KEY ? { apiKey: parsed.OPENROUTER_API_KEY } : {}),
      model: parsed.OPENROUTER_MODEL,
    },
    promptGuard: {
      modelPath: parsed.PROMPT_GUARD_MODEL_PATH,
      device: parsed.PROMPT_GUARD_DEVICE,
      threshold: parsed.PROMPT_GUARD_THRESHOLD,
      batchSize: parsed.PROMPT_GUARD_BATCH_SIZE,
      chunkOverlap: parsed.PROMPT_GUARD_CHUNK_OVERLAP,
    },
    phoenix: {
      enabled: parsed.PHOENIX_TRACING_ENABLED !== "false",
      collectorEndpoint: parsed.PHOENIX_COLLECTOR_ENDPOINT,
      projectName: parsed.PHOENIX_PROJECT_NAME,
    },
    logging: {
      level: parsed.LOG_LEVEL,
      format: parsed.LOG_FORMAT,
      ...(parsed.LOG_SERVICE ? { service: parsed.LOG_SERVICE } : {}),
      victoriaLogs: {
        enabled: parsed.VICTORIALOGS_ENABLED !== "false",
        endpoint: parsed.VICTORIALOGS_ENDPOINT.replace(/\/+$/, ""),
        batchSize: parsed.VICTORIALOGS_BATCH_SIZE,
        flushMs: parsed.VICTORIALOGS_FLUSH_MS,
        queueLimit: parsed.VICTORIALOGS_QUEUE_LIMIT,
        timeoutMs: parsed.VICTORIALOGS_TIMEOUT_MS,
      },
    },
    notion: {
      ...(parsed.NOTION_API_TOKEN ? { apiToken: parsed.NOTION_API_TOKEN } : {}),
      dataSourceIds: {
        ...(parsed.NOTION_DS_BOOKS ? { book: parsed.NOTION_DS_BOOKS } : {}),
        ...(parsed.NOTION_DS_MOVIES ? { movie: parsed.NOTION_DS_MOVIES } : {}),
        ...(parsed.NOTION_DS_TV ? { tv: parsed.NOTION_DS_TV } : {}),
        ...(parsed.NOTION_DS_MUSIC ? { music: parsed.NOTION_DS_MUSIC } : {}),
        ...(parsed.NOTION_DS_GAMES ? { game: parsed.NOTION_DS_GAMES } : {}),
      },
    },
    tavily: {
      ...(parsed.TAVILY_API_KEY ? { apiKey: parsed.TAVILY_API_KEY } : {}),
    },
  };
}

export function requireNotionDataSourceIds(
  config: RuntimeConfig,
): Required<RuntimeConfig["notion"]["dataSourceIds"]> {
  const ids = config.notion.dataSourceIds;
  const missing = (
    [
      ["book", "NOTION_DS_BOOKS"],
      ["movie", "NOTION_DS_MOVIES"],
      ["tv", "NOTION_DS_TV"],
      ["music", "NOTION_DS_MUSIC"],
      ["game", "NOTION_DS_GAMES"],
    ] as const
  )
    .filter(([key]) => !ids[key])
    .map(([, envName]) => envName);

  if (missing.length > 0) {
    throw new Error(
      `Notion data source IDs not set in .env: ${missing.join(", ")}. ` +
        "Set these to the database IDs from your Notion gallery databases.",
    );
  }

  return ids as Required<typeof ids>;
}
