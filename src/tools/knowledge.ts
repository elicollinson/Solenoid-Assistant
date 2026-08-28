// The Knowledge group: the OKF store as this database projects it.
//
// `okf/` on disk is the source of truth. These tables — okf_objects,
// okf_fields, okf_conflicts — are a PROJECTION of that bundle, rebuilt from it
// by `bun run db:index-okf`; see the OKF_ENTITY_KIND note in
// ../db/schema/_shared.ts, which is explicit that nothing clearing the database
// on its way to writing its own rows may take these with it.
//
// That is why this group is read-only, and it is the only interesting thing
// about the file. A write here would land in a cache: correct until the next
// reindex, at which point the indexer would rewrite the row from the file that
// never mentioned it and the change would vanish with no error and no trace.
// Writes to knowledge go through the OKF bundle tools — the separate `okf`
// group — which write the markdown the projection is built FROM, so the change
// survives the rebuild because the rebuild reads it.
//
// So: there is no create tool here, no patch tool, and adding one would not be
// an improvement. If you want to change what is known, open the `okf` group.
// The same thing is said again in `purpose` and `guidance` at the foot of this
// file, because that is the only copy the MODEL ever reads and a group whose
// missing write tool is unexplained is a group an agent improvises around.
//
// What this file deliberately does not describe:
//
//   * okf_access_log. It is the reading trail behind "read 31 times · last read
//     Today 06:12" and the retirement signal for facts nothing has touched
//     since May. It is about the agent's own behaviour rather than about what
//     is known, and an agent reading its own read-log while deciding what to
//     read next is a feedback loop nobody asked for.
//   * okf_sync_state. Per-file indexer bookkeeping — a sha, an mtime, a parse
//     error. It answers "did the last index run cleanly", which is an operator's
//     question and has no bearing on what any memory says.
//
// A factory rather than module-level singletons, for the reason ./okf.ts and
// ./recommendations.ts are both factories: the database handle is bound at
// construction, so nothing the model says can redirect these at another store.
import { z } from "zod";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { defineToolGroup, type DerivedField, type ToolGroup } from "../core/toolGroups";
import { defineTool } from "../core/tools";
import type { Db } from "../db";
import * as s from "../db/schema";
import { describeTable } from "../db/schemaDoc";
import { loadKnowledge, loadKnowledgeObject } from "../db/queries/knowledge";
import { GROUPS } from "../db/okf/classify";
import type { ToolGroupContext } from "./groups";

// ---------------------------------------------------------------------------
// Small helpers, kept out of the tool bodies
// ---------------------------------------------------------------------------

/** How much of a memory's body a search hit is quoted with. */
const EXCERPT_RADIUS = 90;

/**
 * An object's id, whether the caller passed the id or the uri.
 *
 * A model that has just read a list carrying both will sooner or later hand
 * back the wrong one, and "no memory with id okf:memories/x" is a dead end it
 * cannot debug. Both are unique, so accepting either costs nothing.
 */
function resolveObjectId(db: Db, idOrUri: string): string | undefined {
  const byId = db
    .select({ id: s.okfObjects.id })
    .from(s.okfObjects)
    .where(eq(s.okfObjects.id, idOrUri))
    .get();
  if (byId) return byId.id;
  return db
    .select({ id: s.okfObjects.id })
    .from(s.okfObjects)
    .where(eq(s.okfObjects.uri, idOrUri))
    .get()?.id;
}

/** The text around the first occurrence, so a hit can be judged without a read. */
function excerpt(haystack: string, needle: string): string | null {
  const at = haystack.toLowerCase().indexOf(needle);
  if (at < 0) return null;
  const from = Math.max(0, at - EXCERPT_RADIUS);
  const to = Math.min(haystack.length, at + needle.length + EXCERPT_RADIUS);
  const body = haystack.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${body}${to < haystack.length ? "…" : ""}`;
}

// ---------------------------------------------------------------------------
// The shape of one memory
// ---------------------------------------------------------------------------

const SPINE = describeTable(s.okfObjects, {
  id: "The handle every other tool here takes. Stable across a reindex — it is a hash of the uri, not a minted key.",
  uri: "'okf:memories/the-shed-roof'. What a citation from anywhere else in the product names this memory by, and what to quote when you refer to it in prose.",
  path: "Where the file actually is in the bundle: 'okf/memories/the-shed-roof.md'. This is the thing the okf group's tools take.",
  okfType: "The file's frontmatter `type`. In this bundle it is 'Memory' on essentially every file, so it tells you almost nothing; use `kind` instead.",
  kind: "What the memory is ABOUT, derived from its tags: person | health | work | travel | home | plan | interest | note. Not stated in the file — see src/db/okf/classify.ts, where the rules are ordered and first-match-wins.",
  groupLabel: "The section heading `kind` belongs to — 'People and contacts', 'Work and career', 'Everything else'. This is what knowledge_list's `group` filter matches.",
  title: "The memory's own title, as written. Read as given and never rephrased.",
  description: "The one line under the title. The user's own summary of the memory, not a generated one.",
  tags: "The file's tags. These are what `kind` and `groupLabel` were derived from, so they are the honest answer to 'why is this filed here'.",
  status: "The file's own status: 'deprecated' means the bundle keeps it for the record and it is no longer in play. Usually null, which means current.",
  rev: "How many times the bundle log has an entry for this memory. A rewrite count, not a version you can fetch.",
  state: "A mark set through the UI, not read off the file. Note the list surface does NOT use it — the mark a person sees is derived from conflicts and status against the clock, because a stored 'stale' is wrong by morning.",
  frontmatter: null, // Everything worth reading out of it is already a column.
  bodyText: "The memory as written, in full markdown. knowledge_read hands it back split into headed sections instead; this is here so you know the prose is what most memories hold — only about a quarter of them state anything field-shaped.",
  fileMtime: null, // Indexer bookkeeping: how the scanner decides to re-read.
  fileSize: null,
  contentSha256: null,
  generatedBy: "Who wrote the file — an agent name, or absent when a person did.",
  generatedAt: "When it was written, per the file's own frontmatter rather than per the index.",
  verifiedAt: "When somebody last confirmed it was still true. Usually null: most memories have never been checked, and that is worth saying plainly rather than treating as verified.",
  staleAfter: "The date the memory said to look at it again. Past it, treat what it says as unchecked — but note going stale is something the calendar did, not a signal anybody needs you.",
  createdAt: "When the memory first entered the store.",
  updatedAt: "When it was last written. This is the sort order of knowledge_list and the 'when' a person sees.",
  indexedAt: null, // When the projection last rebuilt this row, not about the memory.
  indexVersion: null,
});

const FACTS = describeTable(s.okfFields, {
  id: "The fact's own id. Stable across a reindex, but only while its value is unchanged — the id hashes the value, so an edited fact is a different fact.",
  objectId: null, // Join key; you reach fields through their memory.
  ordinal: "Where it sat in the file. The order facts are meant to be read in.",
  label: "The left column: 'billing address', 'Quote', 'Primary phone'. Two live facts sharing a label on one memory is exactly what a conflict is.",
  value: "The fact itself, as written. Never normalised, never re-worded.",
  assertedAt: "When the file asserting it was written.",
  sourceLabel: "Where it came from, in the file's own words: 'invoice 4412', 'you', 'phone log'.",
  provenance: "Whose claim this is. 'user' means they told you; 'agent_inferred' means you worked it out and nobody has confirmed it; 'agent_confirmed' means you guessed and they agreed. This is the difference between 'you said' and 'I think', so do not flatten it when you report a fact back.",
  confirmedAt: "When it was confirmed, for the ones that were.",
  conflictGroupId: "Set when this fact disagrees with another on the same memory; both carry the same value here and neither is superseded. Matches okf_conflicts.groupId.",
  supersededById: "The later fact that replaced this one, when one did.",
  retiredAt: "When it stopped being live. The read tools return only facts where this is null; a retired fact is history, not knowledge.",
  section: "The '## Heading' it sat under in the file.",
  bodyStart: null, // Character offsets, so a WRITE can patch in place. Not for you.
  bodyEnd: null,
});

const CONFLICTS = describeTable(s.okfConflicts, {
  id: "The conflict's own id.",
  objectId: null, // Join key; knowledge_conflicts reports the memory alongside.
  groupId: "What the disagreeing facts have in common. Join it to okf_fields.conflictGroupId to see the competing values.",
  label: "The question being answered twice, in the file's own words.",
  decisionId: "The decision opened to settle it, when one was. Null means nobody has been asked.",
  openedAt: "When the index first noticed the disagreement.",
  resolvedAt: "When it was settled. Null means it is still open, which is what knowledge_conflicts returns by default.",
  resolution: "How it was settled. 'kept_both' is a real answer, not a failure to answer — two billing addresses can both be true.",
});

const DERIVED: DerivedField[] = [
  {
    name: "facts",
    type: "number",
    note:
      "How many live facts the memory holds. Counted on read, and often zero — most memories state what " +
      "they know in prose, and this counts only what is field-shaped.",
  },
  {
    name: "stale",
    type: "boolean",
    note:
      "Past its own `staleAfter`, compared by calendar day. Derived against the clock on every read, " +
      "because a stored one would be wrong by morning.",
  },
  {
    name: "sections",
    type: "{ heading, paragraphs[] }[]",
    note:
      "The memory's prose, split at its own '## ' headings. This is the record itself, and for most " +
      "memories it is the whole of what they know; knowledge_read returns it in place of the raw body.",
  },
  {
    name: "account",
    type: "string[]",
    note:
      "'How I came to know this' — who wrote the file, what it cites, how many times it was rewritten, " +
      "whether its review date has passed. Every sentence is a true statement about the file rather than " +
      "a recollection, so it is safe to repeat and worth repeating.",
  },
];

const PURPOSE = `
This is the store of what is known about the user — who the people in their life
are, what was decided, what they told you and what you worked out for yourself.
Read it before answering anything personal, and read it before asking them
something they may already have told you.

Every memory is a markdown file in the OKF bundle on disk, and the bundle is the
source of truth. What these tools read is a PROJECTION of it, which
\`db:index-okf\` rebuilds from those files. That is why there is no write tool
here and why adding one would be a mistake rather than an omission: a row
written into the projection would be correct until the next reindex and then
silently gone, because the indexer would rewrite it from a file that never
mentioned it. To change what is known, open the \`okf\` group and write the
file — the change then survives the rebuild, because the rebuild reads it. Do
not go looking for knowledge_create, and do not improvise around its absence.
`;

const GUIDANCE = `
A memory holds two things and they are not the same. The prose is the record,
written as the user or the agent put it, and it is what most memories are. The
facts are the field-shaped assertions the indexer could lift out of that prose —
only about a quarter of memories state any — and each one carries a provenance
saying whose claim it is. "You told me" and "I inferred it" are different claims,
and reporting the second as the first is how a guess becomes something the user
believes they said.

Where a memory answers the same question twice, both answers were kept and
neither was superseded, because overwriting one would have hidden the change from
the user. A conflict is therefore not damage to tidy away: it is the thing this
projection is uniquely good at knowing. Say both answers out loud and let them
pick. Never quietly prefer the newer one — newer is not the same as current.

\`staleAfter\` is a date the memory set for its own review. Past it the memory is
unchecked rather than wrong, and going stale is something the calendar did rather
than something that needs anybody. Retired facts are returned by none of these
tools: what you get back is what is live.
`;

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

/**
 * The shelf filter, offered as an enum so a misremembered heading is a
 * validation error rather than a silently empty list.
 *
 * The cast is because the taxonomy is a `readonly string[]` and `z.enum` wants
 * a non-empty tuple; GROUPS is built from SHELVES plus a fallback, so it can
 * never be empty.
 */
const shelfSchema = z
  .enum(GROUPS as [string, ...string[]])
  .describe(
    "Return only memories filed under this heading. The shelf comes from the file's tags rather than from " +
      "its subject, so a memory can sit somewhere you would not have guessed — use knowledge_search when " +
      "you care about what a memory is about rather than where it is filed.",
  );

const limitSchema = z.number().int().positive().max(200).default(50);

export function knowledgeGroup(context: ToolGroupContext): ToolGroup {
  const { db } = context;

  const list = defineTool({
    name: "knowledge_list",
    kind: "read",
    description:
      "List what is in the store, most recently written first: each memory's id, uri, title, one-line blurb, " +
      "which shelf it is on, how many discrete facts came out of it and when it was last written. " +
      "This is the cheap first step before answering anything about the user from memory — it is a few hundred " +
      "rows of one line each, so read it rather than guessing what you might know. " +
      "It does NOT return the memories themselves; the blurb is a summary and quoting it as if it were the " +
      "record is how you end up asserting something the file does not say. Follow with knowledge_read. " +
      "Use knowledge_search instead when you are looking for a subject rather than browsing a shelf.",
    schema: z.object({
      group: shelfSchema.optional(),
      kind: z
        .enum(["person", "health", "work", "travel", "home", "plan", "interest", "note"])
        .optional()
        .describe("Narrower than `group` and derived from the same tags. Use one or the other, not both."),
      conflictedOnly: z
        .boolean()
        .default(false)
        .describe("Only memories that state something twice with different answers. knowledge_conflicts says WHAT disagrees; this only narrows the list."),
      staleOnly: z
        .boolean()
        .default(false)
        .describe("Only memories past the date they themselves said to check again. Being stale does not make a memory wrong — it makes it unchecked."),
      limit: limitSchema,
    }),
    execute: ({ group, kind, conflictedOnly, staleOnly, limit }) => {
      const payload = loadKnowledge(db);
      const rows = payload.rows
        .filter((row) => (group ? row.group === group : true))
        .filter((row) => (kind ? row.kind === kind : true))
        .filter((row) => (conflictedOnly ? row.state === "attention" : true))
        .filter((row) => (staleOnly ? row.stale : true))
        .slice(0, limit);
      return { lede: payload.lede, groups: payload.groups, count: rows.length, rows };
    },
  });

  const read = defineTool({
    name: "knowledge_read",
    kind: "read",
    description:
      "Read one memory in full: its prose as written, split into its headed sections; every live fact it " +
      "states, each with where it came from and whose claim it is; what it cites as its sources; the other " +
      "memories that point at it; and the bundle log's trail of when it was written and rewritten. " +
      "Read the memory before you assert anything from it. The list's blurb is a summary and the facts carry " +
      "provenance that the summary drops — 'you told me' and 'I inferred it' are different claims, and " +
      "reporting the second as the first is the specific mistake this tool exists to prevent. " +
      "A memory holding an unresolved conflict comes back with both answers and a note saying so; do not " +
      "pick one silently.",
    schema: z.object({
      id: z
        .string()
        .min(1)
        .describe("The memory's id from knowledge_list or knowledge_search. Its 'okf:...' uri works too, so you need not check which one you kept."),
    }),
    execute: ({ id }) => {
      const objectId = resolveObjectId(db, id);
      const memory = objectId ? loadKnowledgeObject(db, objectId) : null;
      return memory ?? { error: `No memory with id or uri ${id}` };
    },
  });

  const search = defineTool({
    name: "knowledge_search",
    kind: "read",
    description:
      "Find memories mentioning a word or phrase, in their title, their blurb, their prose or the facts they " +
      "state. Answers with one row per memory saying WHERE it matched and quoting the text around the hit, so " +
      "you can tell a passing mention from the memory that is actually about it before spending a read. " +
      "This is a plain substring match, case-insensitive and not stemmed: 'walk' finds 'walking', 'walked' " +
      "does not find 'walk', and nothing here understands synonyms. Search for the plainest word the file " +
      "would use, and search twice with different words rather than trusting one empty result — an empty " +
      "result means those characters do not appear, not that nothing is known about the subject.",
    schema: z.object({
      query: z
        .string()
        .min(2)
        .describe("The word or phrase to look for. Two characters minimum; a one-letter search matches everything and tells you nothing."),
      group: shelfSchema.optional(),
      includeBody: z
        .boolean()
        .default(true)
        .describe("Search the memories' prose as well as their titles, blurbs and facts. Turn this off to find only memories that are ABOUT the term rather than ones that mention it in passing."),
      limit: limitSchema,
    }),
    execute: ({ query, group, includeBody, limit }) => {
      const needle = query.toLowerCase();

      // Matched in TypeScript rather than in SQL. The FTS5 `search` table this
      // database carries is written by the app on commit and the OKF reindexer
      // does not write it, so a query against it would answer "nothing known"
      // about a store that knows plenty. A scan of a few hundred memories is
      // cheap and, unlike a silently empty index, honest.
      const objects = db
        .select()
        .from(s.okfObjects)
        .orderBy(desc(s.okfObjects.updatedAt))
        .all()
        .filter((object) => (group ? (object.groupLabel ?? "Everything else") === group : true));

      const fields = db
        .select()
        .from(s.okfFields)
        .where(isNull(s.okfFields.retiredAt))
        .orderBy(s.okfFields.ordinal)
        .all();

      const factsFor = new Map<string, typeof fields>();
      for (const field of fields) {
        const held = factsFor.get(field.objectId);
        if (held) held.push(field);
        else factsFor.set(field.objectId, [field]);
      }

      const rows = [];
      for (const object of objects) {
        if (rows.length >= limit) break;
        const where: string[] = [];
        if (object.title.toLowerCase().includes(needle)) where.push("title");
        if (object.description?.toLowerCase().includes(needle)) where.push("blurb");
        if (object.tags.some((tag) => tag.toLowerCase().includes(needle))) where.push("tag");

        const facts = (factsFor.get(object.id) ?? []).filter(
          (field) =>
            field.label.toLowerCase().includes(needle) || field.value.toLowerCase().includes(needle),
        );
        if (facts.length) where.push("fact");

        const body = includeBody ? excerpt(object.bodyText, needle) : null;
        if (body) where.push("prose");
        if (!where.length) continue;

        rows.push({
          id: object.id,
          uri: object.uri,
          name: object.title,
          group: object.groupLabel ?? "Everything else",
          matchedIn: where,
          blurb: object.description ?? "",
          facts: facts.map((field) => ({ label: field.label, value: field.value, provenance: field.provenance })),
          ...(body ? { excerpt: body } : {}),
        });
      }
      return { query, count: rows.length, rows };
    },
  });

  const conflicts = defineTool({
    name: "knowledge_conflicts",
    kind: "read",
    description:
      "List the places a memory answers the same question twice with different answers, and what the competing " +
      "answers actually are — the memory, the label being answered twice, and every live fact under it with " +
      "its source and its provenance. " +
      "Both answers were kept on purpose: overwriting the older one would have hidden the change, so nothing " +
      "here is a bug to be tidied away. Read this before reporting any fact whose label appears in it, and say " +
      "both answers rather than picking the newer one — newer is not the same as current, which is the whole " +
      "reason these rows exist. " +
      "You cannot settle a conflict from this group. Resolving one means editing the file it came from, which " +
      "is the okf group's tools; a person deciding is what the `decisionId` here is for.",
    schema: z.object({
      includeResolved: z
        .boolean()
        .default(false)
        .describe("Include the ones already settled, with how they were settled. Off by default: an open conflict is a thing to say out loud, a settled one is history."),
      limit: limitSchema,
    }),
    execute: ({ includeResolved, limit }) => {
      const open = isNull(s.okfConflicts.resolvedAt);
      const rows = db
        .select({
          id: s.okfConflicts.id,
          objectId: s.okfConflicts.objectId,
          groupId: s.okfConflicts.groupId,
          label: s.okfConflicts.label,
          decisionId: s.okfConflicts.decisionId,
          openedAt: s.okfConflicts.openedAt,
          resolvedAt: s.okfConflicts.resolvedAt,
          resolution: s.okfConflicts.resolution,
          memory: s.okfObjects.title,
          uri: s.okfObjects.uri,
        })
        .from(s.okfConflicts)
        .innerJoin(s.okfObjects, eq(s.okfObjects.id, s.okfConflicts.objectId))
        .where(includeResolved ? undefined : open)
        .orderBy(desc(s.okfConflicts.openedAt))
        .limit(limit)
        .all();

      const objectIds = [...new Set(rows.map((row) => row.objectId))];
      const competing = objectIds.length
        ? db
            .select()
            .from(s.okfFields)
            .where(and(inArray(s.okfFields.objectId, objectIds), isNull(s.okfFields.retiredAt)))
            .orderBy(s.okfFields.ordinal)
            .all()
        : [];

      return {
        count: rows.length,
        rows: rows.map((row) => ({
          id: row.id,
          memory: { id: row.objectId, uri: row.uri, name: row.memory },
          label: row.label,
          openedAt: row.openedAt,
          resolvedAt: row.resolvedAt,
          resolution: row.resolution,
          decisionId: row.decisionId,
          answers: competing
            .filter((field) => field.objectId === row.objectId && field.conflictGroupId === row.groupId)
            .map((field) => ({
              id: field.id,
              value: field.value,
              assertedAt: field.assertedAt,
              source: field.sourceLabel,
              provenance: field.provenance,
            })),
        })),
      };
    },
  });

  return defineToolGroup({
    name: "knowledge",
    summary:
      "What I have written down about the user and their life: a few hundred memories, the discrete facts " +
      "pulled out of them, and the places two of those facts disagree.",
    purpose: PURPOSE,
    guidance: GUIDANCE,
    shape: {
      singular: "memory",
      spine: SPINE,
      related: [
        { label: "The facts pulled out of it — one row per field-shaped assertion, in the order the file states them", fields: FACTS },
        { label: "Where it answers the same question twice — one row per unsettled disagreement", fields: CONFLICTS },
      ],
      derived: DERIVED,
    },
    tools: [list, read, search, conflicts],
  });
}
