import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { COLLECTIONS } from "../../shared/collections";
import type { ClassificationResult, ContentCard } from "../../prompts";
import { inList, json, tsReq } from "./_shared";

// Kept apart from recommendations, which are decisions about agent behavior.
export const collectionItems = sqliteTable("collection_items", {
  id: text().primaryKey(),
  collection: text({ enum: COLLECTIONS }).notNull(),
  identity: text().notNull(),
  name: text().notNull(),
  type: text().notNull(),
  description: text().notNull(),
  url: text().notNull(),
  coverImageUrl: text().notNull(),
  notes: text().notNull().default(""),
  archived: integer({ mode: "boolean" }).notNull().default(false),
  createdAt: tsReq(),
  updatedAt: tsReq(),
}, (t) => [
  check("collection_items_collection_check", inList(t.collection, COLLECTIONS)),
  check("collection_items_archived_check", inList(t.archived, ["0", "1"])),
  uniqueIndex("collection_items_identity").on(t.collection, t.identity),
  index("collection_items_created").on(t.createdAt),
]);

// Immutable extraction snapshots; repeats of a title keep every screenshot.
// UUID is the durable link to source_records/photos even if its image expires.
export const collectionSources = sqliteTable("collection_sources", {
  id: text().primaryKey(),
  itemId: text().notNull().references(() => collectionItems.id, { onDelete: "cascade" }),
  screenshotUuid: text().notNull(),
  filename: text().notNull(),
  capturedAt: text().notNull(),
  path: text().notNull(),
  assetHash: text(),
  classification: json<ClassificationResult>().notNull(),
  contentCard: json<ContentCard>().notNull(),
  savedAt: tsReq(),
}, (t) => [
  uniqueIndex("collection_sources_screenshot").on(t.screenshotUuid),
  index("collection_sources_item").on(t.itemId),
]);

/** Complete Notion snapshots keep properties/blocks that have no display field. */
export const collectionImports = sqliteTable("collection_imports", {
  pageId: text().primaryKey(),
  itemId: text().notNull().references(() => collectionItems.id, { onDelete: "cascade" }),
  pageUrl: text().notNull(),
  payload: json<unknown>().notNull(),
  importedAt: tsReq(),
}, (t) => [index("collection_imports_item").on(t.itemId)]);
