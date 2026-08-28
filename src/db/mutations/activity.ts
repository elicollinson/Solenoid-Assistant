// The one thing an agent may write about a feed entry: a note on the trail.
//
// ../../tools/activity.ts refuses to mint feed entries, and the reason holds:
// an activity item is DERIVED, so a tool that posted one would write the record
// of an event that never happened, in front of somebody who reads that feed to
// find out what was done in their name.
//
// Annotating is the other thing. `subject_events` is the `history: [{t, text}]`
// trail that hangs under any entity — see ../schema/spine.ts, where `eventKind`
// defaults to "note" for exactly this. A note does not claim an event occurred;
// it is a remark ABOUT an event that already did, timestamped, attributed, and
// appended after the entry rather than woven into it. The distinction is the
// whole of why this file exists and is one function long:
//
//   posting     invents the record            → refused, and there is no tool
//   annotating  adds to a record that stands  → this
//
// Append-only on purpose. There is no edit and no delete: a trail somebody can
// quietly revise is not a trail, and the value of a note written at the time is
// that it was written at the time.
import { eq } from "drizzle-orm";
import { ulid, type Db } from "../index";
import * as s from "../schema";

/** Thrown when the id names no feed entry — HTTP 404. */
export class NoSuchActivityItemError extends Error {
  constructor(id: string) {
    super(`No activity item with id ${id}`);
    this.name = "NoSuchActivityItemError";
  }
}

export interface ActivityNote {
  /** Who is speaking. An agent writing its own note is "agent"; a note being
   *  recorded on somebody's behalf is theirs, and saying otherwise would put
   *  words in their mouth on a record they are meant to trust. */
  by?: (typeof s.ACTOR)[number];
  /** The run this note came out of, when it came out of one. */
  runId?: string;
  /** When it was made. Defaults to now; pass one only when writing down a note
   *  made earlier, never to place a note where it reads better. */
  at?: Date;
}

/**
 * Append a note to a feed entry's trail. Answers with the note's id.
 *
 * The entry must already exist — that check is the point rather than a
 * formality, since the failure it prevents is a note about nothing becoming the
 * only evidence that a thing happened.
 */
export function annotateActivityItem(
  db: Db,
  activityItemId: string,
  text: string,
  options: ActivityNote = {},
): string {
  const note = text.trim();
  if (!note) throw new Error("An activity note needs something in it");

  return db.transaction((tx) => {
    const exists = tx
      .select({ id: s.activityItems.id })
      .from(s.activityItems)
      .where(eq(s.activityItems.id, activityItemId))
      .get();
    if (!exists) throw new NoSuchActivityItemError(activityItemId);

    const id = ulid();
    tx.insert(s.subjectEvents)
      .values({
        id,
        subjectId: activityItemId,
        at: options.at ?? new Date(),
        actor: options.by ?? "agent",
        eventKind: "note",
        text: note,
        ...(options.runId ? { runId: options.runId } : {}),
      })
      .run();
    return id;
  });
}
