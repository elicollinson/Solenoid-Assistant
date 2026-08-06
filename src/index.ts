// Register the tracer provider before any agent handles a request. (ESM
// hoists imports, so agent modules load first — fine, since spans are only
// created at call time and the tracer is resolved lazily.)
import { initTracing, shutdownTracing } from "./core/tracing";
initTracing();
import { Ollama } from "ollama";
import { Elysia, t } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { demoAgentGG } from "./agents/demo";
import { createImessageIntakeAgent } from "./agents/imessageIntake";
import { okfManagerAgent } from "./agents/okfManager";
import { Agent } from "./core/rawAgent";
import { fanout, fulfilled, rejected } from "./utils/fanout";
import { chunkWords } from "./utils/chunkWords";
import { log } from "./core/logger";

import {
  weatherPrompt,
  imessageIntakePrompt,
  memoryGraderPrompt,
  memoryGraderSystemPrompt,
  injectionRiskPrompt,
  classifier,
  contentCardSchema,
} from "./prompts";
import {
  tasks,
  getTask,
  runTask,
  TaskArgsError,
  loadTasksConfig,
} from "./tasks";
import {
  imessageIntakeSchema,
  memoryGraderSchema,
  injectionRiskSchema,
  okfManagerResultSchema,
  ClassificationResultSchema,
  recommendationIngestionSchema,
} from "./prompts";
import type {
  ClassificationResult,
  ContentCard,
  RecommendationIngestionInput,
  RecommendationIngestionResult,
} from "./prompts";
import { recommendationIngestionInputSchema } from "./prompts";
import { injectionRiskClassifier } from "./agents/safetyClassifier";
import { createContentCardSourcingAgent } from "./agents/contentCardSourcing";
import { createClassifierAgent } from "./agents/classifier";
import { createRecommendationIngestionAgent } from "./agents/recommendationIngestion";
import type { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { initNotionMcpCache } from "./mcp/notionCache";
import { getRecentScreenshots, describeScreenshots, classifyScreenshots } from "./tools/photos";
import { OsxPhotosError } from "./utils/osxPhotos";
import {
  loadProcessed,
  saveProcessed,
  markAsIngested,
} from "./utils/screenshotsProcessed";

const PORT = Number(process.env.PORT ?? 3000);

// Eagerly connect to Notion MCP at startup, call `notion-fetch` to verify the
// workspace, and cache the client for reuse by agents. Non-fatal: if Notion
// isn't configured the app still starts; agents that need Notion will fail at
// call time with a clear message.
await initNotionMcpCache().catch((err) => {
  log.warn("Notion MCP cache init failed — Notion-dependent agents will error at call time", {
    error: err instanceof Error ? err.message : String(err),
  });
});

// Average concern score above which the input is flagged as a likely prompt
// injection attack. The per-chunk score is 0–1, so 0.5 is the midpoint.
const INJECTION_FLAG_THRESHOLD = 0.5;

// A memory passes grading when the average of its relevance and actionability
// scores (each 0–10) exceeds this. Matches the "above 7" rule the grader
// prompt used to delegate to the model via the calculate tool.
const MEMORY_PASS_THRESHOLD = 7;

// Map a screenshot classification to the recommendation ingestion `collection`
// value. "Rejected" never reaches here — it's filtered out before ingestion.
function classificationToCollection(
  classification: ClassificationResult["classification"],
): RecommendationIngestionInput["collection"] {
  switch (classification) {
    case "Book":
      return "book";
    case "Movie":
      return "movie";
    case "TV Show":
      return "tv";
    case "Game":
      return "game";
    case "Music":
      return "music";
    default:
      throw new Error(`Unmappable classification: ${classification}`);
  }
}

// Schedule config is display/default-args only here — the worker process
// (src/worker.ts) owns actual scheduling and re-reads the file on its own
// startup.
const tasksConfig = await loadTasksConfig();

const app = new Elysia({
  // Agent endpoints run 30-50s before writing any response bytes, which trips
  // Elysia's default 30s idleTimeout (Bun closes the socket and clients
  // silently retry the GET, re-running the whole agent). 0 disables it.
  serve: { idleTimeout: 255 },
})
  .use(
    openapi({
      documentation: {
        info: {
          title: "Manual Personal Assistant API",
          version: "0.1.0",
        },
      },
    }),
  )
  .get("/health", () => ({ status: "ok" as const }), {
    detail: { summary: "Health check" },
    response: t.Object({ status: t.Literal("ok") }),
  })
  .get(
    "/screenshots",
    async ({ query, set }) => {
      const hoursBack = query.hoursBack;
      const fromTime = query.fromTime;

      if (fromTime) {
        const parsed = new Date(fromTime);
        if (Number.isNaN(parsed.getTime())) {
          set.status = 400;
          return { error: `Invalid fromTime: "${fromTime}" is not a parseable date/time` };
        }
      }

      try {
        const result = await getRecentScreenshots({
          hoursBack,
          fromTime,
        });
        return result;
      } catch (err) {
        log.error(`GET /screenshots failed`, {
          hoursBack: hoursBack ?? "unset",
          fromTime: fromTime ?? "unset",
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof OsxPhotosError ? { stderr: err.stderr } : {}),
        });
        set.status = 502;
        if (err instanceof OsxPhotosError) {
          return { error: err.message };
        }
        return {
          error: err instanceof Error ? err.message : "Screenshot query failed",
        };
      }
    },
    {
      detail: {
        summary:
          "List screenshots from the local macOS Photos library (default: last 24 hours)",
      },
      query: t.Object({
        hoursBack: t.Optional(
          t.Number({
            minimum: 1,
            maximum: 24 * 30,
            description:
              "How far back to look, in hours (default 24, max 720). Ignored when fromTime is set.",
          }),
        ),
        fromTime: t.Optional(
          t.String({
            description:
              "Window start (inclusive), any parseable ISO 8601 date/time, e.g. 2026-07-20T14:30:00Z. Overrides hoursBack.",
          }),
        ),
      }),
      response: {
        200: t.Object({
          windowStart: t.String(),
          windowEnd: t.String(),
          returned: t.Number(),
          totalInWindow: t.Number(),
          screenshots: t.Array(
            t.Object({
              uuid: t.String(),
              filename: t.String(),
              date: t.String(),
              width: t.Number(),
              height: t.Number(),
              path: t.Nullable(t.String()),
              isMissing: t.Boolean(),
            }),
          ),
        }),
        400: t.Object({ error: t.String() }),
        502: t.Object({ error: t.String() }),
      },
    },
  )
  .get(
    "/screenshots/describe",
    async ({ query, set }) => {
      const hoursBack = query.hoursBack;
      const fromTime = query.fromTime;
      const limit = query.limit;

      if (fromTime) {
        const parsed = new Date(fromTime);
        if (Number.isNaN(parsed.getTime())) {
          set.status = 400;
          return { error: `Invalid fromTime: "${fromTime}" is not a parseable date/time` };
        }
      }

      try {
        const result = await describeScreenshots({
          hoursBack,
          fromTime,
          limit,
        });
        return result;
      } catch (err) {
        log.error(`GET /screenshots/describe failed`, {
          hoursBack: hoursBack ?? "unset",
          fromTime: fromTime ?? "unset",
          limit: limit ?? "unset",
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof OsxPhotosError ? { stderr: err.stderr } : {}),
        });
        set.status = 502;
        if (err instanceof OsxPhotosError) {
          return { error: err.message };
        }
        return {
          error: err instanceof Error ? err.message : "Screenshot description failed",
        };
      }
    },
    {
      detail: {
        summary:
          "Retrieve recent screenshots and describe each with a vision model. Returns structured descriptions (app, summary, prominent text) per screenshot.",
      },
      query: t.Object({
        hoursBack: t.Optional(
          t.Number({
            minimum: 1,
            maximum: 24 * 30,
            description:
              "How far back to look, in hours (default 24, max 720). Ignored when fromTime is set.",
          }),
        ),
        fromTime: t.Optional(
          t.String({
            description:
              "Window start (inclusive), any parseable ISO 8601 date/time, e.g. 2026-07-20T14:30:00Z. Overrides hoursBack.",
          }),
        ),
        limit: t.Optional(
          t.Number({
            minimum: 1,
            maximum: 500,
            description:
              "Maximum screenshots to process (default 50 — vision calls are expensive).",
          }),
        ),
      }),
      response: {
        200: t.Object({
          windowStart: t.String(),
          windowEnd: t.String(),
          returned: t.Number(),
          totalInWindow: t.Number(),
          failed: t.Number(),
          screenshots: t.Array(
            t.Object({
              uuid: t.String(),
              filename: t.String(),
              date: t.String(),
              path: t.String(),
              description: t.Nullable(
                t.Object({
                  app: t.String(),
                  summary: t.String(),
                  prominentText: t.Array(t.String()),
                }),
              ),
              error: t.Optional(t.String()),
            }),
          ),
        }),
        400: t.Object({ error: t.String() }),
        502: t.Object({ error: t.String() }),
      },
    },
  )
  .get(
    "/screenshots/classify",
    async ({ query, set }) => {
      const hoursBack = query.hoursBack;
      const fromTime = query.fromTime;
      const limit = query.limit;

      if (fromTime) {
        const parsed = new Date(fromTime);
        if (Number.isNaN(parsed.getTime())) {
          set.status = 400;
          return { error: `Invalid fromTime: "${fromTime}" is not a parseable date/time` };
        }
      }

      // Create classifier agent with Tavily MCP for web search.
      let classifierMcpClient: McpClient | undefined;
      try {
        const classifierResult = await createClassifierAgent();
        classifierMcpClient = classifierResult.mcpClient;

        const result = await classifyScreenshots(classifierResult.agent, {
          hoursBack,
          fromTime,
          limit,
        });

        return {
          windowStart: result.windowStart,
          windowEnd: result.windowEnd,
          returned: result.returned,
          totalInWindow: result.totalInWindow,
          failed: result.failed,
          screenshots: result.screenshots.map((s) => ({
            uuid: s.uuid,
            filename: s.filename,
            date: s.date,
            path: s.path,
            classification: s.classification,
            error: s.error,
          })),
        };
      } catch (err) {
        log.error(`GET /screenshots/classify failed`, {
          hoursBack: hoursBack ?? "unset",
          fromTime: fromTime ?? "unset",
          limit: limit ?? "unset",
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof OsxPhotosError ? { stderr: err.stderr } : {}),
        });
        set.status = 502;
        if (err instanceof OsxPhotosError) {
          return { error: err.message };
        }
        return {
          error: err instanceof Error ? err.message : "Screenshot classification failed",
        };
      } finally {
        classifierMcpClient?.close();
      }
    },
    {
      detail: {
        summary:
          "Retrieve recent screenshots and classify each with a vision model. Returns a classification (Book, Movie, TV Show, Game, Music, or Rejected) per screenshot.",
      },
      query: t.Object({
        hoursBack: t.Optional(
          t.Number({
            minimum: 1,
            maximum: 24 * 30,
            description:
              "How far back to look, in hours (default 24, max 720). Ignored when fromTime is set.",
          }),
        ),
        fromTime: t.Optional(
          t.String({
            description:
              "Window start (inclusive), any parseable ISO 8601 date/time, e.g. 2026-07-20T14:30:00Z. Overrides hoursBack.",
          }),
        ),
        limit: t.Optional(
          t.Number({
            minimum: 1,
            maximum: 500,
            description:
              "Maximum screenshots to process (default 50 — vision calls are expensive).",
          }),
        ),
      }),
      response: {
        200: t.Object({
          windowStart: t.String(),
          windowEnd: t.String(),
          returned: t.Number(),
          totalInWindow: t.Number(),
          failed: t.Number(),
          screenshots: t.Array(
            t.Object({
              uuid: t.String(),
              filename: t.String(),
              date: t.String(),
              path: t.String(),
              classification: t.Nullable(
                t.Object({
                  classification: t.Union([
                    t.Literal("Book"),
                    t.Literal("Movie"),
                    t.Literal("TV Show"),
                    t.Literal("Game"),
                    t.Literal("Music"),
                    t.Literal("Rejected"),
                  ]),
                  name: t.String({
                    description:
                      "The name of the entity in the screenshot, or Unknown.",
                  }),
                }),
              ),
              error: t.Optional(t.String()),
            }),
          ),
        }),
        400: t.Object({ error: t.String() }),
        502: t.Object({ error: t.String() }),
      },
    },
  )
  .get(
    "/screenshots/ingest",
    async ({ query, set }) => {
      const hoursBack = query.hoursBack;
      const fromTime = query.fromTime;
      const limit = query.limit;

      if (fromTime) {
        const parsed = new Date(fromTime);
        if (Number.isNaN(parsed.getTime())) {
          set.status = 400;
          return { error: `Invalid fromTime: "${fromTime}" is not a parseable date/time` };
        }
      }

      // --- Phase 1a: create classifier agent (needs Tavily MCP) ------------
      let classifierMcpClient: McpClient | undefined;
      let classifierAgent: Agent | undefined;

      try {
        const classifierResult = await createClassifierAgent();
        classifierMcpClient = classifierResult.mcpClient;
        classifierAgent = classifierResult.agent;
      } catch (err) {
        log.error(`GET /screenshots/ingest — classifier agent creation failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
        set.status = 502;
        return {
          error: `Failed to create classifier agent: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // --- Phase 1b: classify screenshots (vision + web search) ------------
      let classifyResult;
      try {
        classifyResult = await classifyScreenshots(classifierAgent, {
          hoursBack,
          fromTime,
          limit,
        });
      } catch (err) {
        classifierMcpClient?.close();
        log.error(`GET /screenshots/ingest — classify phase failed`, {
          hoursBack: hoursBack ?? "unset",
          fromTime: fromTime ?? "unset",
          limit: limit ?? "unset",
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof OsxPhotosError ? { stderr: err.stderr } : {}),
        });
        set.status = 502;
        if (err instanceof OsxPhotosError) return { error: err.message };
        return {
          error: err instanceof Error ? err.message : "Screenshot classification failed",
        };
      }

      // --- Phase 2: create agents (one each, reused for every screenshot) ---
      // Tavily MCP client is per-request and must be closed when done. The
      // Notion MCP client comes from the shared startup cache and must NOT be
      // closed here.
      let tavilyMcpClient: McpClient | undefined;
      let contentCardAgent: Agent | undefined;
      let recommendationAgent: Agent | undefined;

      try {
        const tavily = await createContentCardSourcingAgent();
        tavilyMcpClient = tavily.mcpClient;
        contentCardAgent = tavily.agent;

        const notion = await createRecommendationIngestionAgent();
        recommendationAgent = notion.agent;
      } catch (err) {
        tavilyMcpClient?.close();
        log.error(`GET /screenshots/ingest — agent creation failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
        set.status = 502;
        return {
          error: `Failed to create ingestion agents: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // --- Phase 3: per-screenshot pipeline (sequential) -------------------
      // Sequential (not Promise.all) because both MCP clients are single
      // HTTP connections; concurrent callTool requests on the same transport
      // can interleave and corrupt the response stream.
      const processed = await loadProcessed();
      let dirty = false;

      const screenshots = [];
      for (const s of classifyResult.screenshots) {
        const classification = s.classification;

        const base = {
          uuid: s.uuid,
          filename: s.filename,
          date: s.date,
          path: s.path,
          classification: classification
            ? {
                classification: classification.classification,
                name: classification.name,
              }
            : null,
          contentCard: null as ContentCard | null,
          ingestion: null as RecommendationIngestionResult | null,
        };

        // Vision failed for this screenshot — nothing to ingest.
        if (!classification) {
          screenshots.push({
            ...base,
            status: "skipped" as const,
            error: s.error,
          });
          continue;
        }

        // Already ingested in a previous run — skip to avoid duplicates.
        const existing = processed[s.uuid];
        if (existing) {
          screenshots.push({
            ...base,
            status: "skipped" as const,
            error: `Already ingested on ${existing.ingestedAt} as "${classification.classification}: ${classification.name}"`,
          });
          continue;
        }

        // Classifier rejected it — skip ingestion entirely.
        if (classification.classification === "Rejected") {
          screenshots.push({
            ...base,
            status: "rejected" as const,
          });
          continue;
        }

        // No usable name — the content card sourcing agent would search
        // for "Unknown" and get garbage.
        if (!classification.name.trim() || classification.name === "Unknown") {
          screenshots.push({
            ...base,
            status: "skipped" as const,
            error: "Classifier returned an empty or Unknown name",
          });
          continue;
        }

        // Step 3a: source the content card.
        let card: ContentCard;
        try {
          card = (await contentCardAgent.run(
            classification.name,
            contentCardSchema,
          )) as ContentCard;
        } catch (err) {
          screenshots.push({
            ...base,
            status: "failed" as const,
            error: `Content card sourcing failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }

        // Step 3b: ingest into Notion.
        const collection = classificationToCollection(classification.classification);
        const ingestionInput: RecommendationIngestionInput = {
          name: card.name,
          url: card.url,
          description: card.description || undefined,
          image_url: card.coverImageUrl || undefined,
          collection,
        };

        try {
          const ingestionResult = (await recommendationAgent.run(
            JSON.stringify(ingestionInput),
            recommendationIngestionSchema,
          )) as RecommendationIngestionResult;

          if (ingestionResult.status !== "error") {
            // Mark as ingested so future runs skip this UUID.
            markAsIngested(processed, s.uuid, classification.classification, classification.name);
            dirty = true;
          }

          screenshots.push({
            ...base,
            contentCard: card,
            ingestion: ingestionResult,
            status: ingestionResult.status === "error" ? "failed" as const : "ingested" as const,
            error: ingestionResult.error ?? undefined,
          });
        } catch (err) {
          screenshots.push({
            ...base,
            contentCard: card,
            status: "failed" as const,
            error: `Recommendation ingestion failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      // Always close the Tavily MCP client — the Notion client is shared.
      tavilyMcpClient?.close();

      // Persist the updated processed map.
      if (dirty) {
        await saveProcessed(processed);
      }

      return {
        windowStart: classifyResult.windowStart,
        windowEnd: classifyResult.windowEnd,
        returned: classifyResult.returned,
        totalInWindow: classifyResult.totalInWindow,
        failed: classifyResult.failed,
        screenshots,
      };
    },
    {
      detail: {
        summary:
          "Classify recent screenshots, source a content card for each non-rejected item, and ingest it into the Notion gallery database. Returns the per-screenshot ingestion status.",
      },
      query: t.Object({
        hoursBack: t.Optional(
          t.Number({
            minimum: 1,
            maximum: 24 * 30,
            description:
              "How far back to look, in hours (default 24, max 720). Ignored when fromTime is set.",
          }),
        ),
        fromTime: t.Optional(
          t.String({
            description:
              "Window start (inclusive), any parseable ISO 8601 date/time, e.g. 2026-07-20T14:30:00Z. Overrides hoursBack.",
          }),
        ),
        limit: t.Optional(
          t.Number({
            minimum: 1,
            maximum: 500,
            description:
              "Maximum screenshots to process (default 50 — vision + web + Notion calls are expensive).",
          }),
        ),
      }),
      response: {
        200: t.Object({
          windowStart: t.String(),
          windowEnd: t.String(),
          returned: t.Number(),
          totalInWindow: t.Number(),
          failed: t.Number(),
          screenshots: t.Array(
            t.Object({
              uuid: t.String(),
              filename: t.String(),
              date: t.String(),
              path: t.String(),
              classification: t.Nullable(
                t.Object({
                  classification: t.Union([
                    t.Literal("Book"),
                    t.Literal("Movie"),
                    t.Literal("TV Show"),
                    t.Literal("Game"),
                    t.Literal("Music"),
                    t.Literal("Rejected"),
                  ]),
                  name: t.String(),
                }),
              ),
              contentCard: t.Nullable(
                t.Object({
                  name: t.String(),
                  type: t.Union([
                    t.Literal("Game"),
                    t.Literal("Musician"),
                    t.Literal("Movie"),
                    t.Literal("TV Show"),
                    t.Literal("Song"),
                    t.Literal("Album"),
                    t.Literal("Book"),
                  ]),
                  description: t.String(),
                  coverImageUrl: t.String(),
                  url: t.String(),
                }),
              ),
              ingestion: t.Nullable(
                t.Object({
                  status: t.Union([
                    t.Literal("created"),
                    t.Literal("updated"),
                    t.Literal("error"),
                  ]),
                  match: t.Union([
                    t.Literal("exact"),
                    t.Literal("none"),
                    t.Literal("unsure"),
                    t.Null(),
                  ]),
                  page_id: t.Union([t.String(), t.Null()]),
                  page_url: t.Union([t.String(), t.Null()]),
                  warnings: t.Array(t.String()),
                  error: t.Union([t.String(), t.Null()]),
                }),
              ),
              status: t.Union([
                t.Literal("ingested"),
                t.Literal("rejected"),
                t.Literal("failed"),
                t.Literal("skipped"),
              ]),
              error: t.Optional(t.String()),
            }),
          ),
        }),
        400: t.Object({ error: t.String() }),
        502: t.Object({ error: t.String() }),
      },
    },
  )
  .post(
    "/agent",
    async ({ body, set }) => {
      const city = body.city.trim();
      if (!city) {
        set.status = 400;
        return { error: 'Missing "city" field' };
      }

      try {
        const response = await demoAgentGG.run(weatherPrompt, { city });
        return { city, response };
      } catch (err) {
        set.status = 502;
        return {
          error: err instanceof Error ? err.message : "Agent call failed",
        };
      }
    },
    {
      detail: { summary: "Get weather for a city via the demo agent" },
      body: t.Object({
        city: t.String({
          minLength: 1,
          description: "City to get weather for",
        }),
      }),
      response: {
        200: t.Object({
          city: t.String(),
          response: t.String(),
        }),
        400: t.Object({ error: t.String() }),
        502: t.Object({ error: t.String() }),
      },
    },
  )
  .post(
    "/content-card",
    async ({ body, set }) => {
      const query = body.query.trim();
      if (!query) {
        set.status = 400;
        return { error: 'Missing "query" field' };
      }

      let mcpClient: McpClient | undefined;
      try {
        const { agent, mcpClient: client } = await createContentCardSourcingAgent();
        mcpClient = client;
        const card = await agent.run(query, contentCardSchema) as ContentCard;
        return { query, ...card };
      } catch (err) {
        log.error(`POST /content-card failed`, {
          query,
          error: err instanceof Error ? err.message : String(err),
        });
        set.status = 502;
        return {
          error: err instanceof Error ? err.message : "Content card sourcing failed",
        };
      } finally {
        // Close the MCP connection so we don't leak the remote socket.
        mcpClient?.close();
      }
    },
    {
      detail: {
        summary:
          "Source a content card for a media item (Game, Musician, Movie, TV Show, Song, Album, or Book) using live web search via Tavily MCP.",
      },
      body: t.Object({
        query: t.String({
          minLength: 1,
          description:
            "The name of the media item to look up, e.g. 'The Witcher 3', 'Radiohead', 'The Matrix'.",
        }),
      }),
      response: {
        200: t.Object({
          query: t.String(),
          name: t.String(),
          type: t.Union([
            t.Literal("Game"),
            t.Literal("Musician"),
            t.Literal("Movie"),
            t.Literal("TV Show"),
            t.Literal("Song"),
            t.Literal("Album"),
            t.Literal("Book"),
          ]),
          description: t.String(),
          coverImageUrl: t.String(),
          url: t.String(),
        }),
        400: t.Object({ error: t.String() }),
        502: t.Object({ error: t.String() }),
      },
    },
  ).get(
    "/tasks",
    () =>
      [...tasks.values()].map((task) => ({
        task: task.name,
        description: task.description,
        schedules: tasksConfig.tasks
          .filter((s) => s.task === task.name)
          .map(({ name, cron, timezone, enabled, args }) => ({
            name,
            cron,
            timezone,
            enabled,
            args,
          })),
      })),
    {
      detail: { summary: "List registered tasks and their cron schedules" },
      response: t.Array(
        t.Object({
          task: t.String(),
          description: t.String(),
          schedules: t.Array(
            t.Object({
              name: t.String(),
              cron: t.String(),
              timezone: t.Optional(t.String()),
              enabled: t.Boolean(),
              args: t.Record(t.String(), t.Unknown()),
            }),
          ),
        }),
      ),
    },
  )
  .post(
    "/tasks/:name/run",
    async ({ params, body, set }) => {
      const name = params.name;
      if (!getTask(name)) {
        set.status = 404;
        return { error: `Unknown task "${name}"` };
      }

      // Explicit args win; otherwise fall back to the first enabled schedule
      // for this task in tasks.yaml, so a bare POST tests the cron config.
      const args =
        body?.args ??
        tasksConfig.tasks.find((s) => s.task === name && s.enabled)?.args ??
        {};

      try {
        const result = await runTask(name, args);
        return { task: name, ...result };
      } catch (err) {
        if (err instanceof TaskArgsError) {
          set.status = 400;
          return { error: err.message };
        }
        set.status = 502;
        return {
          error: err instanceof Error ? err.message : "Task run failed",
        };
      }
    },
    {
      detail: { summary: "Run a scheduled task by name and return its output" },
      params: t.Object({
        name: t.String({ description: 'Registered task name, e.g. "weather"' }),
      }),
      body: t.Optional(
        t.Object({
          args: t.Optional(
            t.Unknown({ description: "Overrides the args from tasks.yaml" }),
          ),
        }),
      ),
      response: {
        200: t.Object({
          task: t.String(),
          startedAt: t.String(),
          durationMs: t.Number(),
          output: t.Unknown(),
        }),
        400: t.Object({ error: t.String() }),
        404: t.Object({ error: t.String() }),
        502: t.Object({ error: t.String() }),
      },
    },
  )
  .get(
    "/messageExtraction",
    async ({ query, set }) => {
      // Optional extraction window. Anything Date.parse accepts is allowed
      // (date-only strings included) and normalized to ISO UTC before being
      // handed to the agent, so the model always sees unambiguous timestamps.
      // Omitted bounds keep the default behavior (last 24 hours, ending now).
      const start = query.start ? new Date(query.start) : undefined;
      const end = query.end ? new Date(query.end) : undefined;
      if (start && Number.isNaN(start.getTime())) {
        set.status = 400;
        return { error: `Invalid start: "${query.start}" is not a parseable date/time` };
      }
      if (end && Number.isNaN(end.getTime())) {
        set.status = 400;
        return { error: `Invalid end: "${query.end}" is not a parseable date/time` };
      }
      if (start && end && start >= end) {
        set.status = 400;
        return {
          error: `Invalid range: start (${start.toISOString()}) must be before end (${end.toISOString()})`,
        };
      }
      try {
        // Per-request agent: with a range, the read tool is constructed with
        // the window baked into its closure and exposes no time parameters —
        // the range is enforced structurally, not requested via the prompt.
        // Without one, the tool is the model-driven default (last 24 hours).
        const intakeAgent = createImessageIntakeAgent(
          start || end ? { start, end } : undefined,
        );
        const extractedResponse = await intakeAgent.run(
          imessageIntakePrompt({ start: start?.toISOString(), end: end?.toISOString() }),
          imessageIntakeSchema,
        );
        const memoryGraderAgent = new Agent({
          client: new Ollama({
            host: process.env.OLLAMA_API_URL || "https://ollama.com",
            headers: {
              Authorization: `Bearer ${process.env.OLLAMA_API_KEY || ""}`,
            },
          }),
          model: process.env.MODEL || "glm-5.2",
          systemPrompt: memoryGraderSystemPrompt,
          // Deliberately toolless: giving the grader `calculate` for the
          // average created a post-tool-result turn, which is exactly where
          // glm-5.2:cloud emitted its verdict into the reasoning channel and
          // returned empty content. The average is computed below instead.
        });

        const gradedMemories = await fanout(
          extractedResponse.memoryContext.map((memory) => ({ output: memory })),
          memoryGraderAgent,
          memoryGraderPrompt,
          memoryGraderSchema,
          8,
        );
        // A grade that failed is not a pass: an ungradeable memory is withheld
        // rather than trusted, but it no longer takes the whole request down.
        const gradeFailures = rejected(gradedMemories);
        if (gradeFailures.length > 0) {
          log.warn(
            `memoryExtraction: ${gradeFailures.length}/${gradedMemories.length} memory grades failed; ` +
              `withholding those memories. First error: ${gradeFailures[0]?.message}`,
          );
        }
        const validatedMemories = extractedResponse.memoryContext.filter((_, i) => {
          const graded = gradedMemories[i];
          if (graded?.status !== "fulfilled") return false;
          // Pass/fail lives here, not in the model: averaging two numbers is
          // deterministic work, and asking the model for it (via a calculate
          // tool) was both slower and the trigger for blank structured replies.
          const { memoryRelevance, memoryActionability } = graded.value;
          return (memoryRelevance + memoryActionability) / 2 > MEMORY_PASS_THRESHOLD;
        });

        let memString = "";

        validatedMemories.forEach((mem) => {
          memString += `- ${mem}\n`;
        });

        let okfUpdate;
        if (validatedMemories.length > 0) {
          // Awaited so the resolved value (not a pending Promise) is serialized
          // and so a rejection is caught below as a 502 rather than escaping as
          // an unhandled rejection.
          okfUpdate = await okfManagerAgent.run(
            `Update the okf with these memories: ${memString}`,
            okfManagerResultSchema,
          );
        }

        return {
          ...extractedResponse,
          memoryContext: validatedMemories,
          okfUpdate: okfUpdate || "none",
        };
      } catch (err) {
        set.status = 502;
        return {
          error: err instanceof Error ? err.message : "Agent call failed",
        };
      }
    },
    {
      detail: {
        summary:
          "Extract action items from iMessage conversations, optionally within a date/time range (default: last 24 hours)",
      },
      query: t.Object({
        start: t.Optional(
          t.String({
            description:
              "Window start (inclusive), any parseable date/time, e.g. 2026-07-20 or 2026-07-20T09:00:00Z. Default: 24 hours before end.",
          }),
        ),
        end: t.Optional(
          t.String({
            description: "Window end (inclusive), any parseable date/time. Default: now.",
          }),
        ),
      }),
      response: {
        200: t.Object({
          actionItems: t.Array(t.String()),
          conversationSummaries: t.Array(t.String()),
          memoryContext: t.Array(t.String()),
          // The awaited okfManager result, or the string "none" when no memory
          // passed grading and no update was attempted.
          okfUpdate: t.Unknown(),
        }),
        400: t.Object({ error: t.String() }),
        502: t.Object({ error: t.String() }),
      },
    },
  )
  .post(
    "/safetyClassifier",
    async ({ body, set }) => {
      try {
        const fullInput = body.input;

        const chunks = chunkWords(fullInput, body.maxLength);
        console.log("safetyClassifier chunks:", chunks);

        const evaluations = await fanout(
          chunks.map((text) => ({ text })),
          injectionRiskClassifier,
          injectionRiskPrompt,
          injectionRiskSchema,
          8,
        );

        const scored = fulfilled(evaluations);
        const failures = rejected(evaluations);
        if (failures.length > 0) {
          log.warn(
            `safetyClassifier: ${failures.length}/${evaluations.length} chunk classifications failed; ` +
              `scoring on the remainder. First error: ${failures[0]?.message}`,
          );
        }
        // Never report "not flagged" off the back of zero successful
        // classifications — an unscored chunk is an unknown, not a safe one, so
        // total failure has to surface as an error rather than a clean verdict.
        if (scored.length === 0) {
          set.status = 502;
          return {
            error: `All ${evaluations.length} chunk classifications failed: ${failures[0]?.message ?? "unknown error"}`,
          };
        }

        // Use the single highest-scoring chunk as the representative
        // result — it's the strongest injection signal in the input.
        const highestConfidence = scored.reduce((best, e) =>
          e.concernScore > best.concernScore ? e : best,
        );

        const flagged =
          highestConfidence.concernScore > INJECTION_FLAG_THRESHOLD;

        return {
          flagged,
          concern: highestConfidence.rationale,
          score: highestConfidence.concernScore,
        };
      } catch (err) {
        set.status = 502;
        return {
          error: err instanceof Error ? err.message : "Agent call failed",
        };
      }
    },
    {
      detail: { summary: "Classify input text for safety concerns" },
      body: t.Object({
        input: t.String({
          minLength: 1,
          description: "Input text to classify",
        }),
        maxLength: t.Number({
          minimum: 2,
          description: "Maximum number of words per random-length chunk",
        }),
      }),
      response: {
        200: t.Object({
          flagged: t.Boolean(),
          concern: t.String(),
          score: t.Number(),
        }),
        502: t.Object({ error: t.String() }),
      },
    },
  )
  .listen(PORT);

console.log(`Service listening on http://localhost:${app.server?.port}`);
console.log(`API docs at http://localhost:${app.server?.port}/openapi`);

// Flush queued spans (batch exporter) before the process exits.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await shutdownTracing();
    process.exit(0);
  });
}
