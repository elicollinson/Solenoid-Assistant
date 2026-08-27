// The Things I know surface: the store as a list, and one memory in full.
//
// The design's fixtures store a group ("People"), a mark ("attention"), a fact
// count and a "when" as display strings. All four are properties of the file
// read against the clock and the tags, so all four are computed here. What is
// read as written is the memory itself — its title, description, body and
// sources are the user's own record and this surface's whole job is to show
// them without editorialising.
//
// The one thing the design has and this cannot is a re-openable artifact behind
// every fact. A memory cites `sources: [{resource, title, author}]` — a
// descriptor of where it came from, not a copy of it. So sources are listed and
// not clickable, rather than opening a viewer onto nothing.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../index";
import * as s from "../schema";
import type {
  KnowledgeDetailPayload,
  KnowledgeField,
  KnowledgeFilter,
  KnowledgePayload,
  KnowledgeRef,
  KnowledgeRow,
  KnowledgeSource,
  KnowledgeTrailLine,
} from "../../shared/knowledge";
import type { HomeState } from "../../shared/home";
import type { Surface } from "../../shared/surface";
import { capitalise, dayKey, dayName, shortDay, spell, stampYear } from "./_format";
import { surfaceNote } from "./_surface";
import { GROUPS } from "../okf/classify";
import { readableSections } from "../okf/fields";
import { personName, sourceEntries } from "../okf/reindex";

export type * from "../../shared/knowledge";

type OkfObject = typeof s.okfObjects.$inferSelect;
type OkfField = typeof s.okfFields.$inferSelect;

/**
 * Past its own `stale_after`. A date comparison, so it moves with the clock and
 * could never have been stored truthfully.
 *
 * Compared by calendar day rather than by instant, which is how the spec writes
 * the rule and how a person reads it: a memory to review by the 20th is not
 * unreviewed at breakfast on the 20th and reviewed again by lunch.
 */
const isStale = (o: OkfObject, now: Date) => o.staleAfter != null && dayKey(now) >= dayKey(o.staleAfter);

/**
 * The mark on the row.
 *
 * The design's `attention` means "this holds something I couldn't settle on my
 * own", which here is a memory asserting one label twice with two answers.
 * `done` is a memory the bundle has deprecated: kept for the record, not in
 * play. Everything else is quiet, including stale — going stale is a thing the
 * calendar did, not a thing that needs you.
 */
function markFor(o: OkfObject, conflicted: boolean): HomeState {
  if (conflicted) return "attention";
  if (o.status === "deprecated") return "done";
  return "idle";
}

/** "Today", "Yesterday", "Aug 21" — the day the memory was last written. */
const writtenOn = (o: OkfObject, now: Date) => dayName(o.updatedAt, now);

function rowFor(o: OkfObject, facts: number, conflicted: boolean, now: Date): KnowledgeRow {
  return {
    id: o.id,
    uri: o.uri,
    name: o.title,
    kind: o.kind ?? "note",
    group: o.groupLabel ?? "Everything else",
    state: markFor(o, conflicted),
    facts,
    when: writtenOn(o, now),
    blurb: o.description ?? "",
    stale: isStale(o, now),
  };
}

/** Object id → how many live fields it holds, in one pass rather than per row. */
function factCounts(db: Db): Map<string, number> {
  const rows = db
    .select({ objectId: s.okfFields.objectId, n: sql<number>`count(*)` })
    .from(s.okfFields)
    .where(sql`${s.okfFields.retiredAt} is null`)
    .groupBy(s.okfFields.objectId)
    .all();
  return new Map(rows.map((r) => [r.objectId, Number(r.n)]));
}

/** The objects holding an unresolved conflict. */
function conflictedIds(db: Db): Set<string> {
  const rows = db
    .select({ objectId: s.okfConflicts.objectId })
    .from(s.okfConflicts)
    .where(sql`${s.okfConflicts.resolvedAt} is null`)
    .all();
  return new Set(rows.map((r) => r.objectId));
}

/**
 * The line under the heading.
 *
 * The design writes two variants by hand, one for a clean store and one for a
 * store holding a conflict. Both are statements of fact about the list, so both
 * are counted rather than chosen.
 *
 * `authored` replaces only the opening, and only where a surface has written
 * one — the phone says "Everything I've written down" because two counts and a
 * conjunction do not fit above a 390px list. What follows it stays counted:
 * an authored sentence claiming one unsettled memory would be wrong the moment
 * a second turned up.
 */
function ledeFor(rows: readonly KnowledgeRow[], facts: number, authored = ""): string {
  const opening = authored || `${spell(rows.length)} things I've written down about you and your life, and ${
    facts === 0 ? "no" : spell(facts)
  } discrete facts pulled out of them.`;
  const unsettled = rows.filter((r) => r.state === "attention").length;
  const stale = rows.filter((r) => r.stale).length;

  const parts = [capitalise(opening)];
  if (unsettled === 1) parts.push("One of them holds two answers to the same question and I haven't picked between them.");
  else if (unsettled > 1) parts.push(capitalise(`${spell(unsettled)} of them hold two answers to the same question and I haven't picked between them.`));
  if (stale === 1) parts.push("One is past the date I said I'd check it again.");
  else if (stale > 1) parts.push(capitalise(`${spell(stale)} are past the date I said I'd check them again.`));
  return parts.join(" ");
}

export function loadKnowledge(db: Db, now: Date = new Date(), surface: Surface = "desktop"): KnowledgePayload {
  const objects = db
    .select()
    .from(s.okfObjects)
    .orderBy(desc(s.okfObjects.updatedAt), s.okfObjects.title)
    .all();

  const facts = factCounts(db);
  const conflicted = conflictedIds(db);

  const rows = objects.map((o) => rowFor(o, facts.get(o.id) ?? 0, conflicted.has(o.id), now));

  // Group order comes from the taxonomy, not from the data, so the sections
  // stay in the same order whichever of them happen to be empty today.
  const present = new Set(rows.map((r) => r.group));
  const groups = GROUPS.filter((g) => present.has(g));

  const filters: KnowledgeFilter[] = [
    { label: "All", group: null, count: rows.length },
    ...groups.map((group) => ({
      label: group,
      group,
      count: rows.filter((r) => r.group === group).length,
    })),
  ];

  const totalFacts = [...facts.values()].reduce((sum, n) => sum + n, 0);
  return {
    lede: ledeFor(rows, totalFacts, surfaceNote(db, "knowledge", "line", surface)),
    restraint: surfaceNote(db, "knowledge", "restraint", surface) || null,
    groups,
    filters,
    rows,
  };
}

/** How a field's provenance reads in a column headed "Where from". */
const PROVENANCE: Record<string, string> = {
  user: "you told me",
  agent_confirmed: "I guessed, you confirmed",
  agent_inferred: "I inferred it",
  document: "read from a record",
  tool: "a tool returned it",
};

function fieldFor(f: OkfField, conflicted: boolean, now: Date): KnowledgeField {
  return {
    id: f.id,
    label: f.label,
    value: f.value,
    when: f.assertedAt ? dayName(f.assertedAt, now) : "—",
    source: f.sourceLabel ?? "—",
    provenance: PROVENANCE[f.provenance] ?? f.provenance,
    conflict: conflicted,
    section: f.section,
  };
}

/**
 * "How I came to know this."
 *
 * The design writes this by hand per object. Every sentence here is instead a
 * true statement about the file: who generated it, what it cites, how many
 * times it has been rewritten, and whether it is past its own review date. A
 * generated paragraph that read like the design's would be the agent claiming a
 * memory of writing something it has no record of.
 */
function accountFor(o: OkfObject, sources: readonly KnowledgeSource[], trail: readonly KnowledgeTrailLine[], now: Date): string[] {
  const out: string[] = [];

  const opened = trail.length ? trail[trail.length - 1]?.t : null;
  const by = o.generatedBy ? `I wrote this one` : `This one was written`;
  out.push(
    opened
      ? `${by} on ${opened}${trail.length > 1 ? `, and rewrote it ${spell(trail.length - 1)} time${trail.length === 2 ? "" : "s"} since` : ""}.`
      : `${by} and the bundle log has no entry for it, so I can't say when.`,
  );

  if (sources.length === 1 && sources[0]) {
    out.push(`It rests on one source: ${sources[0].title}${sources[0].who ? ` — ${sources[0].who}` : ""}.`);
  } else if (sources.length > 1) {
    out.push(`It rests on ${spell(sources.length)} sources, listed beside this.`);
  } else {
    out.push("It names no source, so all I can tell you is that I wrote it down.");
  }

  if (o.staleAfter) {
    out.push(
      isStale(o, now)
        ? `I said I'd look at this again by ${shortDay(o.staleAfter)} and that date has passed, so treat it as something I haven't checked lately.`
        : `I'll check this again by ${shortDay(o.staleAfter)}.`,
    );
  }

  return out;
}

export function loadKnowledgeObject(db: Db, id: string, now: Date = new Date()): KnowledgeDetailPayload | null {
  const object = db.select().from(s.okfObjects).where(eq(s.okfObjects.id, id)).get();
  if (!object) return null;

  const fields = db
    .select()
    .from(s.okfFields)
    .where(and(eq(s.okfFields.objectId, id), sql`${s.okfFields.retiredAt} is null`))
    .orderBy(s.okfFields.ordinal)
    .all();

  const conflicts = db
    .select()
    .from(s.okfConflicts)
    .where(and(eq(s.okfConflicts.objectId, id), sql`${s.okfConflicts.resolvedAt} is null`))
    .all();
  const openGroups = new Set(conflicts.map((c) => c.groupId));

  const trail: KnowledgeTrailLine[] = db
    .select()
    .from(s.subjectEvents)
    .where(and(eq(s.subjectEvents.subjectId, id), eq(s.subjectEvents.eventKind, "okf_log")))
    .orderBy(desc(s.subjectEvents.at))
    .all()
    .map((e) => ({
      t: stampYear(e.at).replace(/, \d\d:\d\d$/, ""),
      kind: String((e.data as { kind?: string } | null)?.kind ?? "Update"),
      text: e.text,
    }));

  // What links here. Inbound rather than outbound: the design's "Where I've
  // used it" asks where this fact turns up, and in a bundle of memories the
  // answer is the memories that cite it.
  const inbound = db
    .select({ fromId: s.links.fromId })
    .from(s.links)
    .where(and(eq(s.links.toId, id), eq(s.links.rel, "references")))
    .all()
    .map((l) => l.fromId);

  const refs: KnowledgeRef[] = inbound.length
    ? db
        .select()
        .from(s.okfObjects)
        .where(inArray(s.okfObjects.id, inbound))
        .orderBy(desc(s.okfObjects.updatedAt))
        .all()
        .map((o) => ({ id: o.id, label: o.title, when: writtenOn(o, now) }))
    : [];

  const sources: KnowledgeSource[] = sourceEntries(object.frontmatter).map((source) => {
    const title = source.title ?? source.resource ?? "an unnamed source";
    const who = source.author ? personName(source.author) : (source.resource ?? "");
    // `resource: user-request` under `title: User request` says it twice.
    const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
    return { title, who: slug(who) === slug(title) ? "" : who };
  });

  const facts = fields.length;
  const conflicted = openGroups.size > 0;
  const row = rowFor(object, facts, conflicted, now);

  const conflict = conflicted
    ? `This memory states ${conflicts.length === 1 ? `"${conflicts[0]?.label}"` : `${spell(conflicts.length)} things`} more than once, with different answers each time. I kept both rather than overwriting one, because overwriting would have hidden the change from you.`
    : null;

  const meta = [
    { label: "Kind", value: object.kind ?? "note" },
    { label: "Revision", value: `rev ${object.rev}` },
    { label: "Opened", value: trail.length ? (trail[trail.length - 1]?.t ?? "—") : "—" },
    { label: "Last written", value: writtenOn(object, now) },
    { label: "Review by", value: object.staleAfter ? shortDay(object.staleAfter) : "no date set" },
    { label: "Status", value: object.status ?? "stable" },
  ];

  return {
    ...row,
    account: accountFor(object, sources, trail, now),
    conflict,
    fields: fields.map((f) => fieldFor(f, openGroups.has(f.conflictGroupId ?? ""), now)),
    sections: readableSections(object.bodyText),
    meta,
    trail,
    refs,
    sources,
    tags: object.tags,
    path: object.path,
    rev: object.rev,
  };
}
