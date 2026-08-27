// The cross-cutting tables. Every domain object in the design carries the same
// shape — prose, key/value meta, a history timeline, typed edges — so it is
// modelled once here rather than as columns on ten tables.
import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { ACTOR, AUTHOR, SCREEN, SURFACE, inList, json, ts, tsReq } from "./_shared";
import { entities, entityRef, entityRefNull } from "./entities";

/** Which piece of prose this is. The design writes a different one per slot. */
export const NARRATIVE_SLOT = [
  "blurb",     // the one-line list summary
  "account",   // the multi-paragraph "why this is here"
  "summary",   // workflow / run summary
  "restraint", // "I have not merged the two Ferris addresses."
  "lede",      // phone list line
  "sheet",     // phone detail line
  "rule",      // a policy in the user's own words
  "conflict",  // the agent's account of a contradiction
  "why",       // why a piece of evidence was cited
  "outcome",   // what followed once a decision was settled, in the agent's words
] as const;

/**
 * Agent-authored prose. `surface` exists because the design deliberately keeps
 * separate copy for phone and desktop — the phone is not the desktop feed at a
 * smaller width.
 */
export const narratives = sqliteTable("narratives", {
  id: text().primaryKey(),
  subjectId: entityRef(),
  slot: text({ enum: NARRATIVE_SLOT }).notNull(),
  surface: text({ enum: SURFACE }).notNull().default("any"),
  ordinal: integer().notNull().default(0),
  text: text().notNull(),
  authoredBy: text({ enum: AUTHOR }).notNull().default("agent"),
  model: text(),
  generatedAt: tsReq(),
}, (t) => [
  check("narratives_slot_check", inList(t.slot, NARRATIVE_SLOT)),
  check("narratives_surface_check", inList(t.surface, SURFACE)),
  check("narratives_authored_by_check", inList(t.authoredBy, AUTHOR)),
  uniqueIndex("narratives_slot_unique").on(t.subjectId, t.slot, t.surface, t.ordinal),
]);

export const SURFACE_NOTE_SLOT = ["line", "restraint", "gate_title", "gate_body"] as const;

/**
 * The agent's line about a screen, and a different one per surface.
 *
 * A screen is not an entity and neither is a day, so this cannot live in
 * `narratives`. It is keyed by screen because the same day carries several of
 * these at once: the calendar's "I have not touched anything after six this
 * evening" and chat's "Nothing has gone out since 09:39" are both today's
 * restraint, and one row could only hold one of them.
 *
 * `onDate` is a local (America/New_York) 'YYYY-MM-DD' when the line is about a
 * particular day, and null when it is about the screen — the settings gate is
 * true until the keys arrive, not until midnight.
 */
export const surfaceNotes = sqliteTable("surface_notes", {
  id: text().primaryKey(),
  screen: text({ enum: SCREEN }).notNull(),
  surface: text({ enum: ["desktop", "phone"] as const }).notNull(),
  slot: text({ enum: SURFACE_NOTE_SLOT }).notNull(),
  onDate: text(),
  text: text().notNull(),
  generatedAt: tsReq(),
  model: text(),
}, (t) => [
  check("surface_notes_screen_check", inList(t.screen, SCREEN)),
  check("surface_notes_surface_check", inList(t.surface, ["desktop", "phone"])),
  check("surface_notes_slot_check", inList(t.slot, SURFACE_NOTE_SLOT)),
  // NULLs are distinct in a SQLite unique index, so the dated and undated rows
  // need a partial index each. Same reason workflow_permissions has one.
  uniqueIndex("surface_notes_dated")
    .on(t.screen, t.surface, t.slot, t.onDate).where(sql`${t.onDate} is not null`),
  uniqueIndex("surface_notes_standing")
    .on(t.screen, t.surface, t.slot).where(sql`${t.onDate} is null`),
  index("surface_notes_by_date").on(t.onDate, t.screen),
]);

export const ATTRIBUTE_GROUP = ["meta", "effect", "stats", "counts"] as const;
export const ATTRIBUTE_VALUE_KIND = ["text", "count", "duration", "money", "timestamp", "ref"] as const;

/**
 * The `meta: [["Kind","workflow run"],["Duration","41m 12s"]]` pairs, plus a
 * recommendation's `effect` pairs. Values are display-ready strings the agent
 * wrote; `refId` lets a pair point at a real row.
 */
export const attributes = sqliteTable("attributes", {
  id: text().primaryKey(),
  subjectId: entityRef(),
  groupSlot: text({ enum: ATTRIBUTE_GROUP }).notNull().default("meta"),
  ordinal: integer().notNull(),
  label: text().notNull(),
  value: text().notNull(),
  valueKind: text({ enum: ATTRIBUTE_VALUE_KIND }).notNull().default("text"),
  refId: entityRefNull(),
}, (t) => [
  check("attributes_group_check", inList(t.groupSlot, ATTRIBUTE_GROUP)),
  check("attributes_value_kind_check", inList(t.valueKind, ATTRIBUTE_VALUE_KIND)),
  uniqueIndex("attributes_ordinal_unique").on(t.subjectId, t.groupSlot, t.ordinal),
]);

/** The `history: [{t, text}]` trail under any object. */
export const subjectEvents = sqliteTable("subject_events", {
  id: text().primaryKey(),
  subjectId: entityRef(),
  at: tsReq(),
  actor: text({ enum: ACTOR }).notNull().default("agent"),
  eventKind: text().notNull().default("note"),
  text: text().notNull(),
  data: json<Record<string, unknown>>(),
  runId: text(),
}, (t) => [
  check("subject_events_actor_check", inList(t.actor, ACTOR)),
  index("subject_events_subject_at").on(t.subjectId, t.at),
]);

export const LINK_REL = [
  "blocks", "derived_from", "references", "supersedes", "about",
  "scoped_to", "triggered_by", "duplicate_of", "answers",
] as const;

/** Typed edges between any two entities. Covers OKF backlinks, "Blocks", "Depends on". */
export const links = sqliteTable("links", {
  id: text().primaryKey(),
  fromId: entityRef(),
  toId: entityRef(),
  rel: text({ enum: LINK_REL }).notNull(),
  label: text(),
  createdAt: tsReq(),
  createdBy: text({ enum: ACTOR }).notNull().default("agent"),
}, (t) => [
  check("links_rel_check", inList(t.rel, LINK_REL)),
  check("links_created_by_check", inList(t.createdBy, ACTOR)),
  uniqueIndex("links_edge_unique").on(t.fromId, t.toId, t.rel),
  index("links_to").on(t.toId, t.rel),
]);

export const EVIDENCE_PIN_KIND = ["whole", "range", "region", "field"] as const;

/**
 * Evidence points straight at the source entity — no artifact header table.
 *
 * Two things live on the link rather than the source: `why`, because the same
 * email cited from a reminder and from an OKF field earns a different sentence;
 * and the pin, because which clause matters depends on why you are citing it.
 *
 * The pin is a character range plus a snapshot of the quoted text, not a
 * paragraph index — indexes break when a page is re-fetched, and the quote lets
 * you re-anchor instead of silently highlighting the wrong sentence.
 */
export const evidenceLinks = sqliteTable("evidence_links", {
  id: text().primaryKey(),
  subjectId: entityRef(),
  sourceId: entityRef(),
  ordinal: integer().notNull().default(0),
  /** What this citation calls the source. Null means the source's own name.
   *  Here for the same reason `why` is: the page a reminder cites as "council
   *  renewal window and late penalties" is headed "Renewing a resident
   *  parking permit", because the title names the part that was cited. */
  title: text(),
  why: text(),
  pinKind: text({ enum: EVIDENCE_PIN_KIND }).notNull().default("whole"),
  pinStart: integer(),
  pinEnd: integer(),
  pinQuote: text(),
  /** screenshot_region or okf_field id, for non-text pins. */
  pinRefId: text(),
  /** Which analysis version was on screen when the agent acted. */
  analysisId: text(),
  relevance: real(),
  addedBy: text({ enum: ["agent", "user"] as const }).notNull().default("agent"),
  addedAt: tsReq(),
}, (t) => [
  check("evidence_links_pin_kind_check", inList(t.pinKind, EVIDENCE_PIN_KIND)),
  check("evidence_links_added_by_check", inList(t.addedBy, ["agent", "user"])),
  uniqueIndex("evidence_links_unique").on(t.subjectId, t.sourceId, t.pinStart, t.pinEnd, t.pinRefId),
  index("evidence_by_subject").on(t.subjectId, t.ordinal),
  index("evidence_by_source").on(t.sourceId),
]);

export const SCREENER = ["prompt_guard", "llm_classifier", "heuristic"] as const;
export const DISPOSITION = ["clean", "quarantined", "rejected", "overridden"] as const;

/** Prompt-injection screening of anything ingested. Mirrors src/workflows. */
export const safetyScreenings = sqliteTable("safety_screenings", {
  id: text().primaryKey(),
  subjectId: entityRef(),
  screenedAt: tsReq(),
  screener: text({ enum: SCREENER }).notNull(),
  model: text(),
  score: real(),
  threshold: real(),
  flagged: integer({ mode: "boolean" }).notNull().default(false),
  concern: text(),
  chunkCount: integer(),
  disposition: text({ enum: DISPOSITION }).notNull(),
  overriddenBy: text(),
  overriddenAt: ts(),
}, (t) => [
  check("safety_screener_check", inList(t.screener, SCREENER)),
  check("safety_disposition_check", inList(t.disposition, DISPOSITION)),
  index("safety_by_subject").on(t.subjectId, t.screenedAt),
]);

export { entities };
