import { z } from "zod";
import { loadPushoverConfig, type PushoverConfig } from "../pushover/config";

const optionalEnvString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional(),
);

const MODEL_PROVIDERS = ["omlx", "lmstudio", "openai", "openrouter"] as const;

export type ModelProviderName = (typeof MODEL_PROVIDERS)[number];

export type LogLevelName = "debug" | "info" | "warn" | "error";

export interface ModelRouteConfig {
  provider: ModelProviderName;
  model: string;
}

const runtimeConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  /**
   * Which interface to listen on. Loopback by default: this server answers
   * questions about the user's messages, contacts, calendar and screenshots,
   * and holds no authentication of its own. Use `tailscale serve` for remote
   * access, or set `HOST=0.0.0.0` for a trusted LAN.
   */
  HOST: optionalEnvString.default("127.0.0.1"),
  LLM_PROVIDER: z.enum(MODEL_PROVIDERS).default("omlx"),
  LLM_ROUTES: optionalEnvString,
  MODEL: optionalEnvString.default("google/gemma-4-26b-a4b"),
  IMAGE_MODEL: optionalEnvString,
  OMLX_BASE_URL: optionalEnvString,
  OMLX_API_KEY: optionalEnvString,
  LMSTUDIO_BASE_URL: optionalEnvString,
  LMSTUDIO_API_KEY: optionalEnvString,
  OPENAI_BASE_URL: optionalEnvString,
  OPENAI_API_KEY: optionalEnvString,
  OPENROUTER_BASE_URL: optionalEnvString.default("https://openrouter.ai/api/v1"),
  OPENROUTER_API_KEY: optionalEnvString,
  OPENROUTER_MODEL: optionalEnvString.default("google/gemma-4-31b-it"),
  MODEL_ARMOR_ENABLED: optionalEnvString.default("true"),
  MODEL_ARMOR_PROJECT_ID: optionalEnvString,
  MODEL_ARMOR_LOCATION: optionalEnvString.default("us-central1"),
  MODEL_ARMOR_TEMPLATE_ID: optionalEnvString.default("base-detector"),
  MODEL_ARMOR_API_KEY: optionalEnvString,
  MODEL_ARMOR_API_ENDPOINT: optionalEnvString,
  MODEL_ARMOR_CREDENTIALS_JSON: optionalEnvString,
  MODEL_ARMOR_CREDENTIALS_BASE64: optionalEnvString,
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
  TAVILY_API_KEY: optionalEnvString,
  /** Tavily's MCP server; a credential proxy can stand in for it. */
  TAVILY_MCP_URL: optionalEnvString.default("https://mcp.tavily.com/mcp"),
  GEMINI_API_KEY: optionalEnvString,
  /** Gemini API base URL, for a credential proxy; unset uses Google's. */
  GEMINI_BASE_URL: optionalEnvString,
  GEMINI_LIVE_MODEL: optionalEnvString.default("models/gemini-3.8-live-extended-thinking"),
  GEMINI_LIVE_THINKING_LEVEL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["low", "medium", "high"]).default("high"),
  ),
  GEMINI_VOICE: optionalEnvString.default("Sulafat"),
});

export interface RuntimeConfig {
  pushover: PushoverConfig;
  port: number;
  /** The interface to bind. Loopback unless HOST says otherwise. */
  host: string;
  llmProvider: ModelProviderName;
  model: string;
  imageModel: string;
  modelRoutes: [ModelRouteConfig, ...ModelRouteConfig[]];
  omlx: {
    baseUrl: string;
    apiKey?: string;
  };
  lmstudio: {
    baseUrl: string;
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
  modelArmor: {
    enabled: boolean;
    projectId?: string;
    location: string;
    templateId: string;
    apiKey?: string;
    apiEndpoint?: string;
    credentialsJson?: string;
    credentialsBase64?: string;
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
  tavily: {
    apiKey?: string;
    mcpUrl: string;
  };
  gemini: {
    apiKey?: string;
    baseUrl?: string;
    liveModel: string;
    thinkingLevel: "low" | "medium" | "high";
    voice: string;
  };
}

const modelRouteInputSchema = z.object({
  provider: z.enum(MODEL_PROVIDERS),
  model: z.string().trim().min(1),
});

function parseModelRoutes(raw: string): [ModelRouteConfig, ...ModelRouteConfig[]] {
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
  })) as [ModelRouteConfig, ...ModelRouteConfig[]];
}

export function loadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const parsed = runtimeConfigSchema.parse(env);
  const primaryDefault: ModelRouteConfig = {
    provider: parsed.LLM_PROVIDER,
    model: parsed.MODEL,
  };
  const modelRoutes: [ModelRouteConfig, ...ModelRouteConfig[]] = parsed.LLM_ROUTES
    ? parseModelRoutes(parsed.LLM_ROUTES)
    : [
        primaryDefault,
        ...(parsed.OPENROUTER_API_KEY && parsed.LLM_PROVIDER !== "openrouter"
          ? [
              {
                provider: "openrouter" as const,
                model: parsed.OPENROUTER_MODEL,
              },
            ]
          : []),
      ];
  const primaryRoute = modelRoutes[0]!;
  const omlxApiKey = parsed.OMLX_API_KEY ?? parsed.OPENAI_API_KEY;
  const lmstudioApiKey = parsed.LMSTUDIO_API_KEY ?? parsed.OPENAI_API_KEY;
  return {
    pushover: loadPushoverConfig(env),
    port: parsed.PORT,
    host: parsed.HOST,
    llmProvider: primaryRoute.provider,
    model: primaryRoute.model,
    imageModel: parsed.IMAGE_MODEL ?? primaryRoute.model,
    modelRoutes,
    omlx: {
      baseUrl: parsed.OMLX_BASE_URL ?? parsed.OPENAI_BASE_URL ?? "http://localhost:8000/v1",
      ...(omlxApiKey ? { apiKey: omlxApiKey } : {}),
    },
    lmstudio: {
      baseUrl: parsed.LMSTUDIO_BASE_URL ?? parsed.OPENAI_BASE_URL ?? "http://localhost:1234/v1",
      ...(lmstudioApiKey ? { apiKey: lmstudioApiKey } : {}),
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
    modelArmor: {
      enabled: parsed.MODEL_ARMOR_ENABLED !== "false",
      projectId:
        parsed.MODEL_ARMOR_PROJECT_ID ??
        process.env.GOOGLE_CLOUD_PROJECT ??
        process.env.GCP_PROJECT,
      location: parsed.MODEL_ARMOR_LOCATION,
      templateId: parsed.MODEL_ARMOR_TEMPLATE_ID,
      ...(parsed.MODEL_ARMOR_API_KEY ? { apiKey: parsed.MODEL_ARMOR_API_KEY } : {}),
      ...(parsed.MODEL_ARMOR_API_ENDPOINT ? { apiEndpoint: parsed.MODEL_ARMOR_API_ENDPOINT } : {}),
      ...(parsed.MODEL_ARMOR_CREDENTIALS_JSON
        ? { credentialsJson: parsed.MODEL_ARMOR_CREDENTIALS_JSON }
        : {}),
      ...(parsed.MODEL_ARMOR_CREDENTIALS_BASE64
        ? { credentialsBase64: parsed.MODEL_ARMOR_CREDENTIALS_BASE64 }
        : {}),
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
    tavily: {
      ...(parsed.TAVILY_API_KEY ? { apiKey: parsed.TAVILY_API_KEY } : {}),
      mcpUrl: parsed.TAVILY_MCP_URL,
    },
    gemini: {
      ...(parsed.GEMINI_API_KEY || process.env.GEMINI_API_KEY
        ? { apiKey: parsed.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY }
        : {}),
      ...(parsed.GEMINI_BASE_URL ? { baseUrl: parsed.GEMINI_BASE_URL } : {}),
      liveModel: parsed.GEMINI_LIVE_MODEL,
      thinkingLevel: parsed.GEMINI_LIVE_THINKING_LEVEL,
      voice: parsed.GEMINI_VOICE,
    },
  };
}
