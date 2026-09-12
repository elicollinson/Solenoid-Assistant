import { z } from "zod";
import type { Db } from "../db";
import { defineTool } from "../core/tools";
import { saveExtractedCollectionItem } from "../db/mutations/collections";
import { ClassificationResultSchema, contentCardSchema } from "../prompts";
import { COLLECTIONS } from "../shared/collections";

/** Also reconstructs an approved deferred save, with the original extraction. */
export function collectionWriteTool(db: Db) {
  return defineTool({
    name: "collections_save_screenshot",
    description: "Save a screenshot discovery and its source receipt to Collections.",
    kind: "write",
    schema: z.object({
      uuid: z.string().min(1), filename: z.string(), date: z.string(), path: z.string(),
      classification: ClassificationResultSchema,
      contentCard: contentCardSchema,
      collection: z.enum(COLLECTIONS),
    }),
    execute: (input) => saveExtractedCollectionItem(db, input),
  });
}
