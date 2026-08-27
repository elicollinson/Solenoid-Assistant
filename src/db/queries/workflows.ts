// The Workflows surface: the table, and everything behind one row.
//
// The design's fixtures store the state, the step and the last-run line as
// display strings on each workflow. All three are properties of the newest run,
// so they are read off it here — a stored "Running since 06:12" is wrong the
// moment the run ends, and a stored state is wrong the moment one starts.
//
// What is not derivable is the agent's prose (the summary, the write-up, the
// standing instruction) and the lifetime tallies, which count runs the database
// keeps no rows for. Those are read as written.
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../index";
import * as s from "../schema";
import type {
  WorkflowDetailPayload,
  WorkflowExecution,
  WorkflowGate,
  WorkflowLogLevel,
  WorkflowLogLine,
  WorkflowRow,
  WorkflowRunDetail,
  WorkflowStat,
  WorkflowStepState,
  WorkflowToolCall,
  WorkflowTraceNode,
  WorkflowsPayload,
} from "../../shared/workflows";
import type { HomeState } from "../../shared/home";
import type { Surface } from "../../shared/surface";
import { catalogEntry } from "../../workflows/catalog";
import { capitalise, clock, duration, logStamp, minutesAgo, shortDay, spell, stamp, stampLong } from "./_format";
import { narrativeBySubject, narrativeFor } from "./_narrative";
import { surfaceNote } from "./_surface";

export type * from "../../shared/workflows";

/** These fail to compile if the schema widens a vocabulary the wire committed to. */
export type StepStateIsCovered = (typeof s.STEP_STATE)[number] extends WorkflowStepState ? true : never;
export type LogLevelIsCovered = (typeof s.LOG_LEVEL)[number] extends WorkflowLogLevel ? true : never;

type Run = typeof s.workflowRuns.$inferSelect;
type Workflow = typeof s.workflows.$inferSelect;

/**
 * A run has six states; a status mark has five, and "queued" and "cancelled"
 * both read as nothing happening. The mark is the lossy one on purpose.
 */
function markFor(run: Run | undefined, paused: boolean): HomeState {
  if (paused || !run) return "idle";
  switch (run.state) {
    case "running":
      return "running";
    case "attention":
      return "attention";
    case "failed":
      return "failed";
    case "done":
      return "done";
    default:
      return "idle";
  }
}

/**
 * The word under the workflow's name.
 *
 * Six outcomes where the status mark has five: `cancelled` and `queued` both
 * read as nothing happening to a coloured dot, and "you stopped that run" and
 * "you paused this workflow" are not the same thing to say about it.
 */
function badgeFor(workflow: Workflow | null, run: Run | undefined): string {
  // Null where the subject is a run rather than a workflow: pausing is a
  // property of the workflow, and no run was ever paused.
  if (workflow?.pausedAt) return "paused";
  if (!run) return "never run";
  switch (run.state) {
    case "running":
      return "running";
    case "attention":
      return "needs you";
    case "failed":
      return "halted";
    case "done":
      return "done";
    case "cancelled":
      return "stopped";
    default:
      return "queued";
  }
}

/** The "Last run" column, in the agent's voice rather than a bare timestamp. */
function lastLine(workflow: Workflow, run: Run | undefined, gateOpenedAt: Date | null, now: Date): string {
  if (workflow.pausedAt) return `Paused by you on ${shortDay(workflow.pausedAt)}`;
  if (!run) return "Never run";

  if (run.state === "running" && run.startedAt) return `Running since ${stamp(run.startedAt, now)}`;
  if (run.state === "attention") {
    const since = gateOpenedAt ?? run.startedAt;
    return since ? `Waiting on you since ${stamp(since, now)}` : "Waiting on you";
  }

  const ended = run.endedAt ?? run.startedAt;
  if (!ended) return "Never run";
  const verb = run.state === "failed" ? "Halted" : run.state === "cancelled" ? "Stopped" : "Finished";
  // Anything inside the hour reads better as an interval than as a clock.
  return `${verb} ${minutesAgo(ended, now) ?? stamp(ended, now)}`;
}

/** The newest run per workflow, keyed by workflow id. */
function latestRuns(db: Db): Map<string, Run> {
  const byWorkflow = new Map<string, Run>();
  for (const run of db.select().from(s.workflowRuns).orderBy(desc(s.workflowRuns.ordinal)).all()) {
    if (!byWorkflow.has(run.workflowId)) byWorkflow.set(run.workflowId, run);
  }
  return byWorkflow;
}

/**
 * The gate a run is sitting on.
 *
 * A run does not own its decision — the feed entry about the run does, because
 * that is the row the buttons were authored against. So the join goes through
 * the activity item rather than inventing a second link.
 */
function openGates(db: Db): Map<string, typeof s.decisions.$inferSelect> {
  const byRun = new Map<string, typeof s.decisions.$inferSelect>();
  for (const row of db
    .select({ runId: s.activityItems.runId, decision: s.decisions })
    .from(s.decisions)
    .innerJoin(s.activityItems, eq(s.activityItems.decisionId, s.decisions.id))
    .where(eq(s.decisions.state, "open"))
    .all()) {
    if (row.runId) byRun.set(row.runId, row.decision);
  }
  return byRun;
}

/** "Weekdays, 06:00" while the RRULE has no renderer; "On demand" is derived. */
function cadences(db: Db): Map<string, string> {
  const byWorkflow = new Map<string, string>();
  for (const row of db.select().from(s.workflowSchedules).all()) {
    if (row.label) byWorkflow.set(row.workflowId, row.label);
  }
  return byWorkflow;
}

/**
 * What needs you, then what is happening, then what broke, then the quiet ones,
 * then what you paused. The design's fixture order is a hand-written list; this
 * is the same idea derived, so a workflow that starts needing you moves up.
 */
const URGENCY: Record<HomeState, number> = { attention: 0, running: 1, failed: 2, done: 3, idle: 4 };

export function loadWorkflows(db: Db, now: Date = new Date(), surface: Surface = "desktop"): WorkflowsPayload {
  const workflows = db.select().from(s.workflows).all();
  // The phone's row is one sentence instead of three columns; the desktop has
  // no such slot written, so this map is empty there and every `lede` is null.
  const ledes = narrativeBySubject(db, "lede", surface);
  const runs = latestRuns(db);
  const gates = openGates(db);
  const cadence = cadences(db);
  const scheduled = new Set(
    db.select({ id: s.workflowSchedules.workflowId }).from(s.workflowSchedules).where(eq(s.workflowSchedules.enabled, true)).all().map((r) => r.id),
  );

  const recency = (id: string) => runs.get(id)?.startedAt?.getTime() ?? 0;
  const rows: WorkflowRow[] = workflows
    .map((w) => {
    const run = runs.get(w.id);
    const gate = run ? gates.get(run.id) : undefined;
    return {
      slug: w.slug,
      name: w.name,
      state: markFor(run, w.pausedAt != null),
      step: run && run.stepIndex != null && run.stepTotal != null ? `${run.stepIndex}/${run.stepTotal}` : null,
      cadence: cadence.get(w.id) ?? (w.triggerKind === "on_demand" ? "On demand" : "Unscheduled"),
      last: lastLine(w, run, gate?.openedAt ?? null, now),
      paused: w.pausedAt != null,
      scheduled: scheduled.has(w.id),
      lede: ledes.get(w.id) ?? null,
      runnable: catalogEntry(w.slug) != null,
      // Kept only for the sort below; not part of the wire shape.
      _at: recency(w.id),
    };
  })
    .sort((a, b) => URGENCY[a.state] - URGENCY[b.state] || b._at - a._at)
    .map(({ _at, ...row }) => row);

  return {
    lede: [surfaceNote(db, "workflows", "line", surface), tally(rows)].filter(Boolean).join(" "),
    restraint: surfaceNote(db, "workflows", "restraint", surface) || null,
    rows,
  };
}

/** "One is going now; one is waiting on you." — counted, then said. */
function tally(rows: readonly WorkflowRow[]): string {
  const clauses: string[] = [];
  const running = rows.filter((r) => r.state === "running").length;
  const waiting = rows.filter((r) => r.state === "attention").length;
  const stopped = rows.filter((r) => r.state === "failed").length;
  if (running) clauses.push(`${spell(running)} ${running === 1 ? "is" : "are"} going now`);
  if (stopped) clauses.push(`${spell(stopped)} stopped`);
  if (waiting) clauses.push(`${spell(waiting)} ${waiting === 1 ? "is" : "are"} waiting on you`);
  if (clauses.length === 0) return "Nothing is running and nothing needs you.";
  return `${capitalise(clauses.join("; "))}.`;
}

export function loadWorkflow(
  db: Db,
  slug: string,
  now: Date = new Date(),
  surface: Surface = "desktop",
): WorkflowDetailPayload | null {
  const [workflow] = db.select().from(s.workflows).where(eq(s.workflows.slug, slug)).limit(1).all();
  if (!workflow) return null;

  const runs = db
    .select()
    .from(s.workflowRuns)
    .where(eq(s.workflowRuns.workflowId, workflow.id))
    .orderBy(desc(s.workflowRuns.ordinal))
    .all();
  const latest = runs[0];
  const gateRow = latest ? openGates(db).get(latest.id) : undefined;

  const gate: WorkflowGate | null = gateRow
    ? {
        id: gateRow.id,
        title: gateRow.title,
        body: gateRow.body,
        actions: db
          .select()
          .from(s.actions)
          .where(eq(s.actions.decisionId, gateRow.id))
          .orderBy(asc(s.actions.ordinal))
          .all()
          .map((a) => ({ id: a.id, label: a.label, stance: a.stance, effectKind: a.effectKind, effect: a.effect })),
      }
    : null;

  // The phone's sheet says the same thing in a third of the words, so it is
  // written as its own slot rather than as a shorter `summary` — the desktop
  // would then have lost the long one. Absent on the phone means fall back.
  const sheet = surface === "desktop" ? null : narrativeFor(db, workflow.id, "sheet", surface);
  const [summary] = db
    .select({ text: s.narratives.text })
    .from(s.narratives)
    .where(and(eq(s.narratives.subjectId, workflow.id), eq(s.narratives.slot, "summary")))
    .limit(1)
    .all();

  const [instruction] = db
    .select({ text: s.workflowInstructions.text })
    .from(s.workflowInstructions)
    .where(and(eq(s.workflowInstructions.workflowId, workflow.id), isNull(s.workflowInstructions.retiredAt)))
    .orderBy(desc(s.workflowInstructions.version))
    .limit(1)
    .all();

  const changed = latest
    ? db
        .select({ text: s.runEffects.text })
        .from(s.runEffects)
        .where(eq(s.runEffects.runId, latest.id))
        .orderBy(asc(s.runEffects.ordinal))
        .all()
        .map((e) => e.text)
    : [];

  const cadence = cadences(db).get(workflow.id) ?? (workflow.triggerKind === "on_demand" ? "On demand" : "Unscheduled");
  // What the workflow is and what it takes are properties of the code behind
  // it, not of the row — a design fixture has neither, and says so by being
  // absent from the catalog rather than by carrying empty columns.
  const catalogued = catalogEntry(workflow.slug);

  return {
    slug: workflow.slug,
    name: workflow.name,
    description: catalogued?.description ?? null,
    state: markFor(latest, workflow.pausedAt != null),
    badge: badgeFor(workflow, latest),
    step: latest && latest.stepIndex != null && latest.stepTotal != null ? `${latest.stepIndex}/${latest.stepTotal}` : null,
    cadence,
    last: lastLine(workflow, latest, gateRow?.openedAt ?? null, now),
    paused: workflow.pausedAt != null,
    summary: sheet ?? summary?.text ?? null,
    changed,
    stats: statsFor(db, workflow, latest, gateRow?.openedAt ?? null),
    instructions: instruction?.text ?? null,
    gate,
    runnable: catalogued != null,
    inputs: catalogued ? [...catalogued.inputs] : [],
    progress:
      latest?.state === "running" && latest.stepIndex != null && latest.stepTotal != null
        ? { value: latest.stepIndex, total: latest.stepTotal }
        : null,
    executions: runs.map((run) => execution(db, run, now)),
  };
}

/**
 * Runs and clean runs are read as written; the rest is counted or timed.
 *
 * "As written" only covers the design's fixtures, whose 212 runs are history
 * this database holds no rows for. A workflow that has only ever run here has
 * every one of its runs on the record, so its tallies are counted instead —
 * stored ones would be a second answer to a question the rows already settle.
 */
function statsFor(db: Db, workflow: Workflow, latest: Run | undefined, gateOpenedAt: Date | null): WorkflowStat[] {
  const stats: WorkflowStat[] = db
    .select({ label: s.attributes.label, value: s.attributes.value })
    .from(s.attributes)
    .where(and(eq(s.attributes.subjectId, workflow.id), eq(s.attributes.groupSlot, "stats")))
    .orderBy(asc(s.attributes.ordinal))
    .all();

  if (stats.length === 0) {
    const runs = db
      .select({ state: s.workflowRuns.state })
      .from(s.workflowRuns)
      .where(eq(s.workflowRuns.workflowId, workflow.id))
      .all();
    stats.push({ label: "Runs", value: String(runs.length) });
    stats.push({ label: "Clean runs", value: String(runs.filter((r) => r.state === "done").length) });
  }

  const [median] = db
    .select({ ms: s.vWorkflowStats.medianDurationMs })
    .from(s.vWorkflowStats)
    .where(eq(s.vWorkflowStats.workflowId, workflow.id))
    .limit(1)
    .all();
  stats.push({ label: "Median", value: duration(median?.ms ?? null) ?? "—" });

  // The fourth pair says what the workflow is doing, so it changes with it.
  if (workflow.pausedAt) stats.push({ label: "Paused", value: shortDay(workflow.pausedAt) });
  else if (!latest) stats.push({ label: "Last run", value: "never" });
  else if (latest.state === "running" && latest.startedAt) stats.push({ label: "Started", value: clock(latest.startedAt) });
  else if (latest.state === "attention") stats.push({ label: "Waiting since", value: clock(gateOpenedAt ?? latest.startedAt ?? new Date()) });
  else if (latest.endedAt)
    stats.push({
      label: latest.state === "failed" ? "Halted" : latest.state === "cancelled" ? "Stopped" : "Finished",
      value: clock(latest.endedAt),
    });

  return stats;
}

/** What a run took, or what it is doing instead of having taken anything. */
function ran(run: Run): string {
  // A stopped run has a duration too: how long you let it go before deciding
  // it was not going to end. The word for what happened is on the badge.
  if (run.durationMs != null) return duration(run.durationMs) ?? "—";
  if (run.state === "running") return "running";
  if (run.state === "attention") return "held";
  return "—";
}

function execution(db: Db, run: Run, now: Date): WorkflowExecution {
  return {
    id: run.id,
    label: `Run ${run.ordinal}`,
    when: run.startedAt ? stampLong(run.startedAt, now) : "not started",
    state: markFor(run, false),
    badge: badgeFor(null, run),
    duration: ran(run),
    error: run.error,
    detail: detailFor(db, run),
  };
}

/**
 * The write-up, the trace, the log and the transcript.
 *
 * Runs older than the retained record have none of it, and the pane says so
 * rather than drawing four empty tabs.
 */
function detailFor(db: Db, run: Run): WorkflowRunDetail | null {
  const steps = db.select().from(s.runSteps).where(eq(s.runSteps.runId, run.id)).orderBy(asc(s.runSteps.ordinal)).all();
  const prose = db
    .select({ text: s.narratives.text })
    .from(s.narratives)
    .where(and(eq(s.narratives.subjectId, run.id), eq(s.narratives.slot, "summary")))
    .orderBy(asc(s.narratives.ordinal))
    .all()
    .map((n) => n.text);

  const logs = loadRunLogs(db, run.id);

  const transcript = run.transcriptConversationId
    ? db
        .select()
        .from(s.messages)
        .where(eq(s.messages.conversationId, run.transcriptConversationId))
        .orderBy(asc(s.messages.seq))
        .all()
        .map((m) => ({ who: (m.sentBy === "user" ? "you" : "agent") as "you" | "agent", text: m.body }))
    : [];

  if (steps.length === 0 && prose.length === 0 && logs.length === 0 && transcript.length === 0) return null;

  // What the workflow handed back. The runner keeps it on the run's top-level
  // tool step rather than in a column of its own, which is also what makes it
  // show up in the trace — one result, read two ways, same as the tool list.
  const returned = steps.find((step) => step.parentId == null && step.toolResult != null);

  // The tree and the flat tool list are the same rows read two ways.
  const calls: WorkflowToolCall[] = steps
    .filter((step) => step.isTool)
    .map((step) => ({ name: step.name, arg: step.detail, duration: duration(step.durationMs) }));

  const byParent = new Map<string | null, WorkflowTraceNode[]>();
  const nodeById = new Map<string, WorkflowTraceNode>();
  for (const step of steps) {
    const node: WorkflowTraceNode = {
      name: step.name,
      detail: step.detail,
      note: step.note,
      duration: duration(step.durationMs),
      state: step.state,
      children: [],
    };
    nodeById.set(step.id, node);
    const siblings = byParent.get(step.parentId) ?? [];
    siblings.push(node);
    byParent.set(step.parentId, siblings);
  }
  for (const [parentId, children] of byParent) {
    if (parentId != null) {
      const parent = nodeById.get(parentId);
      if (parent) parent.children = children;
    }
  }

  return {
    prose,
    output: returned ? JSON.stringify(returned.toolResult, null, 2) : null,
    calls,
    trace: byParent.get(null) ?? [],
    logs,
    transcript,
  };
}

/**
 * The runner's own log lines for one run, out of the run record.
 *
 * The thin half of the story on purpose: this is the four-or-five sentences
 * the runner writes down, kept in SQLite so a run's log survives the log store
 * being wiped, off, or not yet started. The fuller version — every line every
 * part of the app emitted under this run's id — comes from VictoriaLogs, and
 * `GET /api/runs/:runId/logs` prefers it and falls back to this.
 */
export function loadRunLogs(db: Db, runId: string): WorkflowLogLine[] {
  return db
    .select()
    .from(s.runLogs)
    .where(eq(s.runLogs.runId, runId))
    .orderBy(asc(s.runLogs.seq))
    .all()
    .map((l) => ({ t: logStamp(l.at), level: l.level as WorkflowLogLevel, text: l.text }));
}
