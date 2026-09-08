import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";
export const sourceRecords = sqliteTable(
  "source_records",
  {
    kind: text().notNull(),
    id: text().notNull(),
    payload: text(),
    occurred: text().notNull(),
    revision: text().notNull(),
    deleted: integer().notNull().default(0),
    seq: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.id] }),
    index("source_records_seq").on(t.seq),
  ],
);
export const sourceChanges = sqliteTable("source_changes", {
  seq: integer().primaryKey({ autoIncrement: true }),
  kind: text().notNull(),
  id: text().notNull(),
  payload: text(),
  occurred: text().notNull(),
  revision: text().notNull(),
  deleted: integer().notNull(),
});
export const sourceStatus = sqliteTable("source_status", {
  kind: text().primaryKey().notNull(),
  collectedAt: text().notNull(),
  coverageFrom: text().notNull(),
  coverageTo: text().notNull(),
});
export const sourceMeta = sqliteTable("source_meta", {
  key: text().primaryKey().notNull(),
  value: text().notNull(),
});
export const sourceCandidates = sqliteTable("source_candidates", {
  hash: text().primaryKey().notNull(),
  extension: text().notNull(),
  status: text().notNull().default("pending"),
  createdAt: integer().notNull(),
  attempts: integer().notNull().default(0),
  retryAt: integer().notNull().default(0),
  leaseUntil: integer().notNull().default(0),
  classification: text(),
});
export const sourcePhotoCandidates = sqliteTable("source_photo_candidates", {
  id: text().primaryKey().notNull(),
  hash: text().notNull(),
  payload: text().notNull(),
});
export const sourceProcessed = sqliteTable("source_processed", {
  id: text().primaryKey().notNull(),
  payload: text().notNull(),
});
