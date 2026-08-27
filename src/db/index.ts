// The database handle.
//
// One SQLite file, opened in WAL mode with foreign keys on. Foreign keys are
// OFF by default in SQLite and are per-connection, not per-database, so every
// connection must turn them on or the entity supertype enforces nothing.
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";

export * as schema from "./schema";
export { ulid, okfObjectId, okfFieldId, okfFieldIds } from "./ids";

export type Db = BunSQLiteDatabase<typeof schema> & { $client: Database };

export const DEFAULT_DB_PATH = process.env.DATABASE_URL ?? "./data/solenoid.db";
const MIGRATIONS_FOLDER = "./drizzle";

/** Open a connection and apply the pragmas that must hold on every one of them. */
export function openSqlite(path: string = DEFAULT_DB_PATH): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true });

  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  // Enforce the CHECK on the supertype rather than trusting callers.
  sqlite.exec("PRAGMA synchronous = NORMAL");

  return sqlite;
}

export function createDb(path: string = DEFAULT_DB_PATH): Db {
  const sqlite = openSqlite(path);
  return drizzle({ client: sqlite, schema, casing: "snake_case" }) as Db;
}

/** Apply every pending migration. Safe to call on every boot. */
export function runMigrations(db: Db, folder: string = MIGRATIONS_FOLDER): void {
  migrate(db, { migrationsFolder: folder });
}

/** A migrated database, ready to use. The normal entry point. */
export function initDb(path: string = DEFAULT_DB_PATH): Db {
  const db = createDb(path);
  runMigrations(db);
  return db;
}

let shared: Db | undefined;

/** The process-wide handle, opened and migrated on first use. */
export function getDb(): Db {
  shared ??= initDb();
  return shared;
}
