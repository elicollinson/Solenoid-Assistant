import { rejectCollectedPhoto } from "../sources/assets";
import { createClassifierAgent } from "../agents/classifier";
import { createContentCardSourcingAgent } from "../agents/contentCardSourcing";
import { getDb, type Db } from "../db";
import { collectionSourceExists, type LocalIngestionResult } from "../db/mutations/collections";
import { currentConsent } from "../core/consent";
import { collectionWriteTool } from "./collectionWrite";
import type { Collection } from "../shared/collections";
import type { AgentResource } from "../agents/resource";
import {
  contentCardSchema,
  type ClassificationResult,
  type ContentCard,
} from "../prompts";
import {
  classifyPhoto,
  classifyScreenshots,
  screenshotsInWindow,
  type ClassifiedScreenshot,
  type ClassifyScreenshotsParams,
  type ClassifyScreenshotsResult,
  type ScreenshotWindow,
} from "../tools/photos";
import type { PhotoRecord } from "../utils/osxPhotos";
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

/**
 * One screenshot at a time through the classifier agent, started on first use.
 * A rejected screenshot's collected bytes are discarded, as the batch path does.
 */
function classifierFor(override?: (photo: PhotoRecord) => Promise<ClassifiedScreenshot>) {
  let resource: AgentResource | undefined;
  return {
    classify: override ?? (async (photo: PhotoRecord) => {
      resource ??= await createClassifierAgent();
      const shot = await classifyPhoto(resource.agent, photo);
      if (shot.status === "classified" && shot.classification.classification === "Rejected") await rejectCollectedPhoto(shot.uuid);
      return shot;
    }),
    close: async () => { await resource?.close(); },
  };
}

/**
 * Classify every screenshot in a window, oldest first, one at a time.
 *
 * The read-only sibling of {@link ingestScreenshotWindow}: nothing is skipped,
 * because nothing is saved to tell this run what an earlier one already saw.
 */
export async function classifyScreenshotWindow(
  window: ScreenshotWindow,
  dependencies: Pick<ScreenshotIngestionDependencies, "list" | "classifyOne" | "signal"> = {},
): Promise<ClassifyScreenshotsResult> {
  const photos = await (dependencies.list ?? screenshotsInWindow)(window);
  const classifier = classifierFor(dependencies.classifyOne);
  const screenshots: ClassifiedScreenshot[] = [];
  try {
    for (const photo of photos) {
      dependencies.signal?.throwIfAborted();
      screenshots.push(await classifier.classify(photo));
    }
  } finally {
    await classifier.close();
  }
  return {
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    returned: screenshots.length,
    totalInWindow: photos.length,
    failed: screenshots.filter(({ status }) => status === "failed").length,
    quarantined: screenshots.filter(({ status }) => status === "quarantined").length,
    screenshots,
  };
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
  totalInWindow: number;
  /** Already in Collections before this run, so passed over without a model call. */
  alreadyDone: number;
  /** Screenshots this run sent to the model; each has an entry in `screenshots`. */
  processed: number;
  failed: number;
  quarantined: number;
  screenshots: ScreenshotIngestionItem[];
}

export interface ScreenshotIngestionDependencies {
  /** The window's screenshots, oldest first. */
  list?: (window: ScreenshotWindow) => Promise<PhotoRecord[]>;
  /** Describe and classify one screenshot. */
  classifyOne?: (photo: PhotoRecord) => Promise<ClassifiedScreenshot>;
  createContentResource?: typeof createContentCardSourcingAgent;
  db?: Db;
  loadProcessed?: typeof loadProcessed;
  /** Checked between screenshots: a stopped run keeps what it already saved. */
  signal?: AbortSignal;
}

/**
 * Walk a capture-time window oldest first, one screenshot at a time.
 *
 * Each screenshot is finished — classified, sourced, saved — before the next
 * is looked at, so a long window is a long run that is safe to stop, not one
 * that saves nothing until the end. Screenshots already in Collections are
 * passed over before any model call: rerunning a window costs only the new
 * ones, where it used to re-classify the same first few every time.
 */
export async function ingestScreenshotWindow(
  window: ScreenshotWindow,
  dependencies: ScreenshotIngestionDependencies = {},
): Promise<ScreenshotIngestionResult> {
  const photos = await (dependencies.list ?? screenshotsInWindow)(window);
  const db = dependencies.db ?? getDb();
  const processedReceipts = await (dependencies.loadProcessed ?? loadProcessed)();
  // Started once, by the first screenshot that needs it, and shared after.
  let contentResource: Promise<AgentResource> | undefined;
  const classifier = classifierFor(dependencies.classifyOne);

  const screenshots: ScreenshotIngestionItem[] = [];
  let alreadyDone = 0;
  try {
    for (const photo of photos) {
      dependencies.signal?.throwIfAborted();
      if (collectionSourceExists(db, photo.uuid) || processedReceipts[photo.uuid]) {
        alreadyDone++;
        continue;
      }
      const shot = await classifier.classify(photo);
      const [item] = await ingestClassified([shot], db, () =>
        contentResource ??= (dependencies.createContentResource ?? createContentCardSourcingAgent)());
      screenshots.push(item!);
    }
  } finally {
    await Promise.all([classifier.close(), contentResource?.then((resource) => resource.close(), () => {})]);
  }

  return {
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    totalInWindow: photos.length,
    alreadyDone,
    processed: screenshots.length,
    failed: screenshots.filter(({ status }) => status === "failed").length,
    quarantined: screenshots.filter(({ status }) => status === "quarantined").length,
    screenshots,
  };
}

/** Source and save classified screenshots, each its own isolation unit. */
async function ingestClassified(
  classified: ClassifiedScreenshot[],
  db: Db,
  contentAgent: () => Promise<AgentResource>,
): Promise<ScreenshotIngestionItem[]> {
  const batch = await runIsolated({
    items: classified,
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

    const contentCard = await (await contentAgent()).agent.run(
      classification.name,
      contentCardSchema,
    ) as ContentCard;

    const write = collectionWriteTool(db);
    const input = write.schema.parse({
      uuid: screenshot.uuid, filename: screenshot.filename, date: screenshot.date,
      path: screenshot.path, classification, contentCard,
      collection: classificationToCollection(classification.classification),
    });
    const gate = currentConsent();
    if (!gate) throw new Error("Collection saves require a workflow permission context");
    const verdict = await gate({
      tool: write.definition.function.name, kind: write.kind, args: input,
      description: write.definition.function.description,
    });
    if (!verdict.allow) return { ...base, contentCard, status: "skipped", error: verdict.tell };
    const ingestion = await write.execute(input) as LocalIngestionResult;
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
    const screenshot = classified[result.index]!;
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

  return screenshots;
}
