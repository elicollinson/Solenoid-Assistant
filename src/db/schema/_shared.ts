// Shared vocabularies and column helpers.
//
// Every enum lives here once and is used twice: as a TypeScript union (via
// `text({ enum })`) and as a SQL CHECK constraint (via `inList`). Drizzle's
// `enum` option narrows types but emits no constraint, so the pair is what
// makes an invalid state impossible in both directions.
import { sql, type SQL } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";

/** The four states behind the design's Bauhaus marks, plus a quiet fifth. */
export const STATE = ["attention", "running", "done", "failed", "idle"] as const;
export type State = (typeof STATE)[number];

export const RUN_STATE = ["queued", "running", "attention", "done", "failed", "cancelled"] as const;
export const STEP_STATE = ["ok", "running", "failed", "waiting", "skipped"] as const;
export const LOG_LEVEL = ["debug", "info", "ok", "warn", "error"] as const;
export const ACTOR = ["agent", "user", "system"] as const;
export const AUTHOR = ["agent", "user"] as const;
export const SURFACE = ["any", "desktop", "phone"] as const;

/**
 * The screens the rail routes to. Here rather than in the client because the
 * agent writes a different line per screen — Chat, Calendar and Workflows each
 * carry their own "what I have not done" for the same day — and those rows have
 * to be told apart by something the database knows.
 */
export const SCREEN = [
  "home", "chat", "activity", "workflows", "calendar",
  "reminders", "knowledge", "recommendations", "settings",
] as const;
export type Screen = (typeof SCREEN)[number];
export const SAFETY_STATE = ["unscreened", "clean", "flagged", "quarantined"] as const;
export const TRUST_STATE = ["trusted", "known", "unknown", "blocked"] as const;

/** Anything that can be cited, linked, narrated or decided on. */
export const ENTITY_KIND = [
  "workflow", "workflow_run", "run_step", "activity_item", "decision",
  "reminder", "calendar_item", "okf_object", "okf_field", "recommendation",
  "conversation", "message", "screenshot", "web_document", "participant",
  "attachment",
] as const;
export type EntityKind = (typeof ENTITY_KIND)[number];

/**
 * The kinds that belong to the OKF projection rather than to this database.
 *
 * `okf/` is the source of truth for these and `db:index-okf` rebuilds them, so
 * nothing that clears the database on its way to writing its own rows may take
 * them with it. Named here rather than inline because the seed and the tests
 * both have to agree on where the line falls.
 */
export const OKF_ENTITY_KIND = ["okf_object", "okf_field"] as const;

/**
 * The single timezone the product runs in. Calendar rows carry `tz` so a
 * second zone is a data change rather than a migration, but every code path
 * may assume this value today.
 */
export const APP_TZ = "America/New_York";

/** Money is always USD, stored as integer cents. There is no currency column. */
export const APP_CURRENCY = "USD";

/** `col IN ('a','b')` — the CHECK half of an enum. */
export function inList(col: unknown, values: readonly string[]): SQL {
  const list = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
  return sql`${col} in ${sql.raw(`(${list})`)}`;
}

/** Unix milliseconds, UTC. Never a formatted string. */
export const ts = () => integer({ mode: "timestamp_ms" });
export const tsReq = () => integer({ mode: "timestamp_ms" }).notNull();

export const bool = () => integer({ mode: "boolean" }).notNull().default(false);
export const boolTrue = () => integer({ mode: "boolean" }).notNull().default(true);

/** JSON held as TEXT. Read with json_extract() in SQL, typed in TS. */
export const json = <T>() => text({ mode: "json" }).$type<T>();
