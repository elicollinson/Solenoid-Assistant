import { z } from "zod";
import { defineTool } from "../core/tools";
import {
  queryScreenshots,
  materialize,
  type PhotoRecord,
} from "../utils/osxPhotos";
import {
  describeImage,
  mapWithConcurrency,
  type VisionOptions,
} from "../utils/vision";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { log } from "../core/logger";

/**
 * Format a Date as osxphotos expects for `--from-date` / `--to-date`:
 * `YYYY-MM-DDTHH:MM:SS`, local time, no timezone suffix. osxphotos interprets
 * bare date-times as local, which is what we want — "last 24 hours" should be
 * wall-clock-relative, not UTC-relative.
 */
function localIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Trim a PhotoRecord down to what the model needs to reason about a screenshot. */
function summarize(r: PhotoRecord) {
  return {
    uuid: r.uuid,
    filename: r.original_filename || r.filename,
    date: r.date,
    width: r.width,
    height: r.height,
    path: r.path,
    isMissing: r.ismissing,
  };
}

export interface ScreenshotSummary {
  uuid: string;
  filename: string;
  date: string;
  width: number;
  height: number;
  path: string | null;
  isMissing: boolean;
}

export interface RecentScreenshotsResult {
  windowStart: string;
  windowEnd: string;
  returned: number;
  totalInWindow: number;
  screenshots: ScreenshotSummary[];
}

export interface RecentScreenshotsParams {
  /** How far back to look, in hours. Default 24. Ignored when fromTime is set. */
  hoursBack?: number;
  /** Window start as an ISO 8601 timestamp. Overrides hoursBack. */
  fromTime?: string;
  /** Cap on results. Default 100. */
  limit?: number;
}

/**
 * Fetch screenshots from the local macOS Photos library within a recent time
 * window. This is the plain-method entry point — the tool below delegates
 * here, and you can also call it directly when you don't need the tool layer.
 *
 * Equivalent CLI:
 *   osxphotos query --json --screenshot --not-syndicated --not-shared \
 *     --not-hidden --from-date "<localIso(start)>"
 */
export async function getRecentScreenshots(
  params: RecentScreenshotsParams = {},
): Promise<RecentScreenshotsResult> {
  const { hoursBack = 24, fromTime, limit = 100 } = params;

  // Explicit fromTime wins; otherwise count back from now by hoursBack.
  // Both are converted to local wall-clock strings for osxphotos.
  const now = new Date();
  const start = fromTime ? new Date(fromTime) : new Date(now.getTime() - hoursBack * 3600_000);

  const records = await queryScreenshots({
    fromDate: localIso(start),
    // No upper bound: osxphotos defaults to "now", which is exactly what
    // "last N hours" implies.
  });

  const recent = records.slice(0, limit);

  return {
    windowStart: start.toISOString(),
    windowEnd: now.toISOString(),
    returned: recent.length,
    totalInWindow: records.length,
    screenshots: recent.map(summarize),
  };
}

// ---------------------------------------------------------------------------
// Vision pipeline: screenshots -> image model -> structured descriptions.
// ---------------------------------------------------------------------------

/**
 * Default Zod schema for a single screenshot description. Callers can pass
 * their own schema to `describeScreenshots` for domain-specific extraction
 * (e.g. pulling out action items, URLs, or UI element labels).
 */
export const ScreenshotDescriptionSchema = z.object({
  /** What app or website is shown. */
  app: z.string().describe("The app or website shown in the screenshot"),
  /** What the user is doing or looking at. */
  summary: z.string().describe("What the user is doing or looking at"),
  /** Prominent text quoted verbatim, if any. */
  prominentText: z
    .array(z.string())
    .describe("Prominent text quoted verbatim from the screenshot"),
});

export type ScreenshotDescription = z.infer<typeof ScreenshotDescriptionSchema>;

export interface DescribedScreenshot {
  uuid: string;
  filename: string;
  /** ISO 8601 capture date. */
  date: string;
  /** Path to the image file that was sent to the model. */
  path: string;
  /** The model's structured answer, or null if this one failed. */
  description: ScreenshotDescription | null;
  error?: string;
}

export interface DescribeScreenshotsResult {
  windowStart: string;
  windowEnd: string;
  returned: number;
  totalInWindow: number;
  /** Number of screenshots that failed vision processing. */
  failed: number;
  screenshots: DescribedScreenshot[];
}

export interface DescribeScreenshotsParams {
  /** How far back to look, in hours. Default 24. */
  hoursBack?: number;
  /** Window start as an ISO 8601 timestamp. Overrides hoursBack. */
  fromTime?: string;
  /** Cap on screenshots to process. Default 50 (vision calls are expensive). */
  limit?: number;
  /** Prompt sent to the vision model alongside each image. */
  prompt?: string;
  /** Zod schema for the expected response. Defaults to ScreenshotDescriptionSchema. */
  schema?: z.ZodType;
  /** Where iCloud-only screenshots get downloaded to. */
  workDir?: string;
  /** Parallel in-flight vision requests. Default 4. */
  concurrency?: number;
  /** Vision model options (model name, host, API key). */
  vision?: VisionOptions;
  /** Called after each image completes, for progress reporting. */
  onProgress?: (
    done: number,
    total: number,
    current: DescribedScreenshot,
  ) => void;
}

const DEFAULT_VISION_PROMPT =
  "Describe this screenshot. What app or website is shown, and what is the " +
  "user doing or looking at? Quote any prominent text verbatim. Be concise.";

/**
 * Query recent screenshots, materialize them to disk, and send each to a
 * vision model for structured description.
 *
 * This is the full pipeline: osxphotos query -> materialize iCloud-only
 * assets -> base64-encode -> Ollama vision chat with structured output. One
 * bad image doesn't sink the batch — failures are recorded per-screenshot
 * with an `error` field and a null `description`.
 *
 * The vision model defaults to `process.env.IMAGE_MODEL` (falling back to
 * `process.env.MODEL`), using the same Ollama host/auth env vars as every
 * other client in the repo.
 */
export async function describeScreenshots(
  params: DescribeScreenshotsParams = {},
): Promise<DescribeScreenshotsResult> {
  const {
    hoursBack = 24,
    fromTime,
    limit = 50,
    prompt = DEFAULT_VISION_PROMPT,
    schema = ScreenshotDescriptionSchema,
    workDir = path.join(process.cwd(), ".screenshots"),
    concurrency = 4,
    vision = {},
    onProgress,
  } = params;

  // 1. Query screenshots in the time window.
  const now = new Date();
  const start = fromTime
    ? new Date(fromTime)
    : new Date(now.getTime() - hoursBack * 3600_000);

  const records = await queryScreenshots({
    fromDate: localIso(start),
  });

  const photos = records.slice(0, limit);
  if (photos.length === 0) {
    return {
      windowStart: start.toISOString(),
      windowEnd: now.toISOString(),
      returned: 0,
      totalInWindow: 0,
      failed: 0,
      screenshots: [],
    };
  }

  // 2. Materialize: ensure every screenshot has a readable file on disk.
  // Local files are used in place; iCloud-only assets are downloaded.
  await mkdir(workDir, { recursive: true });
  const paths = await materialize(photos, workDir);

  // 3. Send each image to the vision model with concurrency control.
  let done = 0;
  let failed = 0;

  const results = await mapWithConcurrency(
    photos,
    concurrency,
    async (photo: PhotoRecord): Promise<DescribedScreenshot> => {
      const filePath = paths.get(photo.uuid);

      const base = {
        uuid: photo.uuid,
        filename: photo.original_filename || photo.filename,
        date: photo.date,
        path: filePath ?? "",
      };

      if (!filePath) {
        failed++;
        log.warn(`describeScreenshots: no local file for ${photo.uuid}`, {
          uuid: photo.uuid,
          filename: photo.original_filename || photo.filename,
          isMissing: photo.ismissing,
        });
        const result: DescribedScreenshot = {
          ...base,
          description: null,
          error:
            "File not available locally and could not be downloaded from iCloud.",
        };
        done++;
        onProgress?.(done, photos.length, result);
        return result;
      }

      try {
        const description = await describeImage(
          filePath,
          prompt,
          schema,
          vision,
        ) as ScreenshotDescription;
        const result: DescribedScreenshot = { ...base, description };
        done++;
        onProgress?.(done, photos.length, result);
        return result;
      } catch (err) {
        // One bad image shouldn't sink a batch.
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`describeScreenshots: vision failed for ${photo.uuid}`, {
          uuid: photo.uuid,
          filename: photo.original_filename || photo.filename,
          path: filePath,
          width: photo.width,
          height: photo.height,
          originalFilesize: photo.original_filesize,
          error: msg,
        });
        const result: DescribedScreenshot = {
          ...base,
          description: null,
          error: msg,
        };
        done++;
        onProgress?.(done, photos.length, result);
        return result;
      }
    },
  );

  return {
    windowStart: start.toISOString(),
    windowEnd: now.toISOString(),
    returned: results.length,
    totalInWindow: records.length,
    failed,
    screenshots: results,
  };
}

// ---------------------------------------------------------------------------
// Tool wrapper — same capability, exposed to the model via a Zod schema.
// ---------------------------------------------------------------------------

const limitSchema = z
  .number()
  .int()
  .positive()
  .max(500)
  .default(100)
  .describe(
    "Maximum screenshots to return; keeps the most recent when the window has more (default 100).",
  );

export const getRecentScreenshotsTool = defineTool({
  name: "get_recent_screenshots",
  description:
    "Query the local macOS Photos library for screenshots taken within a recent time window. " +
    "Returns your own screenshots only — syndicated (Shared with You), shared iCloud album " +
    "content, hidden, and trashed photos are excluded. Each result includes the UUID, " +
    "original filename, capture timestamp, dimensions, and the on-disk path (null when the " +
    "original is iCloud-only and not downloaded). Use this to ground visual questions in " +
    "what the user actually saw on their screen recently.",
  schema: z.object({
    hoursBack: z
      .number()
      .positive()
      .max(24 * 30)
      .default(24)
      .describe(
        "How far back to look, in hours (default 24, max 720). Ignored when fromTime is set.",
      ),
    fromTime: z
      .iso
      .datetime({ offset: true })
      .optional()
      .describe(
        "Window start as an ISO 8601 timestamp, inclusive (e.g. 2026-07-20T14:30:00Z). " +
        "Overrides hoursBack. Use this when the user refers to a specific clock time.",
      ),
    limit: limitSchema,
  }),
  execute: ({ hoursBack, fromTime, limit }) =>
    getRecentScreenshots({ hoursBack, fromTime, limit }),
});