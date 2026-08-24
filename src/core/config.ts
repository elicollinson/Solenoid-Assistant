import { z } from "zod";

const optionalEnvString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional(),
);

const runtimeConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
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
  PHOENIX_TRACING_ENABLED: optionalEnvString.default("true"),
  PHOENIX_COLLECTOR_ENDPOINT: optionalEnvString.default("http://localhost:6006"),
  PHOENIX_PROJECT_NAME: optionalEnvString.default("solenoid-assistant"),
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
  phoenix: {
    enabled: boolean;
    collectorEndpoint: string;
    projectName: string;
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
    phoenix: {
      enabled: parsed.PHOENIX_TRACING_ENABLED !== "false",
      collectorEndpoint: parsed.PHOENIX_COLLECTOR_ENDPOINT,
      projectName: parsed.PHOENIX_PROJECT_NAME,
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
