import { blob, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Rebuildable search data, scoped by bundle root. Never authoritative memory.
export const okfSearchScopes = sqliteTable("okf_search_scopes", {
  scope: text().primaryKey(),
  initializedAt: integer().notNull(),
});
export const okfSearchDocuments = sqliteTable("okf_search_documents", {
  scope: text().notNull(),
  conceptId: text().notNull(),
  sourceHash: text().notNull(),
  approvedConfig: text(),
  title: text().notNull(),
  header: text().notNull(),
  body: text().notNull(),
  frontmatter: text().notNull(),
}, t => [primaryKey({ columns: [t.scope, t.conceptId] })]);
export const okfSearchChunks = sqliteTable("okf_search_chunks", {
  scope: text().notNull(),
  conceptId: text().notNull(),
  configId: text().notNull(),
  inputHash: text().notNull(),
  input: text().notNull(),
  excerpt: text().notNull(),
  vector: blob(),
  state: text().notNull().default("pending"),
  attempts: integer().notNull().default(0),
  nextAttempt: integer().notNull().default(0),
  owner: text(),
  leaseUntil: integer().notNull().default(0),
  error: text(),
}, t => [primaryKey({ columns: [t.scope, t.conceptId, t.configId, t.inputHash] })]);
export const okfEmbeddingUsage = sqliteTable("okf_embedding_usage", {
  // One shared daily cap across server, worker, roots, and model versions.
  day: text().primaryKey(),
  reservedTokens: integer().notNull(),
});
