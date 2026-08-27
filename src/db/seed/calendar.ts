// The week the design draws, transcribed.
//
// Only two of the four kinds are here. An event and a hold own their content —
// nothing else in the database knows that Fenwick offered two windows, or that
// the Latham review moved off tomorrow because the dentist was against it. A
// run and a reminder own nothing: they are projections of rows that already
// exist, and they are built at query time so that "Call Marta back" cannot say
// one thing on Reminders and another here.
//
// Seven places deliberately differ from the design's own fixtures.
//
//   * The design's week is Mon Aug 24 – Sun Aug 30 with Monday as today. The
//     seed anchors to whatever today is, so day 0 is today. Anything whose
//     prose names a weekday — "Thursday morning or Friday afternoon", the
//     Thursday standup, the Sunday digest — is anchored to that weekday rather
//     than to an offset, and stays true whenever the seed runs. Everything else
//     keeps its offset from today.
//
//   * No runs are seeded. What has run today is read from workflow_runs; what
//     is going to run is expanded from workflow_schedules, which is what the
//     calendar schema asks for — materialising future runs forks the schedule.
//     So the design's `morning-brief` (there is no such workflow here) and its
//     09:00 bill-watch failure give way to the runs this database actually
//     holds, and the four runs the design counts on its day are still four.
//
//   * No reminders are seeded here either. Every reminder with a date inside
//     the window is drawn, which is two on today rather than the design's one:
//     the boiler slot is genuinely due this afternoon and the design's own
//     Reminders screen says so.
//
//   * "Send the review notes round" is drawn on the calendar and nowhere else
//     in the design. It is a reminder, so it is seeded as one — in
//     ./fixtures.ts with the other six — and now appears on both screens. An
//     agent holding something on one surface and not the other is the same
//     contradiction the standing suggestion had.
//
//   * The two commitments the Activity aside's "next up" used to draw — Marta
//     at 11:00, a dentist at 14:30 — are gone. They were the only calendar rows
//     this database had, and they contradict the week the design drew for the
//     same day, which puts the dentist on the following morning and reasons
//     about it. "Next up" is a reading of the calendar, so it reads this one.
//
//   * The day's line is derived. The design stores "Four of my runs and three
//     of your commitments" above a day holding two commitments; every number in
//     that sentence counts the day underneath it. What it held back from doing
//     is not a count, so that half is written and kept.
//
//   * Of the meta pairs, Kind, Where, Set by, Moved and Repeats are read off
//     the row. The rest — who is coming, when it was offered, what it clashes
//     with — are the agent's own and are stored as written.

/** Local wall clock, relative to the seed's anchor day. */
export interface Clock {
  hour: number;
  minute: number;
}

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * Which column something lands in.
 *
 * An offset is "two days after today, whatever today is". A weekday is "the
 * Thursday inside this window", which is what anything the agent describes by
 * name needs — a hold offered for Thursday morning has to be on a Thursday.
 * Both always resolve inside the seven days the grid draws.
 */
export type DayAnchor = { dayOffset: number } | { weekday: Weekday };

/** A pair whose value is a date, formatted against the anchor at seed time so
 *  "offered Aug 22" is still three days ago in a year's time. */
export interface DatedPair {
  label: string;
  dayOffset: number;
}

export interface CalendarFixture {
  key: string;
  kind: "event" | "hold";
  title: string;
  /** The line under the title on the canvas. */
  meta: string;
  location?: string;
  day: DayAnchor;
  start: Clock;
  end: Clock;
  /** Whose commitment it is. A hold is nobody's yet. */
  setBy: "user" | "agent";
  /** Where it used to be, and why I moved it. */
  movedFrom?: DayAnchor;
  movedReason?: string;
  /** "FREQ=WEEKLY;BYDAY=TH" — the standup is otherwise unrepresentable. */
  rrule?: string;
  /** "Why it is here", in the agent's voice. */
  account: readonly string[];
  /** Pairs beyond the derived ones. */
  pairs?: readonly (readonly [string, string])[];
  datedPairs?: readonly DatedPair[];
  affirm?: string;
  quiet?: string;
  /** Holds only. Both windows share a group so that taking one releases the
   *  other, and share the decision the boiler reminder already opened. */
  hold?: {
    groupKey: string;
    offeredBy: string;
    offered: { dayOffset: number; hour: number; minute: number };
    /** Which reminder's open decision settles this. */
    decisionOf: string;
    clashNote: string;
  };
}

export const CALENDAR: readonly CalendarFixture[] = [
  {
    key: "latham-review",
    kind: "event",
    title: "Latham quarter review",
    meta: "Room 2 · four people",
    location: "Room 2",
    day: { dayOffset: 0 },
    start: { hour: 10, minute: 0 },
    end: { hour: 11, minute: 30 },
    setBy: "user",
    movedFrom: { dayOffset: 1 },
    movedReason: "Latham asked, and the day it was on had the dentist against it while this one was clear on both sides.",
    account: [
      "Yours, not mine. I moved it when Latham asked, because the day it was on had the dentist against it and this slot was clear on both sides.",
      "I read the deck this morning and put the two figures that changed at the top of your notes.",
    ],
    pairs: [["With", "four people"]],
    affirm: "Show me the notes",
    quiet: "Move it back",
  },
  {
    key: "dana-lunch",
    kind: "event",
    title: "Lunch with Dana Okonjo",
    meta: "Ferrier Row",
    location: "Ferrier Row",
    day: { dayOffset: 0 },
    start: { hour: 12, minute: 45 },
    end: { hour: 13, minute: 30 },
    setBy: "user",
    account: [
      "Dana asked for half an hour about the billing address. I did not accept for you — I put it here as an event because you replied to her yourself on Friday.",
    ],
    pairs: [["With", "Dana Okonjo"]],
  },
  {
    key: "dentist",
    kind: "event",
    title: "Dentist",
    meta: "Calder Yard",
    location: "Calder Yard",
    day: { dayOffset: 1 },
    start: { hour: 8, minute: 30 },
    end: { hour: 9, minute: 15 },
    setBy: "user",
    account: [
      "Booked in March and confirmed by them last week. I checked it against the review before I agreed to move the review off this day.",
    ],
    datedPairs: [{ label: "Confirmed", dayOffset: -6 }],
  },
  {
    key: "priya-call",
    kind: "event",
    title: "Call with Priya",
    meta: "figures, rev 3",
    day: { dayOffset: 1 },
    start: { hour: 15, minute: 0 },
    end: { hour: 15, minute: 30 },
    setBy: "agent",
    account: [
      "Priya asked for half an hour on the revised figures. She offered three slots and I took the one that left your morning whole.",
    ],
    pairs: [
      ["With", "Priya Nandakumar"],
      ["Offered", "3 slots"],
    ],
    affirm: "Send her the figures first",
    quiet: "Move it later",
  },
  {
    key: "site-walk",
    kind: "event",
    title: "Site walk with Marta",
    meta: "Ferrier Row",
    location: "Ferrier Row",
    day: { dayOffset: 2 },
    start: { hour: 13, minute: 0 },
    end: { hour: 15, minute: 0 },
    setBy: "agent",
    account: [
      "Two hours because the last walk took ninety minutes and you were late back. Marta prefers afternoons and this is the only afternoon she is in the borough.",
    ],
    pairs: [["With", "Marta Reyes"]],
  },
  {
    key: "boiler-first",
    kind: "hold",
    title: "Boiler service — first slot",
    meta: "Fenwick · unconfirmed",
    day: { weekday: "thu" },
    start: { hour: 8, minute: 0 },
    end: { hour: 11, minute: 0 },
    setBy: "agent",
    account: [
      "Fenwick offered two windows and I am holding both until you pick one. This is the first: three hours on Thursday morning, which runs into the standup at half nine.",
      "I have not accepted either. The last two trades visits you moved to the later slot, but twice is not a rule I will act on.",
    ],
    pairs: [
      ["Who", "Fenwick Heating"],
      ["Clashes", "standup"],
    ],
    datedPairs: [{ label: "Offered", dayOffset: -3 }],
    affirm: "Take this one",
    quiet: "Take Friday instead",
    hold: {
      groupKey: "boiler",
      offeredBy: "Fenwick Heating",
      offered: { dayOffset: -3, hour: 11, minute: 2 },
      decisionOf: "boiler-slot",
      clashNote: "runs into the standup",
    },
  },
  {
    key: "standup",
    kind: "event",
    title: "Standup",
    meta: "weekly",
    day: { weekday: "thu" },
    start: { hour: 9, minute: 30 },
    end: { hour: 10, minute: 0 },
    setBy: "user",
    rrule: "FREQ=WEEKLY;BYDAY=TH;BYHOUR=9;BYMINUTE=30",
    account: [
      "Standing weekly. It sits inside the first boiler window, which is the one thing making Thursday worse than Friday.",
    ],
    pairs: [["With", "the team"]],
  },
  {
    key: "quarter-close-prep",
    kind: "event",
    title: "Quarter close prep",
    meta: "with Priya",
    day: { weekday: "fri" },
    start: { hour: 11, minute: 0 },
    end: { hour: 12, minute: 30 },
    setBy: "user",
    account: [
      "Priya asked for this once the reconciliation is closed. If the Ferris credit note is still open on Friday morning there will be nothing to prepare, and I will say so rather than let you sit down to it.",
    ],
    pairs: [
      ["With", "Priya Nandakumar"],
      ["Depends on", "run 14"],
    ],
  },
  {
    key: "boiler-second",
    kind: "hold",
    title: "Boiler service — second slot",
    meta: "Fenwick · unconfirmed",
    day: { weekday: "fri" },
    start: { hour: 13, minute: 0 },
    end: { hour: 16, minute: 0 },
    setBy: "agent",
    account: [
      "The second of the two windows Fenwick offered. Nothing else is on Friday afternoon and it clashes with nothing.",
      "Picking either one drops the other from the week without me asking again.",
    ],
    pairs: [
      ["Who", "Fenwick Heating"],
      ["Clashes", "nothing"],
    ],
    datedPairs: [{ label: "Offered", dayOffset: -3 }],
    affirm: "Take this one",
    quiet: "Take Thursday instead",
    hold: {
      groupKey: "boiler",
      offeredBy: "Fenwick Heating",
      offered: { dayOffset: -3, hour: 11, minute: 2 },
      decisionOf: "boiler-slot",
      clashNote: "nothing",
    },
  },
  {
    key: "leaving-do",
    kind: "event",
    title: "Marta's leaving do",
    meta: "The Calder Arms",
    location: "The Calder Arms",
    day: { weekday: "sat" },
    start: { hour: 19, minute: 30 },
    end: { hour: 22, minute: 0 },
    setBy: "user",
    account: [
      "You accepted this yourself in July. I have left the whole evening alone and scheduled nothing that could interrupt it.",
    ],
    datedPairs: [{ label: "Accepted", dayOffset: -25 }],
  },
];

/**
 * What I held back from doing today.
 *
 * The other half of the day's line — how many runs, how many commitments — is
 * counted off the day itself. This half is not a count and could not be
 * derived from anything: it is the one thing on the screen only I can say.
 */
export const CALENDAR_RESTRAINT =
  "I moved the Latham review onto today and told you at the time. I have not touched anything after six this evening.";
