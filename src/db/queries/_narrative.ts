// The agent's prose about one object, picked for the screen asking.
//
// `narratives.surface` is "any" for almost everything the agent writes: an
// account of why a reminder exists reads the same on either frame. The phone
// slots — `lede` for a list row, `sheet` for the detail behind it — are the
// exception, and they exist because the design writes those twice rather than
// letting the desktop's sentence wrap four times at 390px.
//
// Reading them is the same fallback the surface notes use: the surface's own
// words, then "any", then nothing. A row with no phone lede draws its desktop
// blurb, which is long rather than missing.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Surface } from "../../shared/surface";
import type { Db } from "../index";
import * as s from "../schema";

type Slot = (typeof s.NARRATIVE_SLOT)[number];
/** What `narratives.surface` accepts: the two frames plus "written for both". */
type Written = (typeof s.SURFACE)[number];

/** Best first. "any" is what the seed writes when it writes one copy for both. */
const preference = (surface: Surface): readonly Written[] => [surface, "any"];

/**
 * One slot's prose for many subjects at once, keyed by subject.
 *
 * A list draws one of these per row, so it reads the whole slot in one query
 * rather than one per row. Ordinal 0 only: the slots this serves are single
 * sentences, and a slot that runs to paragraphs wants `narrativeLines`.
 *
 * `subjectIds` scopes the read to the page that asked for it. Without it this
 * reads every row of the slot in the table, which is fine for a screen that
 * draws the whole list and wrong for a tool that answers with fifty of them —
 * the cost then grows with everything ever written rather than with the
 * question. Pass the ids when you have them; the screens that genuinely want
 * all of them simply do not.
 */
export function narrativeBySubject(
  db: Db,
  slot: Slot,
  surface: Surface = "desktop",
  subjectIds?: readonly string[],
): Map<string, string> {
  const wanted = preference(surface);
  const found = new Map<string, string>();
  const rank = new Map<string, number>();
  if (subjectIds?.length === 0) return found;

  for (const n of db
    .select({ subjectId: s.narratives.subjectId, surface: s.narratives.surface, text: s.narratives.text })
    .from(s.narratives)
    .where(and(
      eq(s.narratives.slot, slot),
      eq(s.narratives.ordinal, 0),
      inArray(s.narratives.surface, [...wanted]),
      ...(subjectIds ? [inArray(s.narratives.subjectId, [...subjectIds])] : []),
    ))
    .all()) {
    const preferred = wanted.indexOf(n.surface);
    const standing = rank.get(n.subjectId);
    if (standing != null && standing <= preferred) continue;
    rank.set(n.subjectId, preferred);
    found.set(n.subjectId, n.text);
  }
  return found;
}

/** The same, for one subject. Null when nobody has written this slot. */
export function narrativeFor(db: Db, subjectId: string, slot: Slot, surface: Surface = "desktop"): string | null {
  const wanted = preference(surface);
  const rows = db
    .select({ surface: s.narratives.surface, text: s.narratives.text })
    .from(s.narratives)
    .where(
      and(
        eq(s.narratives.subjectId, subjectId),
        eq(s.narratives.slot, slot),
        eq(s.narratives.ordinal, 0),
        inArray(s.narratives.surface, [...wanted]),
      ),
    )
    .orderBy(asc(s.narratives.ordinal))
    .all();

  for (const surfaceWanted of wanted) {
    const row = rows.find((r) => r.surface === surfaceWanted);
    if (row?.text) return row.text;
  }
  return null;
}

/**
 * A slot that runs to paragraphs, in order, for one subject.
 *
 * The two above answer with one sentence because that is what a list row draws.
 * An account is several paragraphs and is read on a detail pane, and three
 * callers wrote this themselves before it existed here — each of them dropping
 * the surface fallback, so an account written for the phone was visible to the
 * UI and invisible to the agent tools reading the same row.
 */
export function narrativeLines(
  db: Db,
  subjectId: string,
  slot: Slot,
  surface: Surface = "desktop",
): string[] {
  const wanted = preference(surface);
  const rows = db
    .select({ surface: s.narratives.surface, ordinal: s.narratives.ordinal, text: s.narratives.text })
    .from(s.narratives)
    .where(and(
      eq(s.narratives.subjectId, subjectId),
      eq(s.narratives.slot, slot),
      inArray(s.narratives.surface, [...wanted]),
    ))
    .orderBy(asc(s.narratives.ordinal))
    .all();

  // The whole slot in one surface or the other, never a mixture: half an
  // account written for the phone and half for the desktop is not a paragraph
  // sequence anybody wrote.
  for (const surfaceWanted of wanted) {
    const lines = rows.filter((row) => row.surface === surfaceWanted).map((row) => row.text);
    if (lines.length) return lines;
  }
  return [];
}
