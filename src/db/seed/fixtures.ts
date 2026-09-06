// The design's own content, transcribed.
//
// Everything here comes out of the Claude Design project (ui_kits/agent/data.js
// and the four activity entries ActivityView.jsx draws inline). It is the
// agent's authored prose, so it is copied rather than paraphrased.
//
// Two places deliberately differ from the fixtures, because the fixture was a
// display string where the product derives the value:
//   * the rail's counts and the header's "two need a word from you" are
//     counted from the rows below rather than stored;
//   * the aside's "next up" is a reading of the calendar rather than a list of
//     its own. The design gives the aside two commitments this day never has
//     again on the calendar screen, and a third line ("18:00 Digest sends") no
//     workflow in the design runs. All three are now whatever is genuinely
//     coming — see ./calendar.ts, which owns the week they are read from.
//
// The runs behind these entries — every execution, trace, log and transcript —
// live in ./runs.ts, and everything behind a reminder — the account, the
// artifacts, the trail — lives in ./reminders.ts. Both note their own
// divergences.

import type { State } from "../schema/_shared";

export interface WorkflowFixture {
  slug: string;
  name: string;
  trigger: "schedule" | "on_demand";
  /** The agent's own words for the cadence, shown on the workflow list. */
  cadence: string;
  rrule?: string;
  /** Local hour/minute the schedule next fires, for seeding nextRunAt. */
  nextRun?: { dayOffset: number; hour: number; minute: number };
  pausedDayOffset?: number;
  instruction?: string;
}

export const WORKFLOWS: readonly WorkflowFixture[] = [
  {
    slug: "vendor-reconciliation",
    name: "Q3 vendor reconciliation",
    trigger: "on_demand",
    cadence: "On demand",
    instruction:
      "Don't touch anything Ferris until the credit note is decided. Group quarter-boundary differences rather than asking per invoice.",
  },
  {
    slug: "weekly-digest",
    name: "Weekly digest",
    trigger: "schedule",
    cadence: "Sundays, 21:00",
    rrule: "FREQ=WEEKLY;BYDAY=SU;BYHOUR=21;BYMINUTE=0",
    nextRun: { dayOffset: 7, hour: 21, minute: 0 },
    instruction: "Never send a partial digest. If a source fails twice, stop and tell me.",
  },
  {
    slug: "inbox-triage",
    name: "Inbox triage",
    trigger: "schedule",
    cadence: "Weekdays, 06:00",
    rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6;BYMINUTE=0",
    nextRun: { dayOffset: 1, hour: 6, minute: 0 },
    instruction:
      "Anything that commits money waits for me. File contact details and dates into memory without asking.",
  },
  {
    slug: "contract-review",
    name: "Ferris contract review",
    trigger: "on_demand",
    cadence: "On demand",
    instruction: "Agree to dates freely; push back on any new fee.",
  },
  {
    slug: "calendar-tidy",
    name: "Calendar tidy",
    trigger: "schedule",
    cadence: "Daily, 22:00",
    rrule: "FREQ=DAILY;BYHOUR=22;BYMINUTE=0",
    nextRun: { dayOffset: 0, hour: 22, minute: 0 },
  },
  {
    slug: "memory-compaction",
    name: "Memory compaction",
    trigger: "schedule",
    cadence: "Mondays, 03:00",
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=3;BYMINUTE=0",
    nextRun: { dayOffset: 7, hour: 3, minute: 0 },
  },
  {
    slug: "bill-watch",
    name: "Bill watch",
    trigger: "schedule",
    cadence: "Hourly",
    rrule: "FREQ=HOURLY",
    nextRun: { dayOffset: 0, hour: 23, minute: 0 },
  },
  {
    slug: "job-listings-sweep",
    name: "Job listings sweep",
    trigger: "schedule",
    cadence: "Fridays, 09:00",
    rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0",
    pausedDayOffset: -16,
  },
];

export interface ActionFixture {
  label: string;
  stance: "affirm" | "neutral" | "quiet" | "danger" | "bare";
  effectKind: "navigate" | "resolve" | "custom" | "tool_call" | "run_workflow";
  effect: Record<string, unknown>;
}

export interface ActivityFixture {
  key: string;
  state: State;
  title: string;
  /** The agent's account of what it did, shown as the card's body. */
  account: string;
  /** Local wall clock, relative to the seed's anchor day. */
  at: { dayOffset: number; hour: number; minute: number };
  workflowSlug: string;
  /** Which run of that workflow this entry is about. The run carries the tool
   *  calls, the trace and the log; the entry carries only the narration. */
  runOrdinal: number;
  framed: boolean;
  prominent: boolean;
  badge?: string;
  toolSummary?: string;
  progress?: { value: number; total: number };
  actions?: readonly ActionFixture[];
  /** Set when this entry is the thing a decision is about. */
  decision?: { title: string; body: string; blocking: boolean };
}

export const ACTIVITY: readonly ActivityFixture[] = [
  {
    key: "ferris-contract-reply",
    state: "attention",
    title: "Reply to the Ferris contract amendment",
    account:
      "I drafted a reply agreeing to the March 1 start but pushing back on the handling fee, since you had that waived yourself last year. I'd rather you read it before it goes out.",
    at: { dayOffset: 0, hour: 7, minute: 41 },
    workflowSlug: "contract-review",
    runOrdinal: 3,
    framed: true,
    prominent: true,
    toolSummary: "4 tool calls · gmail.draft, memory.read ×2, calendar.check",
    decision: {
      title: "Approve the Ferris contract reply",
      body: "The draft agrees to the March 1 start and pushes back on the handling fee. Nothing goes out until you say so.",
      blocking: true,
    },
    actions: [
      { label: "Send it", stance: "affirm", effectKind: "tool_call", effect: { tool: "gmail.send", args: { draft: "thread/1f8ac2" } } },
      { label: "Read the draft", stance: "neutral", effectKind: "navigate", effect: { view: "Workflows", id: "contract-review", tab: "Executions" } },
      { label: "Not this one", stance: "bare", effectKind: "resolve", effect: {} },
    ],
  },
  {
    key: "vendor-reconciliation-run",
    state: "running",
    title: "Q3 vendor reconciliation",
    account:
      "Matching invoices against the ledger. Eleven of forty-three don't line up yet; I'll write it all up when I'm through.",
    at: { dayOffset: 0, hour: 6, minute: 12 },
    workflowSlug: "vendor-reconciliation",
    runOrdinal: 14,
    framed: true,
    prominent: true,
    badge: "running · step 6/11",
    progress: { value: 6, total: 11 },
    actions: [
      { label: "Open workflow", stance: "neutral", effectKind: "navigate", effect: { view: "Workflows", id: "vendor-reconciliation" } },
      { label: "Pause", stance: "neutral", effectKind: "custom", effect: { op: "pause_run" } },
      { label: "Trace", stance: "neutral", effectKind: "navigate", effect: { view: "Workflows", id: "vendor-reconciliation", tab: "Trace" } },
    ],
  },
  {
    key: "filed-into-memory",
    state: "done",
    title: "Filed six things into memory",
    account:
      "Mostly from yesterday's threads: Priya's new number, the boiler service window, and that Marta prefers afternoon calls. Two went in as reminders instead.",
    at: { dayOffset: 0, hour: 6, minute: 4 },
    workflowSlug: "inbox-triage",
    runOrdinal: 212,
    framed: false,
    prominent: false,
    toolSummary: "6 facts · 2 reminders · 1 recommendation",
  },
  {
    key: "memory-compaction-run",
    state: "done",
    title: "Merged fourteen duplicate facts",
    account:
      "I merged fourteen duplicates and retired six that nothing has referenced since May. Anything you wrote by hand was left alone.",
    at: { dayOffset: 0, hour: 3, minute: 6 },
    workflowSlug: "memory-compaction",
    runOrdinal: 22,
    framed: false,
    prominent: false,
    toolSummary: "14 merged · 6 retired",
  },
  {
    key: "calendar-tidy-run",
    state: "done",
    title: "Tidied two overlapping meetings",
    account:
      "I moved two overlapping meetings and dropped a hold that nobody accepted. Nothing that had guests outside the company was touched.",
    at: { dayOffset: -1, hour: 22, minute: 4 },
    workflowSlug: "calendar-tidy",
    runOrdinal: 96,
    framed: false,
    prominent: false,
  },
  {
    key: "weekly-digest-halted",
    state: "failed",
    title: "Weekly digest stopped halfway",
    account:
      "The reading step timed out twice, so I left the run open rather than sending you half a digest. Nothing else was affected.",
    at: { dayOffset: -1, hour: 21, minute: 4 },
    workflowSlug: "weekly-digest",
    runOrdinal: 31,
    framed: false,
    prominent: false,
    actions: [
      { label: "Retry that step", stance: "danger", effectKind: "run_workflow", effect: { workflow: "weekly-digest", fromStep: 4 } },
      { label: "Read the log", stance: "neutral", effectKind: "navigate", effect: { view: "Workflows", id: "weekly-digest", tab: "Logs" } },
    ],
  },
];

export interface ReminderFixture {
  key: string;
  state: "attention" | "idle" | "done";
  title: string;
  /** The one line the list row shows. The detail's account is in ./reminders.ts. */
  note: string;
  originLabel: string;
  /** When the agent set it. The design prints this; it is not "now". */
  setAt: { dayOffset: number; hour: number; minute: number };
  /** null means Someday — the reminder has no date attached. */
  due: { dayOffset: number; hour: number; minute: number } | null;
  completed?: { dayOffset: number; hour: number; minute: number };
  decision?: { title: string; body: string };
}

export const REMINDERS: readonly ReminderFixture[] = [
  {
    key: "ferris-credit-note",
    state: "attention",
    title: "Tell Ferris whether the credit note stands",
    note: "Two invoices are held against this and the reconciliation can't close without it. I didn't chase them for you.",
    originLabel: "from okf:vendor/ferris-terms",
    setAt: { dayOffset: -10, hour: 9, minute: 20 },
    due: { dayOffset: -1, hour: 17, minute: 0 },
  },
  {
    key: "boiler-slot",
    state: "attention",
    title: "Pick a slot for the boiler service",
    note: "They offered Thursday morning or Friday afternoon. Both are clear in your calendar, so I left the choice to you.",
    originLabel: "from thread/9a44 · Aug 22",
    setAt: { dayOffset: -3, hour: 11, minute: 4 },
    due: { dayOffset: 0, hour: 16, minute: 30 },
    decision: {
      title: "Pick a slot for the boiler service",
      body: "Fenwick offered Thursday 8–11am or Friday 1–4pm. Both are clear, and neither was marked as preferred, so there was nothing for me to choose on.",
    },
  },
  {
    key: "call-marta",
    state: "idle",
    title: "Call Marta back",
    note: "She prefers afternoon calls, so I set this for the end of the day rather than the morning.",
    originLabel: "from okf:contact/marta",
    setAt: { dayOffset: -3, hour: 14, minute: 10 },
    due: { dayOffset: 0, hour: 19, minute: 0 },
  },
  {
    key: "parking-permit",
    state: "idle",
    title: "Renew the parking permit",
    note: "It lapses on the 3rd. I can do it myself if you'd rather — it only needs the plate you already gave me.",
    originLabel: "from okf:doc/permit-2026",
    setAt: { dayOffset: -5, hour: 7, minute: 0 },
    due: { dayOffset: 4, hour: 9, minute: 0 },
  },
  {
    key: "priya-figures",
    state: "done",
    title: "Send Priya the revised figures",
    note: "You sent them at 08:40, so I closed this out rather than reminding you again.",
    originLabel: "from thread/8c01",
    setAt: { dayOffset: -8, hour: 16, minute: 30 },
    due: { dayOffset: -3, hour: 8, minute: 0 },
    completed: { dayOffset: -3, hour: 8, minute: 40 },
  },
  {
    key: "ferris-follow-up",
    state: "idle",
    title: "Follow up on the contract if Ferris hasn't replied",
    note: "I set this alongside the draft. If they answer first I'll drop it without asking.",
    originLabel: "set by me",
    setAt: { dayOffset: 0, hour: 7, minute: 41 },
    due: null,
  },
  {
    key: "review-notes",
    state: "idle",
    title: "Send the review notes round",
    note: "A day and a half after the quarter review, which is how long you've taken the last four times. I didn't draft them for you.",
    originLabel: "from Latham quarter review",
    setAt: { dayOffset: 0, hour: 6, minute: 44 },
    due: { dayOffset: 2, hour: 17, minute: 30 },
  },
  {
    key: "job-sweep-note",
    state: "idle",
    title: "Look again at the job listings sweep",
    note: "You paused it on Aug 9 and didn't say for how long, so I kept a note instead of restarting it.",
    originLabel: "from Workflows · paused",
    setAt: { dayOffset: -16, hour: 18, minute: 20 },
    due: null,
  },
];

/** The line above the Recommendations list. The rows under it are the agent's
 *  to write; this sentence is the screen's, so it is seeded and they are not. */
export const RECOMMENDATIONS_LEDE = "Changes I'd make to how I work, drawn from what I've watched.";

/** The agent's own count of the night, kept as authored copy: it counts facts,
 *  reminders and replies, not feed rows, so it is not derivable from the feed. */
export const OVERNIGHT_LEDE = "I handled nine things overnight.";
