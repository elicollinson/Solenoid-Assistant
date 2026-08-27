#!/usr/bin/env bun
// Apply every pending migration to the database named by DATABASE_URL.
import { DEFAULT_DB_PATH, createDb, runMigrations } from "../src/db";
import { configureLogging, flushLogs, log, shutdownLogging } from "../src/core/logger";

// A one-shot compose service is still a service, and the run that failed to
// migrate is exactly the one you go looking for later.
configureLogging({ service: "solenoid-migrate" });
const migrations = log.child("migrate");

const path = process.argv[2] ?? DEFAULT_DB_PATH;
const db = createDb(path);

runMigrations(db);

const tables = db.$client
  .query<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE '__drizzle%' AND name NOT LIKE 'search_%'`,
  )
  .get();

const views = db.$client
  .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'view'`)
  .get();

migrations.ok(`migrated ${path} - ${tables?.n ?? 0} tables, ${views?.n ?? 0} views`, {
  database: path,
  tables: tables?.n ?? 0,
  views: views?.n ?? 0,
});
db.$client.close();

await flushLogs();
await shutdownLogging();
