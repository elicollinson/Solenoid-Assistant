// The OKF index.
//
// The filesystem stays the source of truth. Everything here is a PROJECTION
// and must be rebuildable by dropping these tables and re-scanning okf/. Two
// things exist only in SQLite and must survive a reindex: the UI `state` on an
// object, and okf_access_log — the trail behind "read 31 times · last read
// Today 06:12", which is also the retirement signal for facts nothing has
// referenced since May.
//
// IDS ARE STABLE AND DERIVED, not minted. okfObjectId(uri) and
// okfFieldId(uri, label, value) in ../ids.ts hash their inputs, so a re-index
// regenerates the same ids and evidence links survive it. See the note on
// okfFieldId about why `value` is part of the hash.
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { ACTOR, inList, json, ts, tsReq } from "./_shared";
import { entityId } from "./entities";
import { decisions } from "./decisions";

export const OKF_STATE = ["attention", "running", "done", "idle"] as const;

export const okfObjects = sqliteTable("okf_objects", {
  id: entityId(),
  /** "okf:contact/ferris" */
  uri: text().notNull(),
  /** "okf/memories/the-orchard-gathering.md" */
  path: text().notNull(),
  /** Frontmatter `type`: Memory, Concept, ... */
  okfType: text(),
  /** UI grouping. Derived — see src/db/okf/classify.ts, which reads it off the
   *  tags because every file in a real bundle says `type: Memory`. */
  kind: text(),
  /** The section heading `kind` belongs to: "People and contacts", "Work and
   *  career", "Everything else". */
  groupLabel: text(),
  title: text().notNull(),
  description: text(),
  tags: json<string[]>().notNull().default(sql`'[]'`),
  status: text(),
  rev: integer().notNull().default(1),
  /** UI state, for a mark you set yourself. NOT in the file, and never written
   *  by the indexer: the mark the list draws today is derived from the file and
   *  the clock, because a stored "stale" is wrong by morning. */
  state: text({ enum: OKF_STATE }).notNull().default("idle"),
  frontmatter: json<Record<string, unknown>>().notNull().default(sql`'{}'`),
  bodyText: text().notNull().default(""),
  fileMtime: ts(),
  fileSize: integer(),
  contentSha256: text(),
  generatedBy: text(),
  generatedAt: ts(),
  verifiedAt: ts(),
  staleAfter: ts(),
  createdAt: tsReq(),
  updatedAt: tsReq(),
  indexedAt: tsReq(),
  indexVersion: integer().notNull().default(1),
}, (t) => [
  check("okf_objects_state_check", inList(t.state, OKF_STATE)),
  uniqueIndex("okf_objects_uri").on(t.uri),
  uniqueIndex("okf_objects_path").on(t.path),
  index("okf_by_kind").on(t.kind, t.updatedAt),
  index("okf_stale").on(t.staleAfter).where(sql`${t.staleAfter} is not null`),
]);

/**
 * Provenance is a column, not a flourish: "I guessed this first and you
 * confirmed it, so it's marked as yours rather than mine." Without it the agent
 * cannot honestly say which facts are yours.
 */
export const FIELD_PROVENANCE = ["user", "agent_inferred", "agent_confirmed", "document", "tool"] as const;

export const okfFields = sqliteTable("okf_fields", {
  id: entityId(),
  objectId: text().notNull().references(() => okfObjects.id, { onDelete: "cascade" }),
  ordinal: integer().notNull(),
  /** "billing address" */
  label: text().notNull(),
  /** "Unit 3, Calder Yard" */
  value: text().notNull(),
  assertedAt: ts(),
  /** "invoice 4412" | "you" | "phone log" */
  sourceLabel: text(),
  provenance: text({ enum: FIELD_PROVENANCE }).notNull().default("agent_inferred"),
  confirmedAt: ts(),
  /** Two billing addresses share this and neither is superseded — overwriting
   *  would have hidden the change from you. */
  conflictGroupId: text(),
  supersededById: text().references((): AnySQLiteColumn => okfFields.id, { onDelete: "set null" }),
  retiredAt: ts(),
  /** Where in the markdown it came from, so a write can patch in place. */
  section: text(),
  bodyStart: integer(),
  bodyEnd: integer(),
}, (t) => [
  check("okf_fields_provenance_check", inList(t.provenance, FIELD_PROVENANCE)),
  uniqueIndex("okf_fields_ordinal").on(t.objectId, t.ordinal),
  index("okf_fields_conflict").on(t.conflictGroupId).where(sql`${t.conflictGroupId} is not null`),
]);

export const CONFLICT_RESOLUTION = ["kept_older", "kept_newer", "merged", "kept_both"] as const;

export const okfConflicts = sqliteTable("okf_conflicts", {
  id: text().primaryKey(),
  objectId: text().notNull().references(() => okfObjects.id, { onDelete: "cascade" }),
  /** Matches okfFields.conflictGroupId. */
  groupId: text().notNull(),
  label: text().notNull(),
  decisionId: text().references(() => decisions.id, { onDelete: "set null" }),
  openedAt: tsReq(),
  resolvedAt: ts(),
  resolution: text({ enum: CONFLICT_RESOLUTION }),
}, (t) => [
  uniqueIndex("okf_conflicts_group").on(t.objectId, t.groupId),
]);

export const ACCESS_MODE = ["read", "write", "create", "retire"] as const;

/**
 * Append-only, and deliberately NOT foreign-keyed to okfObjects: it has to
 * survive a full reindex that drops and rebuilds the projection tables. The uri
 * is the durable join key.
 */
export const okfAccessLog = sqliteTable("okf_access_log", {
  id: integer().primaryKey({ autoIncrement: true }),
  objectId: text(),
  okfUri: text().notNull(),
  at: tsReq(),
  mode: text({ enum: ACCESS_MODE }).notNull(),
  actor: text({ enum: ACTOR }).notNull().default("agent"),
  runId: text(),
  stepId: text(),
}, (t) => [
  check("okf_access_mode_check", inList(t.mode, ACCESS_MODE)),
  index("okf_access_by_uri").on(t.okfUri, t.at),
]);

export const SYNC_STATUS = ["ok", "parse_error", "missing", "conflict"] as const;

export const okfSyncState = sqliteTable("okf_sync_state", {
  path: text().primaryKey(),
  contentSha256: text(),
  fileMtime: ts(),
  lastIndexedAt: ts(),
  status: text({ enum: SYNC_STATUS }).notNull().default("ok"),
  error: text(),
}, (t) => [check("okf_sync_status_check", inList(t.status, SYNC_STATUS))]);
