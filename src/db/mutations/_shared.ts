// The pieces every write in this directory shares.
//
// Four mutation files were written against ../schema/spine.ts independently and
// each arrived at the same handful of helpers, because the spine is the same
// shape under every domain object — that is the whole argument of its header.
// `touch` was byte-identical in three of them, `narrate` in two, and it matters
// more than tidiness: `touch` is the ONLY thing in `src/` that bumps
// `entities.updatedAt`, so three private copies meant the invariant "every
// write touches the supertype" was enforced in three places and could be
// forgotten in a fourth.
//
// The `_` prefix and the shape of this file follow ../queries/_format.ts and
// its siblings, which struck the same bargain on the reading side.
//
// The delete-then-insert protocol below is not carelessness. `narratives` has a
// unique index on (subject, slot, surface, ordinal) and `attributes` on
// (subject, group, ordinal), so a slot that shrinks from three paragraphs to
// one has to lose the third rather than leave it stranded after the end.
import { and, eq } from "drizzle-orm";
import { ulid, type Db } from "../index";
import * as s from "../schema";

/** The handle a transaction callback receives — a Db without `$client`. Every
 *  write in this directory happens inside one, so the shared pieces take this
 *  rather than the database. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type NarrativeSlot = (typeof s.NARRATIVE_SLOT)[number];
export type AttributeGroup = (typeof s.ATTRIBUTE_GROUP)[number];

/** A `[label, value]` line, as the attributes table stores it. */
export type Pair = readonly [label: string, value: string];

/**
 * Bump the supertype so "what changed lately" queries see the edit.
 *
 * Every write calls this. It is the reason a row edited through one surface
 * shows up as recent on another.
 */
export function touch(t: Tx, id: string, now: Date): void {
  t.update(s.entities).set({ updatedAt: now }).where(eq(s.entities.id, id)).run();
}

/** One paragraph of agent prose in one slot. */
export function narrate(
  t: Tx,
  subjectId: string,
  slot: NarrativeSlot,
  text: string,
  generatedAt: Date,
  ordinal = 0,
): void {
  t.insert(s.narratives)
    .values({ id: ulid(), subjectId, slot, surface: "any", ordinal, text, authoredBy: "agent", generatedAt })
    .run();
}

/** Everything written in one slot, gone. */
export function clearSlot(t: Tx, subjectId: string, slot: NarrativeSlot): void {
  t.delete(s.narratives)
    .where(and(eq(s.narratives.subjectId, subjectId), eq(s.narratives.slot, slot)))
    .run();
}

/**
 * Rewrite named prose slots whole.
 *
 * A string is one paragraph, an array is several in order, and `undefined` with
 * `only` set means "the caller did not mention this slot, leave it". Without
 * `only` every named slot is written, which is what a fresh record wants.
 *
 * Whole rather than merged, deliberately: an account is a sequence somebody
 * wrote, and splicing a new paragraph into the middle of one produces prose
 * nobody is responsible for.
 */
export function writeProse(
  t: Tx,
  subjectId: string,
  slots: Partial<Record<NarrativeSlot, string | readonly string[] | undefined>>,
  now: Date,
  opts: { only?: boolean } = {},
): void {
  for (const [slot, value] of Object.entries(slots) as Array<
    [NarrativeSlot, string | readonly string[] | undefined]
  >) {
    if (opts.only && value === undefined) continue;
    clearSlot(t, subjectId, slot);
    if (typeof value === "string") {
      if (value) narrate(t, subjectId, slot, value, now);
    } else {
      (value ?? []).forEach((paragraph, index) => narrate(t, subjectId, slot, paragraph, now, index));
    }
  }
}

/**
 * Rewrite one group of label/value pairs whole.
 *
 * Same bargain as the prose: the ordinal is the order somebody chose, so a
 * shorter list has to shorten rather than leave the tail of the old one behind.
 */
export function writePairs(
  t: Tx,
  subjectId: string,
  groupSlot: AttributeGroup,
  pairs: readonly Pair[],
): void {
  t.delete(s.attributes)
    .where(and(eq(s.attributes.subjectId, subjectId), eq(s.attributes.groupSlot, groupSlot)))
    .run();
  pairs.forEach(([label, value], ordinal) => {
    if (!label.trim() || !value.trim()) return;
    t.insert(s.attributes)
      .values({ id: ulid(), subjectId, groupSlot, ordinal, label: label.trim(), value: value.trim() })
      .run();
  });
}

/**
 * A line on the object's trail.
 *
 * The `history: [{t, text}]` under any record — what the detail panes draw when
 * they say what became of something.
 */
export function note(
  t: Tx,
  subjectId: string,
  text: string,
  at: Date,
  opts: { actor?: (typeof s.ACTOR)[number]; eventKind?: string; runId?: string } = {},
): void {
  t.insert(s.subjectEvents)
    .values({
      id: ulid(),
      subjectId,
      at,
      actor: opts.actor ?? "agent",
      eventKind: opts.eventKind ?? "note",
      text,
      ...(opts.runId ? { runId: opts.runId } : {}),
    })
    .run();
}
