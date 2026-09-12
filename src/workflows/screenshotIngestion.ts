import { rejectCollectedPhoto } from "../sources/assets";
import { createClassifierAgent } from "../agents/classifier";
import { createContentCardSourcingAgent } from "../agents/contentCardSourcing";
import { getDb, type Db } from "../db";
import { collectionSourceExists, saveExtractedCollectionItem, type LocalIngestionResult } from "../db/mutations/collections";
import type { Collection } from "../shared/collections";
import type { AgentResource } from "../agents/resource";
import {
  contentCardSchema,
  type ClassificationResult,
  type ContentCard,
} from "../prompts";
import {
  classifyScreenshots,
  type ClassifyScreenshotsParams,
  type ClassifyScreenshotsResult,
} from "../tools/photos";
import { loadProcessed } from "../utils/screenshotsProcessed";
import { runIsolated } from "../utils/fanout";

function classificationToCollection(
  classification: ClassificationResult["classification"],
): Collection {
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

export async function classifyRecentScreenshots(
  params: ClassifyScreenshotsParams,
): Promise<ClassifyScreenshotsResult> {
  const resource = await createClassifierAgent();
  try {
    const result = await classifyScreenshots(resource.agent, params);
    for (const shot of result.screenshots) if (shot.status === "classified" && shot.classification.classification === "Rejected") await rejectCollectedPhoto(shot.uuid);
    return result;
  } finally {
    await resource.close();
  }
}

export type ScreenshotIngestionStatus =
  | "ingested"
  | "quarantined"
  | "rejected"
  | "failed"
  | "skipped";

export interface ScreenshotIngestionItem {
  uuid: string;
  filename: string;
  date: string;
  path: string;
  classification: ClassificationResult | null;
  contentCard: ContentCard | null;
  ingestion: LocalIngestionResult | null;
  status: ScreenshotIngestionStatus;
  error?: string;
}

export interface ScreenshotIngestionResult {
  windowStart: string;
  windowEnd: string;
  returned: number;
  totalInWindow: number;
  failed: number;
  quarantined: number;
  screenshots: ScreenshotIngestionItem[];
}

export interface ScreenshotIngestionDependencies {
  classify?: typeof classifyRecentScreenshots;
  createContentResource?: typeof createContentCardSourcingAgent;
  db?: Db;
  loadProcessed?: typeof loadProcessed;
}

export async function ingestRecentScreenshots(
  params: ClassifyScreenshotsParams,
  dependencies: ScreenshotIngestionDependencies = {},
): Promise<ScreenshotIngestionResult> {
  const classified = await (
    dependencies.classify ?? classifyRecentScreenshots
  )(params);
  let contentResource: AgentResource | undefined;

  try {
    const processed = await (dependencies.loadProcessed ?? loadProcessed)();
    const db = dependencies.db ?? getDb();
    const batch = await runIsolated({
      items: classified.screenshots,
      key: (screenshot) => screenshot.uuid,
      concurrency: 1,
      name: "screenshot-ingestion",
      execute: async (screenshot): Promise<ScreenshotIngestionItem> => {
      const base = {
        uuid: screenshot.uuid,
        filename: screenshot.filename,
        date: screenshot.date,
        path: screenshot.path,
        classification: screenshot.classification,
        contentCard: null,
        ingestion: null,
      } satisfies Omit<ScreenshotIngestionItem, "status" | "error">;

      if (screenshot.status !== "classified") {
        return {
          ...base,
          status:
            screenshot.status === "quarantined" ? "quarantined" : "failed",
          error: screenshot.error,
        };
      }
      const classification = screenshot.classification;

      if (collectionSourceExists(db, screenshot.uuid)) return { ...base, status: "skipped" };
      const existing = processed[screenshot.uuid];
      if (existing) {
        return {
          ...base,
          status: "skipped",
          error:
            `Already ingested on ${existing.ingestedAt} as ` +
            `"${existing.classification}: ${existing.name}"`,
        };
      }

      if (classification.classification === "Rejected") {
        return { ...base, status: "rejected" };
      }

      if (!classification.name.trim() || classification.name === "Unknown") {
        return {
          ...base,
          status: "skipped",
          error: "Classifier returned an empty or Unknown name",
        };
      }

      contentResource ??= await (dependencies.createContentResource ?? createContentCardSourcingAgent)();
      const contentCard = await contentResource.agent.run(
        classification.name,
        contentCardSchema,
      ) as ContentCard;

      const ingestion = saveExtractedCollectionItem(db, {
        uuid: screenshot.uuid, filename: screenshot.filename, date: screenshot.date,
        path: screenshot.path, classification, contentCard,
        collection: classificationToCollection(classification.classification),
      });
      return {
        ...base,
        contentCard,
        ingestion,
        status: "ingested",
      };
    },
    });

    const screenshots = batch.results.map((result): ScreenshotIngestionItem => {
      if (result.status === "fulfilled") return result.value;
      const screenshot = classified.screenshots[result.index]!;
      const base = {
        uuid: screenshot.uuid,
        filename: screenshot.filename,
        date: screenshot.date,
        path: screenshot.path,
        classification: screenshot.classification,
        contentCard: null,
        ingestion: null,
      };
      return result.status === "quarantined"
        ? {
            ...base,
            status: "quarantined",
            error: result.reason === "prompt_injection"
              ? "Screenshot quarantined by prompt-injection screening"
              : "Screenshot quarantined by content-safety screening",
          }
        : { ...base, status: "failed", error: result.reason.message };
    });

    return {
      windowStart: classified.windowStart,
      windowEnd: classified.windowEnd,
      returned: classified.returned,
      totalInWindow: classified.totalInWindow,
      failed: screenshots.filter(
        ({ status }) => status === "failed",
      ).length,
      quarantined: screenshots.filter(
        ({ status }) => status === "quarantined",
      ).length,
      screenshots,
    };
  } finally {
    await contentResource?.close();
  }
}
