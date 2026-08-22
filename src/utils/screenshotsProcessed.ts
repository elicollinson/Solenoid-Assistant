/**
 * Tracks which screenshots have already been ingested into Notion.
 *
 * Prevents duplicate processing when `/screenshots/ingest` is called multiple
 * times with overlapping time windows. Uses a simple JSON file in the same
 * `.screenshots` directory where materialized images are stored.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";

const DEFAULT_DIR = path.join(process.cwd(), ".screenshots");
const FILENAME = "processed.json";

// ---------------------------------------------------------------------------
// Types (Zod schemas → inferred types)
// ---------------------------------------------------------------------------

/** Zod schema for a single processed-entry record. */
export const processedEntrySchema = z.object({
  /** The classification assigned (Book, Movie, TV Show, Game, Music). */
  classification: z.string(),
  /** The name extracted by the classifier. */
  name: z.string(),
  /** ISO timestamp when ingestion completed successfully. */
  ingestedAt: z.string(),
});

export type ProcessedEntry = z.infer<typeof processedEntrySchema>;

/** Zod schema for the on-disk processed map (UUID → entry). */
export const processedMapSchema = z.record(z.string(), processedEntrySchema);

export type ProcessedMap = z.infer<typeof processedMapSchema>;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Load the processed map from disk. A missing file is an empty state; corrupt
 * state fails loudly so a later run cannot silently re-ingest everything. */
export async function loadProcessed(dir = DEFAULT_DIR): Promise<ProcessedMap> {
  const filePath = path.join(dir, FILENAME);
  try {
    const data = await readFile(filePath, "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(data.trim());
    } catch (error) {
      throw new Error(
        `Processed screenshot state is not valid JSON at ${filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const parsed = processedMapSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Processed screenshot state has an invalid shape at ${filePath}: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** Persist the processed map atomically in the destination directory. */
export async function saveProcessed(map: ProcessedMap, dir = DEFAULT_DIR): Promise<void> {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, FILENAME);
  const temporaryPath = path.join(dir, `.${FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

/** Check whether a screenshot UUID has already been ingested. */
export function isAlreadyIngested(map: ProcessedMap, uuid: string): boolean {
  return !!map[uuid];
}

/** Record that a screenshot was successfully ingested. */
export function markAsIngested(
  map: ProcessedMap,
  uuid: string,
  classification: string,
  name: string,
): void {
  map[uuid] = {
    classification,
    name,
    ingestedAt: new Date().toISOString(),
  };
}
