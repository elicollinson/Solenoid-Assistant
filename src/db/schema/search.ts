// Recall.
//
// The FTS5 table `search` is created in a custom migration — drizzle-kit
// cannot express a virtual table. It is not an external-content table: the
// content spans many tables, so the app writes it on commit. Declared here as
// an existing view so queries against it are typed.
import { blob, integer, sqliteTable, sqliteView, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tsReq } from "./_shared";
import { entityRef } from "./entities";

export const embeddings = sqliteTable("embeddings", {
  id: text().primaryKey(),
  subjectId: entityRef(),
  chunkOrdinal: integer().notNull().default(0),
  chunkText: text(),
  /** Skip re-embedding text that has not changed. */
  textSha256: text().notNull(),
  model: text().notNull(),
  dim: integer().notNull(),
  /** float32 little-endian. Swap for a sqlite-vec vec0 table when you want ANN
   *  rather than a scan. */
  vector: blob().notNull(),
  createdAt: tsReq(),
}, (t) => [
  uniqueIndex("embeddings_chunk").on(t.subjectId, t.chunkOrdinal, t.model),
]);

/* ── Views. Created in the custom migration; declared `.existing()` so
      drizzle-kit does not try to generate them but queries stay typed. ── */

export const search = sqliteView("search", {
  title: text(),
  body: text(),
  subjectId: text("subject_id"),
  kind: text(),
  occurredAt: integer("occurred_at"),
}).existing();

/** Open decisions, blocking first. The NEEDS YOU chip and the aside. */
export const vNeedsYou = sqliteView("v_needs_you", {
  decisionId: text("decision_id").notNull(),
  title: text().notNull(),
  body: text(),
  blocking: integer({ mode: "boolean" }).notNull(),
  openedAt: integer("opened_at", { mode: "timestamp_ms" }).notNull(),
  dueAt: integer("due_at", { mode: "timestamp_ms" }),
  subjectId: text("subject_id"),
  subjectKind: text("subject_kind"),
}).existing();

/** The stats block: [["Runs","14"],["Clean runs","11"],["Median","18m 40s"]]. */
export const vWorkflowStats = sqliteView("v_workflow_stats", {
  workflowId: text("workflow_id").notNull(),
  runs: integer().notNull(),
  cleanRuns: integer("clean_runs"),
  lastStartedAt: integer("last_started_at", { mode: "timestamp_ms" }),
  meanDurationMs: integer("mean_duration_ms"),
  medianDurationMs: integer("median_duration_ms"),
}).existing();

/** "reads: 31 times · lastRead Today 06:12" */
export const vOkfReads = sqliteView("v_okf_reads", {
  okfUri: text("okf_uri").notNull(),
  readCount: integer("read_count").notNull(),
  lastReadAt: integer("last_read_at", { mode: "timestamp_ms" }),
}).existing();

/** The evidence list under any object, joined to its source kind. */
export const vEvidence = sqliteView("v_evidence", {
  id: text().notNull(),
  subjectId: text("subject_id").notNull(),
  ordinal: integer().notNull(),
  why: text(),
  pinKind: text("pin_kind").notNull(),
  pinQuote: text("pin_quote"),
  sourceId: text("source_id").notNull(),
  sourceKind: text("source_kind").notNull(),
}).existing();
