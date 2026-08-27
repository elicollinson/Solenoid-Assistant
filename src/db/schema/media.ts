// Screenshots and web documents — the other two evidence kinds.
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { SAFETY_STATE, inList, json, ts, tsReq } from "./_shared";
import { entityId } from "./entities";

export const SCREENSHOT_ORIGIN = ["photos_library", "agent_capture", "attachment", "manual"] as const;
export const INGEST_STATE = ["pending", "ingested", "quarantined", "rejected", "failed", "skipped"] as const;

export const screenshots = sqliteTable("screenshots", {
  id: entityId(),
  /** osxphotos uuid. Null for agent captures that never touched Photos. */
  photosUuid: text(),
  /** Null when the asset lives only in iCloud and is not downloaded. */
  path: text(),
  pathEdited: text(),
  originalFilename: text().notNull(),
  fileSha256: text(),
  capturedAt: tsReq(),
  addedAt: ts(),
  width: integer(),
  height: integer(),
  uti: text(),
  sizeBytes: integer(),
  origin: text({ enum: SCREENSHOT_ORIGIN }).notNull().default("photos_library"),
  /** "captured by me from the accounts portal", "captured by me while filing" */
  captureContext: text(),
  capturedBy: text({ enum: ["user", "agent"] as const }).notNull().default("user"),
  /** "run 14 · step 6" */
  capturedInRunId: text(),
  isMissing: integer({ mode: "boolean" }).notNull().default(false),
  inTrash: integer({ mode: "boolean" }).notNull().default(false),
  appleLabels: json<string[]>().notNull().default(sql`'[]'`),
  persons: json<string[]>().notNull().default(sql`'[]'`),
  albums: json<string[]>().notNull().default(sql`'[]'`),
  safetyState: text({ enum: SAFETY_STATE }).notNull().default("unscreened"),
  ingestState: text({ enum: INGEST_STATE }).notNull().default("pending"),
  ingestError: text(),
}, (t) => [
  check("screenshots_origin_check", inList(t.origin, SCREENSHOT_ORIGIN)),
  check("screenshots_ingest_check", inList(t.ingestState, INGEST_STATE)),
  check("screenshots_safety_check", inList(t.safetyState, SAFETY_STATE)),
  uniqueIndex("screenshots_photos_uuid").on(t.photosUuid),
  index("screenshots_captured").on(t.capturedAt),
  index("screenshots_pending").on(t.capturedAt).where(sql`${t.ingestState} = 'pending'`),
]);

/**
 * Versioned on purpose. Evidence rows point at a specific analysis, so
 * re-running OCR with a better model next month must not rewrite what the
 * agent actually saw when it stopped run 14. The audit trail is the point of
 * the Evidence viewer.
 */
export const screenshotAnalyses = sqliteTable("screenshot_analyses", {
  id: text().primaryKey(),
  screenshotId: text().notNull().references(() => screenshots.id, { onDelete: "cascade" }),
  version: integer().notNull(),
  isCurrent: integer({ mode: "boolean" }).notNull().default(true),
  /** What is in it, in prose. */
  summary: text(),
  /** The design's shot.text. */
  ocrText: text(),
  appGuess: text(),
  docKind: text(),
  entitiesJson: json<unknown[]>().notNull().default(sql`'[]'`),
  model: text(),
  promptVersion: text(),
  createdAt: tsReq(),
}, (t) => [
  uniqueIndex("screenshot_analyses_version").on(t.screenshotId, t.version),
  uniqueIndex("screenshot_analyses_current").on(t.screenshotId).where(sql`${t.isCurrent} = 1`),
]);

/** "Row 14 — Invoice 2291 · $2,140.00 · no matching ledger line." */
export const screenshotRegions = sqliteTable("screenshot_regions", {
  id: text().primaryKey(),
  analysisId: text().notNull().references(() => screenshotAnalyses.id, { onDelete: "cascade" }),
  ordinal: integer().notNull(),
  label: text().notNull(),
  note: text().notNull(),
  /** Normalised [x, y, w, h] in 0..1. Nullable: the design has no coordinates
   *  yet, but every region label in it is spatial and will want one. */
  bbox: json<[number, number, number, number]>(),
}, (t) => [uniqueIndex("screenshot_regions_ordinal").on(t.analysisId, t.ordinal)]);

/** The `article` evidence kind. A re-fetch is a new row, never an overwrite. */
export const webDocuments = sqliteTable("web_documents", {
  id: entityId(),
  url: text().notNull(),
  canonicalUrl: text(),
  /** "borough council · parking" */
  siteLabel: text(),
  headline: text(),
  byline: text(),
  retrievedAt: tsReq(),
  wordCount: integer(),
  bodyText: text().notNull().default(""),
  rawPath: text(),
  httpStatus: integer(),
  contentSha256: text(),
  safetyState: text({ enum: SAFETY_STATE }).notNull().default("unscreened"),
}, (t) => [
  check("web_documents_safety_check", inList(t.safetyState, SAFETY_STATE)),
  index("web_documents_url").on(t.url, t.retrievedAt),
]);
