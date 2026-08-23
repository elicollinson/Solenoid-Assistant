import { createClassifierAgent } from "../agents/classifier";
import { createContentCardSourcingAgent } from "../agents/contentCardSourcing";
import { createRecommendationIngestionAgent } from "../agents/recommendationIngestion";
import type { AgentResource } from "../agents/resource";
import {
  contentCardSchema,
  recommendationIngestionSchema,
  type ClassificationResult,
  type ContentCard,
  type RecommendationIngestionInput,
  type RecommendationIngestionResult,
} from "../prompts";
import {
  classifyScreenshots,
  type ClassifyScreenshotsParams,
  type ClassifyScreenshotsResult,
} from "../tools/photos";
import {
  loadProcessed,
  markAsIngested,
  saveProcessed,
} from "../utils/screenshotsProcessed";

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

export async function classifyRecentScreenshots(
  params: ClassifyScreenshotsParams,
): Promise<ClassifyScreenshotsResult> {
  const resource = await createClassifierAgent();
  try {
    return await classifyScreenshots(resource.agent, params);
  } finally {
    await resource.close();
  }
}

export type ScreenshotIngestionStatus = "ingested" | "rejected" | "failed" | "skipped";

export interface ScreenshotIngestionItem {
  uuid: string;
  filename: string;
  date: string;
  path: string;
  classification: ClassificationResult | null;
  contentCard: ContentCard | null;
  ingestion: RecommendationIngestionResult | null;
  status: ScreenshotIngestionStatus;
  error?: string;
}

export interface ScreenshotIngestionResult {
  windowStart: string;
  windowEnd: string;
  returned: number;
  totalInWindow: number;
  failed: number;
  screenshots: ScreenshotIngestionItem[];
}

export async function ingestRecentScreenshots(
  params: ClassifyScreenshotsParams,
): Promise<ScreenshotIngestionResult> {
  const classified = await classifyRecentScreenshots(params);
  let contentResource: AgentResource | undefined;
  let recommendationResource: AgentResource | undefined;

  try {
    contentResource = await createContentCardSourcingAgent();
    recommendationResource = await createRecommendationIngestionAgent();

    const processed = await loadProcessed();
    let dirty = false;
    const screenshots: ScreenshotIngestionItem[] = [];

    for (const screenshot of classified.screenshots) {
      const classification = screenshot.classification;
      const base = {
        uuid: screenshot.uuid,
        filename: screenshot.filename,
        date: screenshot.date,
        path: screenshot.path,
        classification,
        contentCard: null,
        ingestion: null,
      } satisfies Omit<ScreenshotIngestionItem, "status" | "error">;

      if (!classification) {
        screenshots.push({
          ...base,
          status: "skipped",
          error: screenshot.error,
        });
        continue;
      }

      const existing = processed[screenshot.uuid];
      if (existing) {
        screenshots.push({
          ...base,
          status: "skipped",
          error:
            `Already ingested on ${existing.ingestedAt} as ` +
            `"${existing.classification}: ${existing.name}"`,
        });
        continue;
      }

      if (classification.classification === "Rejected") {
        screenshots.push({ ...base, status: "rejected" });
        continue;
      }

      if (!classification.name.trim() || classification.name === "Unknown") {
        screenshots.push({
          ...base,
          status: "skipped",
          error: "Classifier returned an empty or Unknown name",
        });
        continue;
      }

      let contentCard: ContentCard;
      try {
        contentCard = await contentResource.agent.run(
          classification.name,
          contentCardSchema,
        );
      } catch (error) {
        screenshots.push({
          ...base,
          status: "failed",
          error: `Content card sourcing failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        continue;
      }

      const input: RecommendationIngestionInput = {
        name: contentCard.name,
        url: contentCard.url,
        description: contentCard.description || undefined,
        image_url: contentCard.coverImageUrl || undefined,
        collection: classificationToCollection(classification.classification),
      };

      try {
        const ingestion = await recommendationResource.agent.run(
          JSON.stringify(input),
          recommendationIngestionSchema,
        );
        if (ingestion.status !== "error") {
          markAsIngested(
            processed,
            screenshot.uuid,
            classification.classification,
            classification.name,
          );
          dirty = true;
        }
        screenshots.push({
          ...base,
          contentCard,
          ingestion,
          status: ingestion.status === "error" ? "failed" : "ingested",
          error: ingestion.error ?? undefined,
        });
      } catch (error) {
        screenshots.push({
          ...base,
          contentCard,
          status: "failed",
          error: `Recommendation ingestion failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    if (dirty) await saveProcessed(processed);
    return {
      windowStart: classified.windowStart,
      windowEnd: classified.windowEnd,
      returned: classified.returned,
      totalInWindow: classified.totalInWindow,
      failed: classified.failed,
      screenshots,
    };
  } finally {
    await contentResource?.close();
    await recommendationResource?.close();
  }
}
