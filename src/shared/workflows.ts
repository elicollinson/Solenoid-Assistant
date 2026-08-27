// The wire shape of GET /api/workflows and GET /api/workflows/:slug.
//
// Pure types and nothing else, for the same reason src/shared/home.ts is:
// the browser half compiles against this file and has no Bun types.
import type { HomeAction, HomeState } from "./home";

export type WorkflowStepState = "ok" | "running" | "failed" | "waiting" | "skipped";
export type WorkflowLogLevel = "debug" | "info" | "ok" | "warn" | "error";

/** How the trigger form draws one argument. */
export type WorkflowInputKind = "text" | "textarea" | "number" | "datetime";

/**
 * One argument a runnable workflow takes.
 *
 * The catalog in src/workflows/catalog.ts is the only place these are written;
 * the form is drawn from them rather than hand-built per workflow, so adding a
 * workflow adds its form. `default` is both what the field is prefilled with
 * and what the server falls back to when it is left blank.
 */
export interface WorkflowInputField {
  name: string;
  label: string;
  kind: WorkflowInputKind;
  required: boolean;
  placeholder: string | null;
  default: string | number | null;
  help: string | null;
}

/** One line of the workflow table. */
export interface WorkflowRow {
  slug: string;
  name: string;
  state: HomeState;
  /** "6/11". Null until it has run at all. */
  step: string | null;
  /** "Weekdays, 06:00", "On demand". */
  cadence: string;
  /** "Running since 06:12", "Halted yesterday, 21:04", "Paused by you on 09 Aug". */
  last: string;
  paused: boolean;
  /** Whether a schedule fires it, as opposed to you or an event. */
  scheduled: boolean;
  /**
   * One line from me about this workflow, where the phone has no room for the
   * cadence, last-run and step columns. Null on a surface nobody wrote one for
   * — the desktop table draws those columns instead and needs no sentence.
   */
  lede: string | null;
  /**
   * Whether this row can actually be started from here.
   *
   * False for the design's demonstration workflows, which have runs on the
   * record but no code behind them — the Run control is absent rather than
   * present and lying about what a click would do.
   */
  runnable: boolean;
}

export interface WorkflowsPayload {
  /** The agent's own line, plus what is true of the table right now. */
  lede: string;
  /** What I have not done about any of it — the digest I did not restart, the
   *  sweep I have not resumed. Under the list rather than in the lede, and null
   *  where nobody wrote one. */
  restraint: string | null;
  rows: WorkflowRow[];
}

export interface WorkflowStat {
  label: string;
  value: string;
}

/** An open decision the run is sitting on, with the buttons that close it. */
export interface WorkflowGate {
  id: string;
  title: string;
  body: string | null;
  actions: HomeAction[];
}

export interface WorkflowToolCall {
  name: string;
  arg: string | null;
  duration: string | null;
}

export interface WorkflowTraceNode {
  name: string;
  detail: string | null;
  note: string | null;
  duration: string | null;
  state: WorkflowStepState;
  children: WorkflowTraceNode[];
}

export interface WorkflowLogLine {
  /** "06:12:04.221" */
  t: string;
  level: WorkflowLogLevel;
  text: string;
  /**
   * Which part of the app said it — "workflow", "http", "imessage".
   *
   * Absent on the lines kept in the run record, which are all the runner's
   * own. Present on the ones read back out of the log store, where a run's
   * log is everything that happened during it rather than the four sentences
   * the runner wrote down about it.
   */
  component?: string;
  /** Which process said it: "solenoid-server", "solenoid-worker". */
  service?: string;
}

/**
 * The log for one run, and where it came from.
 *
 * Two sources on purpose. VictoriaLogs is the one worth reading — it has every
 * line from every part of the app that ran under this run's id, correlated by
 * trace. The run record in SQLite holds only the runner's own bookkeeping, and
 * is what answers when the log store is off or unreachable. `source` says
 * which you are looking at rather than letting the thinner one pass for the
 * fuller one.
 */
export interface WorkflowRunLogsPayload {
  runId: string;
  source: "victorialogs" | "database";
  /** Why the store was not used. Null when it was. */
  note: string | null;
  lines: WorkflowLogLine[];
}

export interface WorkflowTurn {
  who: "you" | "agent";
  text: string;
}

/** Everything kept about one execution. Absent for runs predating the record. */
export interface WorkflowRunDetail {
  prose: string[];
  /** What the workflow returned, pretty-printed. Null for runs that kept no
   *  result — every design fixture, and any run that failed before returning. */
  output: string | null;
  calls: WorkflowToolCall[];
  trace: WorkflowTraceNode[];
  logs: WorkflowLogLine[];
  transcript: WorkflowTurn[];
}

export interface WorkflowExecution {
  id: string;
  /** "Run 14" */
  label: string;
  /** "Today 06:12" */
  when: string;
  state: HomeState;
  /** How this one ended, in a word: "done", "halted", "stopped", "running",
   *  "needs you", "queued". Same reason the workflow carries one — the status
   *  mark cannot tell a run you stopped from one that never started. */
  badge: string;
  /** "18m 40s", or what it is doing instead of having taken one. */
  duration: string;
  /** Why it halted, in the words the error came with. Null unless it failed. */
  error: string | null;
  detail: WorkflowRunDetail | null;
}

export interface WorkflowDetailPayload {
  slug: string;
  name: string;
  /** What the workflow is for, from the catalog. Null for a workflow with no
   *  code behind it, which is every design fixture. */
  description: string | null;
  state: HomeState;
  /**
   * The word under the name: "running", "needs you", "halted", "done",
   * "stopped", "paused", "never run".
   *
   * Said here rather than derived from `state` in the browser, because `state`
   * is the five-value status mark and is lossy on purpose — a run you stopped
   * and a workflow you paused are both "idle" to a coloured dot, and only one
   * of them is paused. The badge is the place that distinction has to survive.
   */
  badge: string;
  step: string | null;
  cadence: string;
  last: string;
  paused: boolean;
  /** The agent's account of where this stands. */
  summary: string | null;
  /** The `changed` list from the latest run. */
  changed: string[];
  stats: WorkflowStat[];
  /** Standing instructions, in your words. Null when there are none. */
  instructions: string | null;
  gate: WorkflowGate | null;
  /** Whether POST /api/workflows/:slug/run will do anything. */
  runnable: boolean;
  /** The arguments it takes, in the order the form draws them. Empty for a
   *  workflow that takes none, and for one that cannot be run at all. */
  inputs: WorkflowInputField[];
  progress: { value: number; total: number } | null;
  /** Newest first. */
  executions: WorkflowExecution[];
}

/** What POST /api/workflows/:slug/run answers with. The run is under way by
 *  the time this arrives; the table and the detail read its state as it goes. */
export interface WorkflowRunAccepted {
  runId: string;
  ordinal: number;
  /** "Run 3" — the same label the executions list gives it. */
  label: string;
}
