import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { json } from "./_shared";

// History is NOT a projection and intentionally has no cascading domain FKs.
export const writeOperations = sqliteTable("write_operations", {
  id: text().primaryKey(), parentId: text(), tool: text().notNull(),
  origin: text().notNull(), actor: text().notNull(), runId: text(), workflowId: text(),
  idempotencyKey: text().notNull(), execution: text().notNull(), response: text().notNull(),
  capability: text().notNull().default("unknown"), inverseOf: text(),
  createdAt: integer().notNull(), updatedAt: integer().notNull(), expiresAt: integer(),
}, t => [uniqueIndex("write_execution_key").on(t.idempotencyKey), index("write_history_time").on(t.createdAt)]);
export const writeEvents = sqliteTable("write_events", {
  id: integer().primaryKey({ autoIncrement: true }), operationId: text().notNull(),
  kind: text().notNull(), code: text(), at: integer().notNull(),
});
export const writePayloads = sqliteTable("write_payloads", {
  operationId: text().primaryKey(), version: integer().notNull().default(1),
  cipher: text().notNull(), expiresAt: integer().notNull(),
});
export const writePlans = sqliteTable("write_plans", {
  id: text().primaryKey(), kind: text().notNull(), operationId: text(),
  digest: text().notNull(), cipher: text().notNull(), state: text().notNull(),
  createdAt: integer().notNull(), expiresAt: integer().notNull(), appliedOperationId: text(),
});
export const writeResourceLocks = sqliteTable("write_resource_locks", {
  resource: text().primaryKey(), owner: text().notNull(), pid: integer().notNull(),
  acquiredAt: integer().notNull(),
});
export const writeReconciliations = sqliteTable("write_reconciliations", {
  operationId: text().primaryKey(), root: text().notNull(),
  concepts: json<string[]>().notNull(), state: text().notNull(),
});
