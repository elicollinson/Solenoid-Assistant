import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";

// Internal, recoverable OKF writes. No cross-domain audit or proposal queue.
export const okfWrites = sqliteTable("okf_writes", {
  id: text().primaryKey(), tool: text().notNull(), actor: text().notNull(), execution: text().notNull(),
  version: integer().notNull().default(1), payload: text(), digest: text(), inverseOf: text(),
  createdAt: integer().notNull(), expiresAt: integer().notNull(), refreshPending: integer().notNull().default(0),
}, t => [index("okf_writes_expiry").on(t.expiresAt)]);
export const okfWriteLocks = sqliteTable("okf_write_locks", {
  resource: text().primaryKey(), owner: text().notNull(), pid: integer().notNull(), acquiredAt: integer().notNull(),
});
export const dreamCheckpoints = sqliteTable("dream_checkpoints", {
  root: text().primaryKey(), cursor: integer().notNull().default(0),
});
