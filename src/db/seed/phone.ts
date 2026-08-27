// The copy the design writes twice.
//
// The phone is not the desktop feed at a smaller width, and the sentences are
// where that shows first: a workflow row that reads as three columns on a
// 1240px table has to read as one sentence at 390px, and the desktop's own
// sentence wraps to four lines if you simply reuse it. So the design writes a
// second set, and `narratives.surface` / `surface_notes.surface` are where the
// second set lives.
//
// Everything here is transcribed from the design project's phone screens —
// WORKFLOWS_PHONE, CALENDAR_PHONE and KNOWLEDGE_PHONE in `ui_kits/agent/data.js`.
// Nothing is invented and nothing is borrowed from the desktop copy.
//
// Two things the design keys by hand are keyed differently here:
//
//   * Workflow copy is keyed by slug rather than by the design's fixture id,
//     because a slug is what this database calls a workflow.
//
//   * The calendar's per-day lines follow the same rule the calendar fixtures
//     already follow: a line about the runs behind your morning is about
//     *today*, whatever today is, and a line naming Thursday is about the
//     Thursday in the window — because the boiler window it describes is
//     anchored to a Thursday too. See ./calendar.ts for why that division
//     exists at all.
import type { Weekday } from "./calendar";

/** What the phone's home screen says above the feed. The clause counting what
 *  still needs you is added at read time, as it is on the desktop. */
export const PHONE_OVERNIGHT_LEDE = "Nine things done overnight.";

/* ── Workflows ─────────────────────────────────────────────────────────── */

/**
 * The opening only.
 *
 * The design writes this as "Everything I run for you. One is going now, one
 * stopped last night, and one is waiting on your call." — and the second half
 * of that is a count of the table underneath it, which the loader already
 * derives and which a stored copy would get wrong the moment a run started.
 * Same division the desktop's line follows, and the same one Things I know
 * follows below.
 */
export const PHONE_WORKFLOWS_LINE = "Everything I run for you.";

export const PHONE_WORKFLOWS_RESTRAINT =
  "I did not restart the digest after it stopped, and I have not resumed the sweep you paused on Aug 9.";

/** One line per workflow, where the desktop table draws cadence, last run and
 *  step as columns. Keyed by slug. */
export const PHONE_WORKFLOW_LEDE: Readonly<Record<string, string>> = {
  "vendor-reconciliation": "Six of eleven steps done. I'm holding the write-up until the whole pass is through.",
  "weekly-digest": "The archive timed out twice, so I stopped instead of sending you half of it.",
  "inbox-triage": "I sorted the morning and left two money drafts with you.",
  "contract-review": "Sent the reply you approved, then closed the run.",
  "calendar-tidy": "Moved two overlaps overnight and left every external invite alone.",
  "memory-compaction": "Merged fourteen duplicates at three this morning. Your own entries untouched.",
  "bill-watch": "Checked the four accounts twelve minutes ago. Nothing to say.",
  "job-listings-sweep": "Hasn't run since you paused it. I didn't decide for how long.",
};

/** The account inside the sheet a row opens. The desktop's `summary` says the
 *  same thing at three times the length. */
export const PHONE_WORKFLOW_SHEET: Readonly<Record<string, string>> = {
  "vendor-reconciliation":
    "I'm partway through the quarter. Nine of the eleven unmatched invoices look like timing across the boundary; two look real. You'll get one write-up, not eleven pings.",
  "weekly-digest":
    "Step four failed twice against the archive. Nothing was sent and nothing else was touched. Retrying that one step should be enough.",
  "inbox-triage":
    "This morning's pass finished. Four drafts, two already out; the two that commit money are sitting with you.",
  "contract-review":
    "Done. I agreed to the March 1 start, pushed back on the handling fee, and sent it once you approved at 09:02.",
  "calendar-tidy": "Last night's pass moved two overlapping meetings and dropped a hold nobody accepted.",
  "memory-compaction": "Monday's pass merged fourteen duplicate facts and retired six nothing has read since May.",
  "bill-watch": "I check hourly and only speak up when an amount differs from the last cycle. It hasn't.",
  "job-listings-sweep": "Paused on Aug 9 by you. Resuming puts it back on the next Friday at nine.",
};

/* ── Calendar ──────────────────────────────────────────────────────────── */

/**
 * A line per day, because the phone shows one day at a time.
 *
 * Two things happen to the design's copy on the way in.
 *
 * The counts come out. The design writes "Two of my runs sit behind your
 * morning" and "One run, late on" above days it drew by hand; every number in
 * those is a count of the day underneath, and the loader counts it at read
 * time. So the half that is a tally is dropped and the half that is written is
 * kept — the same division the desktop's own day line went through, and the
 * reason two of the seven days have nothing left to store.
 *
 * And the anchor follows the day's contents. The site walk is two days out
 * whatever today is, so its line is; the boiler window is on a Thursday, so its
 * line is too. Where the two collide — offset 2 is a Thursday if the seed runs
 * on a Tuesday — the offset wins, because the days after today are read in
 * today's terms.
 */
export const PHONE_CALENDAR_DAYS: readonly { day: { dayOffset: number } | { weekday: Weekday }; text: string }[] = [
  {
    day: { dayOffset: 2 },
    text: "The site walk takes the afternoon, so I put the notes reminder after it rather than before.",
  },
  {
    day: { weekday: "thu" },
    text: "The first boiler window runs across the standup. That is the whole of what is wrong with Thursday.",
  },
  {
    day: { weekday: "fri" },
    text: "The second window clashes with nothing. Of the two, this is the one I would take.",
  },
  { day: { weekday: "sat" }, text: "I scheduled around the leaving do rather than through it." },
  { day: { weekday: "sun" }, text: "The digest gathers the week and sends it at nine." },
];

/** What I held back from across the whole week. The phone keeps this under the
 *  agenda whichever day is showing, so it is standing rather than dated. */
export const PHONE_CALENDAR_RESTRAINT =
  "I am holding both boiler windows and have accepted neither. Taking one drops the other without me asking again.";

/* ── Things I know ─────────────────────────────────────────────────────── */

/**
 * The opening of the phone's lede.
 *
 * Only the opening: the desktop counts the store and the facts in it in one
 * sentence, which does not fit above a 390px list, but what follows — how many
 * memories hold two answers, how many are past the date I said I'd check them —
 * stays counted on both. An authored sentence claiming one unsettled memory
 * would be wrong the moment a second turned up.
 */
export const PHONE_KNOWLEDGE_LINE = "Everything I've written down.";

export const PHONE_KNOWLEDGE_RESTRAINT =
  "I have not merged the two Ferris addresses. Until you tell me which stands, I write to neither.";
