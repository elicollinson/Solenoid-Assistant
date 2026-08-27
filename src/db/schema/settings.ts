// What the agent runs on, and what it is allowed to reach.
//
// The Settings screen says two things that decide the shape of all of this.
//
// "I keep these myself and reload them without a restart." The file the agent
// was first seeded from filled the store in once; from then on the store is the
// truth and `.env` is history. That is why `source` exists — seeding from a file
// and being told by hand are different provenances, and a screen that says "set
// by you" about a value it read out of an env var is lying.
//
// "I never show a key back to you once it is in, not even to myself in a log."
// A promise like that cannot rest on discipline in the query layer, so secrets
// are not settings: they live in a table with no column a key could be returned
// from.
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { ACTOR, AUTHOR, bool, boolTrue, inList, json, ts, tsReq } from "./_shared";
import { workflowRuns } from "./workflows";

export const SETTING_SOURCE = [
  "default", // the value I ship with; nobody has said otherwise
  "env",     // read out of the file I was seeded from
  "user",    // you told me
] as const;

/**
 * One row per known setting, not one row per override.
 *
 * A sparse store cannot tell "my default" from "not set" — both are an absent
 * row — and the design draws those differently: a default is quiet grey, an
 * unset one carries an amber mark and a count on the tab. The registry also
 * gives `connection_checks` something real to point at.
 */
export const settings = sqliteTable("settings", {
  key: text().primaryKey(),
  /** Null is "nothing here yet", which is a state the screen draws. */
  value: json<unknown>(),
  source: text({ enum: SETTING_SOURCE }).notNull().default("default"),
  /**
   * The agent's sentence about this field. Stored rather than shipped in the
   * client because it talks about this machine — "WebGPU is quicker on this
   * machine but I have seen it stall under load" is an observation, not a label.
   */
  hint: text(),
  updatedAt: tsReq(),
  updatedBy: text({ enum: ACTOR }),
}, (t) => [
  check("settings_source_check", inList(t.source, SETTING_SOURCE)),
  // "Last saved: Today 09:14" is the newest thing you changed, not the newest
  // thing that changed.
  index("settings_user_saved").on(t.updatedAt).where(sql`${t.source} = 'user'`),
]);

export const SECRET_STORAGE = ["env", "keychain", "file"] as const;

/**
 * Keys the agent holds on your behalf.
 *
 * There is deliberately no column here that could hold one. The screen reports
 * whether a key is held, when it arrived and when it last worked, and this table
 * can answer exactly that and nothing more — a query that wanted to leak a key
 * would have nowhere to read it from. `hint` is at most the last four
 * characters: enough to tell two keys apart, useless as a key.
 */
export const secrets = sqliteTable("secrets", {
  /** "openrouter.apiKey" */
  key: text().primaryKey(),
  /** "OpenRouter" — what the row is called on screen. */
  label: text().notNull(),
  storage: text({ enum: SECRET_STORAGE }).notNull().default("env"),
  /** Where in that store: an env var name, a keychain account, a path. */
  ref: text(),
  held: bool(),
  hint: text(),
  /** "Route two cannot run without it." Written while it is missing. */
  need: text(),
  setAt: ts(),
  setBy: text({ enum: AUTHOR }),
  /** "Used forty seconds ago" is this against the clock, never a stored phrase. */
  lastUsedAt: ts(),
  lastUsedOk: integer({ mode: "boolean" }),
  retiredAt: ts(),
}, (t) => [
  check("secrets_storage_check", inList(t.storage, SECRET_STORAGE)),
  check("secrets_hint_length_check", sql`${t.hint} is null or length(${t.hint}) <= 4`),
]);

export const MODEL_PROVIDER = ["ollama", "openai", "openrouter"] as const;
export const STRUCTURED_STRATEGY = ["native", "two-stage"] as const;

/**
 * The route chain, in the order the agent tries it.
 *
 * Rows rather than the JSON string in `LLM_ROUTES`, because the screen reorders,
 * deletes and adds them one at a time and each carries a sentence of its own.
 * The JSON editor on that screen writes the same rows; it is a second way in,
 * not a second store.
 *
 * `ordinal` is unique, so a reorder renumbers the whole chain in one
 * transaction rather than swapping two rows and hoping.
 */
export const modelRoutes = sqliteTable("model_routes", {
  id: text().primaryKey(),
  ordinal: integer().notNull(),
  provider: text({ enum: MODEL_PROVIDER }).notNull(),
  model: text().notNull(),
  /** Null is the screen's "as it comes": no strategy pinned, the provider's own. */
  strategy: text({ enum: STRUCTURED_STRATEGY }),
  /** "LM Studio on the desk machine. Nothing leaves the house on this one." */
  note: text(),
  enabled: boolTrue(),
  /**
   * The key this route cannot run without. Null when none is needed — a
   * localhost Ollama asks for nothing. This is what makes "route two is skipped
   * rather than tried" something the agent can work out instead of be told.
   */
  secretKey: text().references(() => secrets.key, { onDelete: "set null" }),
  createdAt: tsReq(),
  updatedAt: tsReq(),
}, (t) => [
  check("model_routes_provider_check", inList(t.provider, MODEL_PROVIDER)),
  check("model_routes_strategy_check", sql`${t.strategy} is null or ${inList(t.strategy, STRUCTURED_STRATEGY)}`),
  uniqueIndex("model_routes_ordinal").on(t.ordinal),
]);

export const ROUTE_OUTCOME = ["ok", "failed", "skipped"] as const;

/**
 * One row per attempt at a route.
 *
 * "Failovers this week: 2", "Last failover: Aug 22, 06:14" and "I skipped to
 * route three twice this week" are all counts against the clock, so none of them
 * can be a stored phrase and nothing else in the database records that a route
 * was tried at all. `workflow_runs.modelRoute` says which route answered; it
 * cannot say which two were asked first.
 *
 * `routeId` nulls rather than cascades: deleting a route from the chain is an
 * edit, and it should not quietly reduce last week's failover count to zero.
 */
export const routeAttempts = sqliteTable("route_attempts", {
  id: text().primaryKey(),
  routeId: text().references(() => modelRoutes.id, { onDelete: "set null" }),
  at: tsReq(),
  outcome: text({ enum: ROUTE_OUTCOME }).notNull(),
  /** "no key held" · "connection refused" · "schema rejected twice" */
  reason: text(),
  durationMs: integer(),
  runId: text().references(() => workflowRuns.id, { onDelete: "set null" }),
  /** Where the task went next. Null when this attempt was the end of it. */
  nextRouteId: text().references(() => modelRoutes.id, { onDelete: "set null" }),
}, (t) => [
  check("route_attempts_outcome_check", inList(t.outcome, ROUTE_OUTCOME)),
  index("route_attempts_recent").on(t.at),
  index("route_attempts_by_route").on(t.routeId, t.at),
]);

export const CHECK_KIND = ["probe", "read", "write"] as const;

/**
 * The last time a configured endpoint answered.
 *
 * "Reached today 09:12 · 41ms", "Answered in 38ms" and "Read today 06:12" are
 * the same fact about three different settings, and every one of them is
 * relative to now — so what is stored is an instant and a duration, and the
 * sentence is built when the screen is drawn.
 */
export const connectionChecks = sqliteTable("connection_checks", {
  id: text().primaryKey(),
  /** The setting that names what was reached: "notion.ds.books". */
  settingKey: text().notNull().references(() => settings.key, { onDelete: "cascade" }),
  at: tsReq(),
  kind: text({ enum: CHECK_KIND }).notNull().default("probe"),
  ok: bool(),
  latencyMs: integer(),
  detail: text(),
}, (t) => [
  check("connection_checks_kind_check", inList(t.kind, CHECK_KIND)),
  index("connection_checks_recent").on(t.settingKey, t.at),
]);
