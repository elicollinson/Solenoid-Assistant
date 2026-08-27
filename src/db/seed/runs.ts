// Every run the Workflows surface draws, transcribed from the design.
//
// The design keeps these in four parallel shapes — RUNS, EXECUTIONS, TRACE,
// LOGS, WRITEUP — because nothing there has to agree with anything else. Here
// they are one record per run, because the same rows feed the executions list,
// the trace tree, the log stream and the feed's collapsed tool calls, and a
// second copy would drift.
//
// Three places deliberately differ from the design's own fixtures, and all
// three are places the design contradicts itself between screens:
//
//   * `contract-review` is held on your approval, not finished. The design's
//     data.js says the reply went out at 07:41; its ActivityView says the draft
//     is waiting on you. The feed is the one the product already seeded, so the
//     run stops at the gate and the prose says so.
//   * `inbox-triage` finished. The design has two money drafts still waiting,
//     which would make three things needing a word from you where the home
//     screen says two. The gate is seeded resolved instead — it happened, it is
//     in the trace and the log, and it is closed.
//   * lifetime tallies (`runsTotal`, `cleanRuns`) are stored rather than
//     counted. Everything else on this surface is derived, but 212 runs is
//     history the seed does not hold rows for; counting the four it retains
//     would print "Runs 4" beside a row labelled "Run 212".
import type { STEP_STATE } from "../schema/_shared";

export type StepState = (typeof STEP_STATE)[number];
export type LogLevel = "info" | "ok" | "warn" | "error";

/** A wall clock on the anchor day, or a point measured back from `now`. */
export type RunStart = { dayOffset: number; hour: number; minute: number } | { minutesAgo: number };

export interface TraceFixture {
  /** Literal and machine-side: "reconcile.match_invoices". */
  name: string;
  detail?: string;
  /** Short amber aside — the reason a step is held rather than broken. */
  note?: string;
  durationMs?: number;
  state?: StepState;
  /** Marks a step the write-up counts as a tool call. Parents can be tools. */
  tool?: boolean;
  children?: readonly TraceFixture[];
}

export interface LogFixture {
  /** HH:MM:SS.mmm on the run's own day. */
  t: string;
  level: LogLevel;
  text: string;
}

export interface TurnFixture {
  who: "you" | "agent";
  text: string;
}

export interface RunFixture {
  /** "Run 14" is this number, not a label. */
  ordinal: number;
  state: "running" | "attention" | "done" | "failed";
  trigger: "manual" | "schedule";
  start: RunStart;
  /** Null while the run is still open, or held. */
  durationMs: number | null;
  step: { index: number; total: number };
  /** The `changed` list. Only the run that produced them carries them. */
  effects?: readonly string[];
  /** The agent's write-up, one entry per paragraph. */
  prose?: readonly string[];
  trace?: readonly TraceFixture[];
  logs?: readonly LogFixture[];
  /** What the two of you said to each other during the run. */
  transcript?: readonly TurnFixture[];
}

export interface WorkflowRunsFixture {
  /** The agent's account of where the workflow stands. */
  summary: string;
  runsTotal: number;
  cleanRuns: number;
  /** Newest first, the order the executions list shows them in. */
  runs: readonly RunFixture[];
}

export const WORKFLOW_RUNS: Record<string, WorkflowRunsFixture> = {
  "vendor-reconciliation": {
    summary:
      "I'm matching 43 vendor invoices against the Q3 ledger. Eleven don't line up yet — nine look like timing differences across the quarter boundary, two look like real discrepancies. I'll write the whole thing up when I'm through rather than pinging you per invoice.",
    runsTotal: 14,
    cleanRuns: 11,
    runs: [
      {
        ordinal: 14,
        state: "running",
        trigger: "manual",
        start: { dayOffset: 0, hour: 6, minute: 12 },
        durationMs: null,
        step: { index: 6, total: 11 },
        effects: [
          "Matched 32 of 43 invoices to ledger lines.",
          "Flagged 2 invoices with no matching line at all (2291, 2318).",
          "Left the Ferris credit note alone — I need your call on it.",
        ],
        prose: [
          "I started at 06:12 with the Q3 ledger and the 43 invoices that arrived since the last run.",
          "Thirty-two matched cleanly on amount and date. Nine are timing differences — invoices dated late September that the ledger books in October — and I've grouped those so you can confirm the treatment once rather than nine times.",
          "Two invoices, 2291 and 2318, have no matching ledger line at all. Both are from Ferris, both are small, and both post-date the credit note you're still deciding about. I've left them untouched.",
        ],
        trace: [
          {
            name: "reconcile.load_ledger",
            detail: "q3-2026",
            durationMs: 2100,
            children: [
              { name: "sheets.read", detail: "→ 1,204 rows", durationMs: 1800, tool: true },
              { name: "memory.read", detail: "okf:policy/quarter-boundary", durationMs: 300, tool: true },
            ],
          },
          {
            name: "reconcile.load_invoices",
            detail: "since=2026-08-17 → 43",
            durationMs: 1400,
            children: [{ name: "invoices.list", detail: "43 documents", durationMs: 900, tool: true }],
          },
          {
            name: "reconcile.match_invoices",
            state: "running",
            detail: "32 of 43 matched",
            durationMs: 12400,
            tool: true,
            children: [
              { name: "match.exact", detail: "28 matched on amount + date", durationMs: 3200 },
              { name: "match.fuzzy", detail: "4 matched within 2 days", durationMs: 6900 },
              {
                name: "match.unresolved",
                state: "waiting",
                detail: "11 remaining",
                durationMs: 100,
                children: [
                  { name: "group.timing_difference", detail: "9 grouped for one decision", durationMs: 400 },
                  { name: "invoice/2291", state: "waiting", detail: "no ledger line", note: "Ferris — held per instruction" },
                  { name: "invoice/2318", state: "waiting", detail: "no ledger line", note: "Ferris — held per instruction" },
                ],
              },
            ],
          },
          { name: "reconcile.write_summary", state: "skipped", detail: "waits for matching to finish" },
          { name: "notify.digest", state: "skipped", detail: "waits for summary" },
        ],
        logs: [
          { t: "06:12:04.221", level: "info", text: "run started · workflow=vendor-reconciliation · trigger=manual" },
          { t: "06:12:04.998", level: "info", text: "loaded policy okf:policy/quarter-boundary (rev 4)" },
          { t: "06:12:07.114", level: "ok", text: "ledger q3-2026 read · 1,204 rows" },
          { t: "06:12:08.502", level: "info", text: "43 invoices queued for matching" },
          { t: "06:12:11.740", level: "ok", text: "match.exact · 28 matched" },
          { t: "06:12:18.663", level: "ok", text: "match.fuzzy · 4 matched within 2 days" },
          { t: "06:14:51.007", level: "warn", text: "invoice 2291 has no matching ledger line" },
          { t: "06:14:51.009", level: "warn", text: "invoice 2318 has no matching ledger line" },
          { t: "06:14:51.220", level: "info", text: "hold applied · reason=user instruction (Ferris)" },
          { t: "06:15:02.881", level: "warn", text: "9 invoices grouped as quarter-boundary timing differences" },
          { t: "06:15:03.004", level: "info", text: "awaiting completion of match pass before summary" },
          { t: "06:21:44.512", level: "error", text: "sheets.read retry 1/3 · upstream 503 · recovered" },
        ],
        transcript: [
          { who: "you", text: "Run the Q3 reconciliation, but don't touch anything Ferris until I've decided on the credit note." },
          { who: "agent", text: "Understood. I'll reconcile everything else and set the Ferris items aside with a note saying why." },
          { who: "you", text: "How bad is it so far?" },
          {
            who: "agent",
            text: "Not bad. Thirty-two of forty-three matched cleanly. Nine are quarter-boundary timing differences, which I'll group for one decision. Two are genuinely unmatched, both Ferris, both untouched as you asked.",
          },
        ],
      },
      { ordinal: 13, state: "done", trigger: "manual", start: { dayOffset: -8, hour: 6, minute: 12 }, durationMs: 1_120_000, step: { index: 11, total: 11 } },
      { ordinal: 12, state: "attention", trigger: "manual", start: { dayOffset: -15, hour: 6, minute: 12 }, durationMs: 1_323_000, step: { index: 9, total: 11 } },
      { ordinal: 11, state: "failed", trigger: "manual", start: { dayOffset: -22, hour: 6, minute: 12 }, durationMs: 291_000, step: { index: 3, total: 11 } },
    ],
  },

  "weekly-digest": {
    summary:
      "The reading step timed out twice against the archive, so I stopped rather than sending you half a digest. Nothing was sent and nothing else was affected. Retrying step 4 on its own should be enough.",
    runsTotal: 31,
    cleanRuns: 29,
    runs: [
      {
        ordinal: 31,
        state: "failed",
        trigger: "schedule",
        start: { dayOffset: -1, hour: 21, minute: 0 },
        durationMs: 291_000,
        step: { index: 4, total: 9 },
        effects: ["Read 61 of 140 items.", "Nothing sent.", "Run left open for a retry."],
        prose: [
          "I started the digest at 21:00 and got through 61 of the 140 items before the archive stopped answering.",
          "I retried twice, waited, and retried once more. Rather than send you a digest that quietly omitted half the week, I stopped and left the run open.",
          "Nothing was sent, and nothing else in the schedule was affected. Retrying step 4 on its own should be enough once the archive is back.",
        ],
        trace: [
          {
            name: "digest.collect_sources",
            detail: "→ 140 items",
            durationMs: 600,
            children: [{ name: "sources.list", detail: "6 sources", durationMs: 600, tool: true }],
          },
          {
            name: "digest.read_items",
            state: "failed",
            detail: "61 of 140 read",
            durationMs: 164_200,
            children: [
              { name: "archive.read", detail: "items 1..61", durationMs: 44_200, tool: true },
              { name: "archive.read", state: "failed", detail: "timeout after 120s", note: "retried twice", durationMs: 120_000, tool: true },
            ],
          },
          { name: "digest.write", state: "skipped", detail: "needs a complete read" },
          { name: "notify.send", state: "skipped", detail: "nothing sent" },
        ],
        logs: [
          { t: "21:00:01.004", level: "info", text: "run started · workflow=weekly-digest · trigger=schedule" },
          { t: "21:00:01.640", level: "ok", text: "6 sources listed · 140 items queued" },
          { t: "21:00:45.882", level: "ok", text: "archive.read · items 1..61" },
          { t: "21:02:45.911", level: "error", text: "archive.read timeout after 120s · items 62..140" },
          { t: "21:04:46.130", level: "error", text: "archive.read retry 2/2 failed · giving up" },
          { t: "21:04:46.220", level: "warn", text: "run halted at step 4 · nothing sent" },
        ],
        transcript: [
          { who: "agent", text: "The weekly digest stopped at step 4 — the archive timed out twice while reading. I didn't send anything." },
          { who: "you", text: "Can you send what you have?" },
          {
            who: "agent",
            text: "I'd rather not. A digest missing half the week reads as though the week was quiet. I'll retry the read and send the whole thing.",
          },
        ],
      },
      { ordinal: 30, state: "done", trigger: "schedule", start: { dayOffset: -8, hour: 21, minute: 0 }, durationMs: 372_000, step: { index: 9, total: 9 } },
      { ordinal: 29, state: "done", trigger: "schedule", start: { dayOffset: -15, hour: 21, minute: 0 }, durationMs: 348_000, step: { index: 9, total: 9 } },
    ],
  },

  "inbox-triage": {
    summary:
      "I sorted 38 threads, drafted four replies, and filed six things into memory. Two of the drafts touched money, so they waited on you rather than going out; you cleared both at 06:38.",
    runsTotal: 212,
    cleanRuns: 208,
    runs: [
      {
        ordinal: 212,
        state: "done",
        trigger: "schedule",
        start: { dayOffset: 0, hour: 6, minute: 0 },
        durationMs: 2_472_000,
        step: { index: 9, total: 9 },
        effects: ["38 threads triaged.", "4 replies drafted, 4 sent.", "6 facts, 2 reminders filed."],
        prose: [
          "I read 38 new threads this morning, replied to two that were routine, and drafted two more that I'd rather you saw first.",
          "Six things went into memory — a new number for Priya, the boiler service window, and four smaller facts. Two became reminders instead, because they have dates attached.",
          "You cleared both held drafts at 06:38 and I sent them straight after.",
        ],
        trace: [
          {
            name: "triage.fetch",
            detail: "38 unread",
            durationMs: 1200,
            children: [{ name: "gmail.list", detail: "is:unread", durationMs: 1200, tool: true }],
          },
          { name: "triage.classify", detail: "38 sorted", durationMs: 8400 },
          {
            name: "triage.respond",
            detail: "2 sent, 2 held",
            durationMs: 6100,
            children: [
              { name: "gmail.send", detail: "thread/9a12, thread/9a44", durationMs: 2400, tool: true },
              { name: "gate.request_approval", detail: "2 drafts · approved 06:38", note: "commits money", durationMs: 2_220_000 },
              { name: "gmail.send", detail: "thread/9b07, thread/9b31", durationMs: 2100, tool: true },
            ],
          },
          { name: "memory.commit", detail: "6 facts, 2 reminders", durationMs: 1100, tool: true },
        ],
        logs: [
          { t: "06:00:02.110", level: "info", text: "run started · workflow=inbox-triage · trigger=schedule" },
          { t: "06:00:03.330", level: "ok", text: "38 unread threads fetched" },
          { t: "06:22:40.001", level: "ok", text: "2 replies sent" },
          { t: "06:22:40.774", level: "warn", text: "2 drafts held · reason=commits money" },
          { t: "06:38:51.204", level: "ok", text: "approved by user · sending 2 held drafts" },
          { t: "06:41:00.512", level: "ok", text: "memory.commit · 6 facts, 2 reminders" },
        ],
        transcript: [
          { who: "agent", text: "Inbox is triaged. Two drafts are waiting on you — both commit money, so I held them." },
          { who: "you", text: "Which ones?" },
          { who: "agent", text: "The invoice confirmation for Latham and the quote acceptance for the roof work." },
          { who: "you", text: "Both fine. Send them." },
          { who: "agent", text: "Sent. I've noted that neither needed a change, in case that becomes a pattern worth asking you about." },
        ],
      },
      { ordinal: 211, state: "done", trigger: "schedule", start: { dayOffset: -1, hour: 6, minute: 0 }, durationMs: 2_200_000, step: { index: 9, total: 9 } },
    ],
  },

  "contract-review": {
    summary:
      "I drafted the reply agreeing to the March 1 start and pushing back on the handling fee. It's with you now — nothing goes out until you say so.",
    runsTotal: 3,
    cleanRuns: 2,
    runs: [
      {
        ordinal: 3,
        state: "attention",
        trigger: "manual",
        start: { dayOffset: 0, hour: 7, minute: 38 },
        durationMs: null,
        step: { index: 4, total: 7 },
        effects: ["Reply drafted to Ferris.", "Contract terms noted in memory.", "Nothing sent yet."],
        prose: [
          "I read the amendment, checked the March calendar, and drafted a reply agreeing to the March 1 start.",
          "I pushed back on the handling fee, since you had that waived yourself last year and there's a note in memory saying so. The draft is written and sitting with you; nothing goes out until you approve it.",
        ],
        trace: [
          { name: "contract.read_amendment", detail: "thread/1f8ac2", durationMs: 1100 },
          {
            name: "contract.check_terms",
            detail: "2 changes found",
            durationMs: 900,
            children: [
              { name: "memory.read", detail: "okf:contact/ferris", durationMs: 400, tool: true },
              { name: "memory.read", detail: "okf:vendor/ferris-terms", durationMs: 300, tool: true },
              { name: "calendar.check", detail: "mar-01..mar-07", durationMs: 200, tool: true },
            ],
          },
          {
            name: "contract.draft_reply",
            detail: "1 draft written",
            durationMs: 1900,
            children: [{ name: "gmail.draft", detail: "→ thread/1f8ac2", durationMs: 1900, tool: true }],
          },
          { name: "gate.request_approval", state: "waiting", detail: "1 draft", note: "nothing goes out until you say so" },
          { name: "gmail.send", state: "skipped", detail: "waits for your approval" },
        ],
        logs: [
          { t: "07:38:10.004", level: "info", text: "run started · workflow=contract-review · trigger=manual" },
          { t: "07:40:02.551", level: "ok", text: "draft written · 2 terms addressed" },
          { t: "07:41:00.120", level: "info", text: "approval requested · reason=outbound email" },
        ],
        transcript: [
          {
            who: "agent",
            text: "The Ferris amendment is fine on dates but adds a handling fee. Draft ready — agree to March 1, decline the fee?",
          },
        ],
      },
      { ordinal: 2, state: "done", trigger: "manual", start: { dayOffset: -6, hour: 11, minute: 2 }, durationMs: 220_000, step: { index: 7, total: 7 } },
    ],
  },

  "calendar-tidy": {
    summary:
      "I moved two overlapping meetings and dropped a hold that nobody accepted. Nothing that had guests outside the company was touched.",
    runsTotal: 96,
    cleanRuns: 96,
    runs: [
      {
        ordinal: 96,
        state: "done",
        trigger: "schedule",
        start: { dayOffset: -1, hour: 22, minute: 4 },
        durationMs: 41_000,
        step: { index: 3, total: 3 },
        effects: ["2 events moved.", "1 unaccepted hold removed.", "No external invites changed."],
      },
      { ordinal: 95, state: "done", trigger: "schedule", start: { dayOffset: -2, hour: 22, minute: 0 }, durationMs: 38_000, step: { index: 3, total: 3 } },
    ],
  },

  "memory-compaction": {
    summary:
      "I merged fourteen duplicate facts and retired six that nothing has referenced since May. Anything you wrote by hand was left alone.",
    runsTotal: 22,
    cleanRuns: 22,
    runs: [
      {
        ordinal: 22,
        state: "done",
        trigger: "schedule",
        start: { dayOffset: 0, hour: 3, minute: 1 },
        durationMs: 330_000,
        step: { index: 5, total: 5 },
        effects: ["14 facts merged.", "6 stale facts retired.", "Hand-written entries untouched."],
      },
    ],
  },

  "bill-watch": {
    summary:
      "Nothing new since the last pass. I check the four accounts you named and only speak up when an amount differs from the last cycle.",
    runsTotal: 1417,
    cleanRuns: 1410,
    runs: [
      {
        ordinal: 1417,
        state: "done",
        trigger: "schedule",
        start: { minutesAgo: 12 },
        durationMs: 11_000,
        step: { index: 2, total: 2 },
        effects: ["4 accounts checked.", "No new bills.", "No alerts raised."],
      },
    ],
  },

  // Paused on Aug 9 and never resumed, so there is nothing to show. The
  // executions tab says so rather than drawing an empty table.
  "job-listings-sweep": {
    summary:
      "You paused this on Aug 9 and didn't say for how long, so it hasn't run since. Resuming picks it back up on the next Friday.",
    runsTotal: 18,
    cleanRuns: 17,
    runs: [],
  },
};
