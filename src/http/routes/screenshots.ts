import { Elysia, t } from "elysia";
import { log } from "../../core/logger";
import { getRecentScreenshots, describeScreenshots } from "../../tools/photos";
import { OsxPhotosError } from "../../utils/osxPhotos";
import {
  classifyRecentScreenshots,
  ingestRecentScreenshots,
} from "../../workflows/screenshotIngestion";

export const screenshotRoutes = new Elysia({ name: "routes.screenshots" })
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

      try {
        return await classifyRecentScreenshots({ hoursBack, fromTime, limit });
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
          quarantined: t.Number(),
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

      try {
        return await ingestRecentScreenshots({ hoursBack, fromTime, limit });
      } catch (err) {
        log.error("GET /screenshots/ingest failed", {
          hoursBack: hoursBack ?? "unset",
          fromTime: fromTime ?? "unset",
          limit: limit ?? "unset",
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof OsxPhotosError ? { stderr: err.stderr } : {}),
        });
        set.status = 502;
        return {
          error: err instanceof Error ? err.message : "Screenshot ingestion failed",
        };
      }
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
          quarantined: t.Number(),
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
                  t.Literal("quarantined"),
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
  );
