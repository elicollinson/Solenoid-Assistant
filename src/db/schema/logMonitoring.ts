import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

// Operational state only. Evidence lives in issues and transient scan memory.
export const logMonitorScans = sqliteTable("log_monitor_scans", {
  scope: text().primaryKey().notNull(),
  completedTo: integer(),
  pendingFrom: integer(),
  pendingTo: integer(),
  owner: text(),
  leaseUntil: integer().notNull().default(0),
});
export const logMonitorIncidents = sqliteTable("log_monitor_incidents", {
  scope: text().notNull(),
  fingerprint: text().notNull(),
  status: text().notNull(), // posting (possibly ambiguous), linked
  issueNumber: integer(),
  issueUrl: text(),
}, t => [primaryKey({ columns: [t.scope, t.fingerprint] })]);
