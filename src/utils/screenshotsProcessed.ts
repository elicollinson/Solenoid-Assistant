/**
 * Tracks which screenshots have already been ingested into Notion.
 *
 * Prevents duplicate processing when `/screenshots/ingest` is called multiple
 * times with overlapping time windows. Uses a simple JSON file in the same
 * `.screenshots` directory where materialized images are stored.
 */

import { readFile, writeFile } from "node:fs/promises";
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

/** Load the processed map from disk. Returns empty object if file missing or corrupt. */
export async function loadProcessed(dir = DEFAULT_DIR): Promise<ProcessedMap> {
  const filePath = path.join(dir, FILENAME);
  try {
    const data = await readFile(filePath, "utf8");
    const parsed = processedMapSchema.safeParse(JSON.parse(data.trim()));
    if (!parsed.success) {
      // File exists but has unexpected shape — start fresh rather than
      // risking downstream type mismatches.
      return {};
    }
    return parsed.data;
  } catch {
    // File doesn't exist yet or JSON.parse failed — start fresh.
    return {};
  }
}

/** Persist the processed map to disk. */
export async function saveProcessed(map: ProcessedMap, dir = DEFAULT_DIR): Promise<void> {
  const filePath = path.join(dir, FILENAME);
  await writeFile(filePath, JSON.stringify(map, null, 2), "utf8");
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