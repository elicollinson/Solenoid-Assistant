// okf/ → okf_objects, okf_fields, okf_conflicts, links, okf_sync_state.
//
// A projection, not a copy: the filesystem stays the source of truth and this
// must be rebuildable by dropping the tables and running again. Two things make
// that safe. Ids are derived (okfObjectId/okfFieldIds hash the uri and the
// value), so a rebuild regenerates exactly the same ids and anything that cited
// a fact still points at it. And the write is an upsert rather than a
// delete-and-reinsert, so evidence links, the access log, and any UI state on
// an object survive a reindex instead of being cascaded away.
//
// What is deliberately NOT written here:
//   * `state`. The design's mark is "attention when this holds something I
//     couldn't settle", which is a fact about the file — derived at query time
//     alongside staleness, which moves with the clock and could not be stored
//     truthfully anyway. The column stays for the day the UI can set one.
//   * narratives. The agent's prose about a memory is the memory: it is already
//     in `description` and the body, both stored verbatim. A second copy in
//     `narratives` would be the same words with a second place to go stale.
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import * as s from "../schema";
import { okfFieldIds, okfObjectId, ulid, type Db } from "../index";
import { openBundle, scanConcepts, type ScannedConcept } from "../../okf";
import { conflictGroups, extractFields } from "./fields";
import { shelfFor } from "./classify";
import { chronologyByConcept, dayInstant, parseLog, type Chronology } from "./chronology";

export interface ReindexResult {
  objects: number;
  fields: number;
  conflicts: number;
  links: number;
  /** Files that could not be parsed. Recorded in okf_sync_state, not thrown. */
  problems: { path: string; message: string }[];
}

export interface ReindexOptions {
  /** Bundle root. */
  root?: string;
  now?: Date;
}

/** "okf:memories/the-orchard-gathering" — stable across a rename of the file
 *  only insofar as the concept id is the path, which is what OKF defines. */
export const uriFor = (conceptId: string) => `okf:${conceptId}`;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Frontmatter dates are ISO strings or nothing. Anything else is dropped rather
 * than coerced — a NaN timestamp is worse than a null one.
 *
 * A bare `YYYY-MM-DD` is a calendar day, not midnight UTC: `stale_after` is
 * written as a day and compared as a day by the spec, and reading it as an
 * instant puts it in the evening before wherever the product runs west of
 * Greenwich. Noon UTC is the same day in every zone it runs in.
 */
function when(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dayInstant(value);
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** `generated: { by: okfManagerAgent, at: 2026-07-27T16:49:55Z }` */
function generated(frontmatter: Record<string, unknown>): { by: string | null; at: Date | null } {
  const raw = frontmatter.generated;
  if (typeof raw !== "object" || raw === null) return { by: null, at: null };
  const record = raw as Record<string, unknown>;
  return {
    by: typeof record.by === "string" ? record.by : null,
    at: when(record.at),
  };
}

export interface SourceEntry {
  resource: string | null;
  title: string | null;
  author: string | null;
}

/** `sources:` is a list of mappings in the spec; a single mapping is read as a
 *  one-element list, the same way `verified` is. */
export function sourceEntries(frontmatter: Record<string, unknown>): SourceEntry[] {
  const raw = frontmatter.sources;
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: SourceEntry[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const str = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : null);
    out.push({ resource: str("resource"), title: str("title"), author: str("author") });
  }
  return out;
}

/**
 * The `sources[].author` values that mean you.
 *
 * `human:user` is the spec's own convention. The rest are the aliases a bundle
 * written by a person tends to pick up; a bundle that signs your entries some
 * other way wants adding here rather than being read as somebody else.
 */
export const SELF_AUTHORS = ["user", "self", "me", "owner", "eli", "eli-collinson"] as const;
const YOU = new RegExp(`^human:(${SELF_AUTHORS.join("|")})$`, "i");

/**
 * Whose claim a fact is.
 *
 * `human:user` is you telling me, and that is the one the design cares about —
 * it is what lets the agent say which facts are yours rather than its own. Any
 * other `human:` is someone else's account of something, which reached me as a
 * record I read rather than as something you asserted, so it is filed as
 * `document` with the person named in `sourceLabel`. A memory with no source
 * author at all was written by the manager agent from context, which is exactly
 * what `agent_inferred` means.
 */
export function provenanceOf(sources: readonly SourceEntry[]): (typeof s.FIELD_PROVENANCE)[number] {
  const authors = sources.map((source) => source.author).filter((a): a is string => !!a);
  if (authors.some((a) => YOU.test(a))) return "user";
  if (authors.length > 0) return "document";
  return "agent_inferred";
}

/** How a `sources[].author` reads on screen. You are "you"; anyone else is
 *  their name, because "human:wren-ashgrove" is an identifier, not a person. */
export function personName(author: string): string {
  return YOU.test(author) ? "you" : author.replace(/^human:/, "").replace(/-/g, " ");
}

/** The mono "Where from" cell: who said it, else what it was read out of. */
export function sourceLabel(sources: readonly SourceEntry[]): string | null {
  const first = sources[0];
  if (!first) return null;
  if (first.author) return personName(first.author);
  return first.resource ?? first.title ?? null;
}

/** `## Related` links, resolved to the concepts they name. */
const LINK = /\[([^\]]*)\]\(([^)]+)\)/g;
export function relatedConcepts(body: string): string[] {
  const out: string[] = [];
  LINK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINK.exec(body)) !== null) {
    const target = match[2] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    const path = (target.split("#")[0] ?? "").replace(/^\//, "");
    if (!path.endsWith(".md")) continue;
    const id = path.slice(0, -3);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

interface Prepared {
  conceptId: string;
  uri: string;
  id: string;
  concept: ScannedConcept;
  chronology: Chronology | undefined;
  related: string[];
}

export async function reindexOkf(db: Db, options: ReindexOptions = {}): Promise<ReindexResult> {
  const root = options.root ?? "okf";
  const now = options.now ?? new Date();

  const bundle = await openBundle(root);
  const { concepts, problems } = await scanConcepts(bundle);

  const logText = await Bun.file(`${root}/log.md`).exists()
    ? await Bun.file(`${root}/log.md`).text()
    : "";
  const chronologies = chronologyByConcept(parseLog(logText));

  // Read every file's bytes up front: the transaction below is synchronous, and
  // bun:sqlite transactions cannot await.
  const prepared: Prepared[] = [];
  const bytes = new Map<string, { size: number; mtime: Date | null; sha: string }>();
  for (const concept of concepts) {
    const file = Bun.file(concept.path);
    const text = await file.text();
    bytes.set(concept.id, {
      size: text.length,
      mtime: file.lastModified ? new Date(file.lastModified) : null,
      sha: sha256(text),
    });
    const uri = uriFor(concept.id);
    prepared.push({
      conceptId: concept.id,
      uri,
      id: okfObjectId(uri),
      concept,
      chronology: chronologies.get(concept.id),
      related: relatedConcepts(concept.body),
    });
  }

  const known = new Set(prepared.map((p) => p.conceptId));

  return db.transaction((t) => {
    let fieldCount = 0;
    let conflictCount = 0;
    let linkCount = 0;

    for (const item of prepared) {
      const { concept, uri, id, chronology } = item;
      const frontmatter = concept.frontmatter;
      const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map(String) : [];
      const shelf = shelfFor(tags);
      const gen = generated(frontmatter);
      const stat = bytes.get(concept.id);
      const relative = concept.path.slice(concept.path.indexOf(basename(root)));

      // The log knows when a memory was opened; the file only knows when it was
      // last written. Fall back to the write time when the log never named it.
      const created = chronology ? dayInstant(chronology.first.date) : (gen.at ?? now);
      const updated = chronology ? dayInstant(chronology.last.date) : (gen.at ?? now);
      const rev = chronology ? chronology.entries.length : 1;

      t.insert(s.entities)
        .values({ id, kind: "okf_object", createdAt: created, updatedAt: updated })
        .onConflictDoUpdate({ target: s.entities.id, set: { updatedAt: updated } })
        .run();

      const row = {
        id,
        uri,
        path: relative,
        okfType: typeof frontmatter.type === "string" ? frontmatter.type : null,
        kind: shelf.kind,
        groupLabel: shelf.group,
        title: typeof frontmatter.title === "string" ? frontmatter.title : concept.id,
        description: typeof frontmatter.description === "string" ? frontmatter.description : null,
        tags,
        status: typeof frontmatter.status === "string" ? frontmatter.status : null,
        rev,
        frontmatter,
        bodyText: concept.body,
        fileMtime: stat?.mtime ?? null,
        fileSize: stat?.size ?? null,
        contentSha256: stat?.sha ?? null,
        generatedBy: gen.by,
        generatedAt: gen.at,
        staleAfter: when(frontmatter.stale_after),
        createdAt: created,
        updatedAt: updated,
        indexedAt: now,
      };

      const { id: _id, createdAt: _createdAt, ...mutable } = row;
      t.insert(s.okfObjects).values(row)
        .onConflictDoUpdate({ target: s.okfObjects.id, set: mutable })
        .run();

      // Fields --------------------------------------------------------------
      const extracted = extractFields(concept.body);
      const ids = okfFieldIds(uri, extracted);
      const groups = conflictGroups(extracted);
      const sources = sourceEntries(frontmatter);
      const provenance = provenanceOf(sources);
      const label = sourceLabel(sources);
      const live = new Set(ids);

      // A field whose value changed has a different derived id, so the old row
      // is no longer produced. Retire it rather than deleting: evidence
      // gathered for the old value stays attached to the old value.
      //
      // Every row already held is parked in the negative ordinals first.
      // `okf_fields_ordinal` is unique on (object, ordinal), so a field that
      // moved up the file would otherwise be inserted into a slot its
      // neighbour has not vacated yet — and so would a replacement taking the
      // slot of the value it replaced. The upsert below lifts the live ones
      // back out as it renumbers them; the retired ones stay parked, ordered
      // among themselves and clear of anything the file can produce.
      const held = t.select().from(s.okfFields).where(eq(s.okfFields.objectId, id)).all();
      let park = Math.min(0, ...held.map((f) => f.ordinal));
      for (const existing of held) {
        park -= 1;
        const retiring = !live.has(existing.id) && !existing.retiredAt;
        t.update(s.okfFields)
          .set(retiring ? { retiredAt: now, ordinal: park } : { ordinal: park })
          .where(eq(s.okfFields.id, existing.id))
          .run();
      }

      extracted.forEach((field, index) => {
        const fieldId = ids[index];
        if (!fieldId) return;
        t.insert(s.entities)
          .values({ id: fieldId, kind: "okf_field", createdAt: created, updatedAt: updated })
          .onConflictDoUpdate({ target: s.entities.id, set: { updatedAt: updated } })
          .run();

        const values = {
          objectId: id,
          ordinal: index,
          label: field.label,
          value: field.value,
          assertedAt: gen.at,
          sourceLabel: label,
          provenance,
          conflictGroupId: groups[index] ?? null,
          retiredAt: null,
          section: field.section || null,
          bodyStart: field.start,
          bodyEnd: field.end,
        };
        t.insert(s.okfFields).values({ id: fieldId, ...values })
          .onConflictDoUpdate({ target: s.okfFields.id, set: values })
          .run();
        fieldCount++;
      });

      // Conflicts -----------------------------------------------------------
      const openGroups = [...new Set(groups.filter((g): g is string => g !== null))];
      for (const groupId of openGroups) {
        t.insert(s.okfConflicts)
          .values({ id: `okfc_${id}_${groupId}`, objectId: id, groupId, label: groupId, openedAt: now })
          .onConflictDoNothing()
          .run();
        conflictCount++;
      }

      // The trail ---------------------------------------------------------
      // Rewritten wholesale each index rather than upserted: log.md is
      // append-only and rev is its length, so the set of entries for an object
      // only ever grows, and a hand-edit that removes one should remove it here.
      t.delete(s.subjectEvents)
        .where(and(eq(s.subjectEvents.subjectId, id), eq(s.subjectEvents.eventKind, "okf_log")))
        .run();
      for (const entry of chronology?.entries ?? []) {
        t.insert(s.subjectEvents)
          .values({
            id: ulid(),
            subjectId: id,
            at: dayInstant(entry.date),
            actor: "agent",
            eventKind: "okf_log",
            text: entry.message,
            data: { kind: entry.kind },
          })
          .run();
      }

      t.insert(s.okfSyncState)
        .values({
          path: relative,
          contentSha256: stat?.sha ?? null,
          fileMtime: stat?.mtime ?? null,
          lastIndexedAt: now,
          status: "ok",
          error: null,
        })
        .onConflictDoUpdate({
          target: s.okfSyncState.path,
          set: { contentSha256: stat?.sha ?? null, fileMtime: stat?.mtime ?? null, lastIndexedAt: now, status: "ok", error: null },
        })
        .run();
    }

    // Links, second pass: both ends have to exist before an edge can name them.
    for (const item of prepared) {
      for (const target of item.related) {
        if (!known.has(target)) continue; // a Related link to a file nobody wrote
        const toId = okfObjectId(uriFor(target));
        if (toId === item.id) continue;
        t.insert(s.links)
          .values({ id: ulid(), fromId: item.id, toId, rel: "references", createdAt: now, createdBy: "agent" })
          .onConflictDoNothing()
          .run();
        linkCount++;
      }
    }

    for (const problem of problems) {
      const relative = problem.path.slice(problem.path.indexOf(basename(root)));
      t.insert(s.okfSyncState)
        .values({ path: relative, lastIndexedAt: now, status: "parse_error", error: problem.message })
        .onConflictDoUpdate({
          target: s.okfSyncState.path,
          set: { lastIndexedAt: now, status: "parse_error", error: problem.message },
        })
        .run();
    }

    return {
      objects: prepared.length,
      fields: fieldCount,
      conflicts: conflictCount,
      links: linkCount,
      problems: problems.map((p) => ({ path: p.path, message: p.message })),
    };
  });
}
