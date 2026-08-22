import { z } from "zod";

const optionalEnvString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional(),
);

const runtimeConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  MODEL: optionalEnvString.default("glm-5.2"),
  IMAGE_MODEL: optionalEnvString,
  OLLAMA_API_URL: optionalEnvString.default("https://ollama.com"),
  OLLAMA_API_KEY: optionalEnvString,
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
  model: string;
  imageModel: string;
  ollama: {
    host: string;
    apiKey?: string;
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

export function loadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const parsed = runtimeConfigSchema.parse(env);
  return {
    port: parsed.PORT,
    model: parsed.MODEL,
    imageModel: parsed.IMAGE_MODEL ?? parsed.MODEL,
    ollama: {
      host: parsed.OLLAMA_API_URL,
      ...(parsed.OLLAMA_API_KEY ? { apiKey: parsed.OLLAMA_API_KEY } : {}),
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
