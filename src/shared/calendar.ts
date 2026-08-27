// The wire shape of GET /api/calendar and GET /api/calendar/:id.
//
// Pure types and nothing else, for the same reason src/shared/home.ts is: the
// browser half compiles against this file and has no Bun types.
import type { HomeAction, HomeState } from "./home";

/** What a thing on the canvas is: a commitment of yours, one of my runs, a
 *  point in time, or a slot I am only offering. */
export type CalendarKind = "event" | "run" | "reminder" | "hold";

/**
 * The four marks a calendar entry can carry.
 *
 * "idle" is not one of them: something merely scheduled is not quietly waiting,
 * it has simply not happened, and it draws no mark at all. That is what `null`
 * means here — every event, every hold and every future run is unmarked.
 */
export type CalendarMark = Exclude<HomeState, "idle">;

export interface CalendarPair {
  label: string;
  value: string;
}

export interface CalendarDay {
  /** "d0" … "d6". Positional, because the grid draws columns, not dates. */
  key: string;
  /** "Mon" */
  label: string;
  /** "24" */
  date: string;
  today: boolean;
  /** The day-mode tallies: your events, my runs, reminders, held slots. */
  counts: CalendarPair[];
  /**
   * What I would say about this day, above its own list.
   *
   * The phone shows one day at a time and needs one of these per day; the
   * desktop draws the whole week and says one thing about it, which is
   * `CalendarPayload.lede` — the same sentence as `days[0].lede`.
   *
   * Two halves, like every lede here: a sentence I wrote about the day, where
   * one is written for this surface, then a count of what is on it. The count
   * is always there, so this is never empty.
   */
  lede: string;
  /** What I held back from doing on this day. Written, not counted — and only
   *  for the days I wrote one about. */
  restraint: string | null;
}

export interface CalendarItem {
  id: string;
  /** Which column, keyed to CalendarDay.key. */
  day: string;
  /** "06:12" — local to the day, which is what the grid positions on. */
  start: string;
  end: string;
  kind: CalendarKind;
  state: CalendarMark | null;
  title: string;
  /** "Room 2 · four people", "run 14 · step 6/11". */
  meta: string | null;
}

export interface CalendarPayload {
  /** "Aug 25 – 31, 2026" */
  range: string;
  /** What I would say about today, above the week. */
  lede: string;
  /**
   * What I held back from doing across the whole week, as opposed to the
   * per-day `CalendarDay.restraint`. The phone keeps one of these under the
   * agenda whichever day is showing. Null when none is written.
   */
  restraint: string | null;
  /** Minutes past midnight, for the now-line. */
  now: number;
  /** The hours the grid draws between. Everything outside them is dropped
   *  rather than positioned off the canvas. */
  startHour: number;
  endHour: number;
  days: CalendarDay[];
  items: CalendarItem[];
}

export interface CalendarDetailPayload extends CalendarItem {
  /** "Today, 10:00 – 11:30" — the whole span, said the way you would say it. */
  when: string;
  /** "Why it is here", in the agent's voice. */
  account: string[];
  pairs: CalendarPair[];
  actions: HomeAction[];
  /** The way through to whatever this is a projection of. Its label is the
   *  link text; invoking it navigates. */
  link: HomeAction | null;
}
