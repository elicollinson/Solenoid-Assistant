// The agent's line about a screen.
//
// Every list surface writes its lede the same way: a sentence the agent wrote,
// followed by a count derived at read time. This reads the first half. The
// second half belongs to whichever query is doing the counting, because a tally
// stored is a tally wrong by morning.
//
// Asking for the phone asks for the phone's own words and settles for the
// desktop's when nobody has written them. That fallback is what lets a phone
// screen ship before its copy does: the sentence is the desktop's, which is
// long, rather than absent, which reads as a bug.
import { and, eq, isNull } from "drizzle-orm";
import type { Surface } from "../../shared/surface";
import type { Db } from "../index";
import * as s from "../schema";

type Slot = (typeof s.SURFACE_NOTE_SLOT)[number];

/**
 * The surfaces to try, best first.
 *
 * Only "phone" ever has anywhere to fall back to. Reversing that — a desktop
 * screen quietly drawing the phone's shorter line — would be worse than a blank,
 * because the phone's copy is written to fit a column the desktop does not have.
 */
const preference = (surface: Surface): readonly Surface[] =>
  surface === "desktop" ? ["desktop"] : [surface, "desktop"];

/** A line about the screen itself. Empty when nothing has been written. */
export function surfaceNote(
  db: Db,
  screen: s.Screen,
  slot: Slot = "line",
  surface: Surface = "desktop",
): string {
  for (const wanted of preference(surface)) {
    const [row] = db
      .select({ text: s.surfaceNotes.text })
      .from(s.surfaceNotes)
      .where(
        and(
          eq(s.surfaceNotes.screen, screen),
          eq(s.surfaceNotes.surface, wanted),
          eq(s.surfaceNotes.slot, slot),
          isNull(s.surfaceNotes.onDate),
        ),
      )
      .limit(1)
      .all();
    if (row?.text) return row.text;
  }
  return "";
}

/** A line about one day on that screen. `onDate` is a local 'YYYY-MM-DD'. */
export function surfaceDayNote(
  db: Db,
  screen: s.Screen,
  onDate: string,
  slot: Slot = "line",
  surface: Surface = "desktop",
): string {
  for (const wanted of preference(surface)) {
    const [row] = db
      .select({ text: s.surfaceNotes.text })
      .from(s.surfaceNotes)
      .where(
        and(
          eq(s.surfaceNotes.screen, screen),
          eq(s.surfaceNotes.surface, wanted),
          eq(s.surfaceNotes.slot, slot),
          eq(s.surfaceNotes.onDate, onDate),
        ),
      )
      .limit(1)
      .all();
    if (row?.text) return row.text;
  }
  return "";
}

/**
 * Every day-note for one screen and slot, keyed by its date.
 *
 * The calendar draws seven days at once and would otherwise ask seven times per
 * slot. Same fallback: a day with no phone line keeps the desktop's, so the
 * merge is per-day rather than all-or-nothing.
 */
export function surfaceDayNotes(
  db: Db,
  screen: s.Screen,
  slot: Slot,
  surface: Surface = "desktop",
): Map<string, string> {
  const found = new Map<string, string>();
  // Worst first, so the surface that wins overwrites the one it falls back to.
  for (const wanted of [...preference(surface)].reverse()) {
    for (const note of db
      .select({ onDate: s.surfaceNotes.onDate, text: s.surfaceNotes.text })
      .from(s.surfaceNotes)
      .where(and(eq(s.surfaceNotes.screen, screen), eq(s.surfaceNotes.surface, wanted), eq(s.surfaceNotes.slot, slot)))
      .all()) {
      if (note.onDate) found.set(note.onDate, note.text);
    }
  }
  return found;
}
