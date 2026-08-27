// Starting a workflow, and writing down what it did.
//
// The run row exists before the work does. That ordering is the whole design:
// the HTTP handler returns as soon as the row is in the database, the browser
// re-reads the same surface it was already drawing, and the run appears in the
// executions list as `running` and turns `done` or `failed` under it. Nothing
// polls a job queue and nothing holds a request open for the twenty minutes a
// screenshot sweep can take.
//
// What gets written is exactly what src/db/queries/workflows.ts reads back, so
// a real run and a seeded one are the same shape on screen: a run row, one tool
// step carrying the arguments and the result, the `changed` effects, the
// write-up as narratives, and a log line per thing worth saying.
import { and, desc, eq } from "drizzle-orm";
import { ulid, type Db } from "../db";
import * as s from "../db/schema";
import { log as baseLog, withLogContext } from "../core/logger";

/** Everything this file says is `component:workflow`, including the lines
 *  written before a run's context exists. */
const log = baseLog.child("workflow");
import { SemanticConventions, safeJson, withSpanKind } from "../core/tracing";
import { catalogEntry } from "./catalog";
import { parseWorkflowArgs, runnableWorkflow, type RunnableWorkflow, type WorkflowOutcome } from "./registry";

/** Thrown when the slug names nothing this database knows — HTTP 404. */
export class UnknownWorkflowError extends Error {
  constructor(slug: string) {
    super(`No workflow called ${slug}`);
    this.name = "UnknownWorkflowError";
  }
}

/** Thrown when the slug is real but cannot be started — HTTP 409. */
export class NotRunnableError extends Error {
  constructor(slug: string, why: string) {
    super(`Workflow "${slug}" can't be run: ${why}`);
    this.name = "NotRunnableError";
  }
}

/** Thrown when asked to stop a run that is not going — HTTP 409. */
export class NotRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotRunningError";
  }
}

export interface StartedRun {
  runId: string;
  ordinal: number;
  /** The finished promise, for a caller that wants to wait — the tests do. The
   *  HTTP handler deliberately does not. */
  settled: Promise<void>;
}

export interface StartOptions {
  now?: Date;
  /**
   * Where the code behind a slug comes from. The registry, everywhere but a
   * test — every real workflow reaches a model, and what is worth checking here
   * is the bookkeeping around one, not the one.
   */
  lookup?: (slug: string) => RunnableWorkflow | undefined;
}

/**
 * The runs this process has going, so one of them can be stopped.
 *
 * Process-local, and deliberately so: a run is a promise on this event loop,
 * and nothing in another process can abort it. A run left `running` by a crash
 * is not in here, which is exactly why stopping one is refused rather than
 * pretended — see cancelWorkflowRun.
 */
const inFlight = new Map<string, AbortController>();

/**
 * Stop waiting on a run.
 *
 * What this can promise is narrow, and the log line says so rather than
 * overselling it: the run row goes to `cancelled` now, the signal is raised for
 * whatever is downstream of it, and if the work lands anyway its result is
 * dropped on the floor instead of overwriting the row. A model call already in
 * flight keeps going until the provider answers it — there is no way to reach
 * back through an HTTP request that has left the machine.
 */
export function cancelWorkflowRun(db: Db, runId: string, now: Date = new Date()): void {
  const [run] = db.select().from(s.workflowRuns).where(eq(s.workflowRuns.id, runId)).limit(1).all();
  if (!run) throw new UnknownWorkflowError(runId);
  if (run.state !== "running") throw new NotRunningError(`Run ${run.ordinal} is ${run.state}, not running`);

  inFlight.get(runId)?.abort();
  inFlight.delete(runId);

  const durationMs = run.startedAt ? now.getTime() - run.startedAt.getTime() : null;
  db.update(s.workflowRuns)
    .set({ state: "cancelled", endedAt: now, durationMs })
    .where(eq(s.workflowRuns.id, runId))
    .run();

  write(
    db,
    runId,
    nextSeq(db, runId),
    "warn",
    `Run ${run.ordinal} stopped by you. Anything already sent to a model finishes on its own; I won't record what it says.`,
    now,
  );
}

/**
 * Stop whichever run of this workflow is going.
 *
 * The header's control names a workflow, not a run — "kill run" is pressed
 * while looking at the one going now — so the lookup happens here rather than
 * asking the browser to hold a run id it would have to keep in step.
 */
export function stopCurrentRun(db: Db, slug: string, now: Date = new Date()): string {
  const [workflow] = db.select({ id: s.workflows.id }).from(s.workflows).where(eq(s.workflows.slug, slug)).limit(1).all();
  if (!workflow) throw new UnknownWorkflowError(slug);

  const [running] = db
    .select({ id: s.workflowRuns.id })
    .from(s.workflowRuns)
    .where(and(eq(s.workflowRuns.workflowId, workflow.id), eq(s.workflowRuns.state, "running")))
    .orderBy(desc(s.workflowRuns.ordinal))
    .limit(1)
    .all();
  if (!running) throw new NotRunningError(`Workflow "${slug}" has no run going`);

  cancelWorkflowRun(db, running.id, now);
  return running.id;
}

/** Whether this run is still the one the record is waiting on. */
function stillOpen(db: Db, runId: string): boolean {
  const [run] = db.select({ state: s.workflowRuns.state }).from(s.workflowRuns).where(eq(s.workflowRuns.id, runId)).limit(1).all();
  return run?.state === "running";
}

/** The next log line's number, so a cancel can write after what is already there. */
function nextSeq(db: Db, runId: string): number {
  const [last] = db
    .select({ seq: s.runLogs.seq })
    .from(s.runLogs)
    .where(eq(s.runLogs.runId, runId))
    .orderBy(desc(s.runLogs.seq))
    .limit(1)
    .all();
  return (last?.seq ?? -1) + 1;
}

/**
 * Validate, open a run, and start the work.
 *
 * Everything that can be refused is refused before the row is written, so a
 * rejected trigger leaves no trace of an execution that never happened.
 */
export function startWorkflowRun(db: Db, slug: string, rawArgs: unknown, options: StartOptions = {}): StartedRun {
  const now = options.now ?? new Date();
  const lookup = options.lookup ?? runnableWorkflow;

  const [workflow] = db.select().from(s.workflows).where(eq(s.workflows.slug, slug)).limit(1).all();
  if (!workflow) throw new UnknownWorkflowError(slug);

  const runnable = lookup(slug);
  if (!runnable) throw new NotRunnableError(slug, "there is no code behind it yet");
  if (workflow.pausedAt) throw new NotRunnableError(slug, "you paused it");

  // Throws WorkflowArgsError, which the route turns into a 400.
  const args = parseWorkflowArgs(slug, rawArgs, runnable);

  const [previous] = db
    .select({ ordinal: s.workflowRuns.ordinal })
    .from(s.workflowRuns)
    .where(eq(s.workflowRuns.workflowId, workflow.id))
    .orderBy(desc(s.workflowRuns.ordinal))
    .limit(1)
    .all();
  const ordinal = (previous?.ordinal ?? 0) + 1;

  const runId = ulid(now.getTime());
  db.transaction((t) => {
    t.insert(s.entities).values({ id: runId, kind: "workflow_run", createdAt: now, updatedAt: now }).run();
    t.insert(s.workflowRuns)
      .values({
        id: runId,
        workflowId: workflow.id,
        versionId: workflow.currentVersionId,
        ordinal,
        trigger: "manual",
        triggeredBy: "user",
        state: "running",
        // One step until a workflow reports its own stages. Said rather than
        // left null, so the detail pane can draw a meter at all.
        stepIndex: 0,
        stepTotal: 1,
        startedAt: now,
      })
      .run();
    t.update(s.workflows).set({ lastRunId: runId }).where(eq(s.workflows.id, workflow.id)).run();
  });

  write(db, runId, 0, "info", `Run ${ordinal} started by you.`, now);
  write(db, runId, 1, "debug", `Arguments: ${safeJson(args)}`, now);

  const controller = new AbortController();
  inFlight.set(runId, controller);

  return { runId, ordinal, settled: execute(db, runId, runnable, args, ordinal, controller.signal) };
}

/**
 * The work itself, and everything written down about it.
 *
 * Deliberately never rejects: this promise is dropped on the floor by the HTTP
 * handler, and an unhandled rejection would take the process with it. A failure
 * is a state on the run row, which is where the screen reads it from anyway.
 */
function execute(
  db: Db,
  runId: string,
  runnable: RunnableWorkflow,
  args: unknown,
  ordinal: number,
  signal: AbortSignal,
): Promise<void> {
  // Everything the work says, at any depth, comes out carrying this run's id
  // without a single signature between here and there having to mention it.
  // That is what makes `run_id:"01J..."` in VictoriaLogs the whole story of a
  // run rather than the four sentences the runner wrote down about it.
  return withLogContext(
    { component: "workflow", run_id: runId, workflow: runnable.slug },
    () => run(db, runId, runnable, args, ordinal, signal),
  );
}

async function run(
  db: Db,
  runId: string,
  runnable: RunnableWorkflow,
  args: unknown,
  ordinal: number,
  signal: AbortSignal,
): Promise<void> {
  const slug = runnable.slug;
  const startedAt = Date.now();

  try {
    const outcome = await withSpanKind(
      "CHAIN",
      `workflow:${slug}`,
      {
        [SemanticConventions.INPUT_VALUE]: safeJson(args),
        [SemanticConventions.INPUT_MIME_TYPE]: "application/json",
      },
      async (span) => {
        // The run row has carried `trace_id` and `span_id` columns since the
        // schema was written; this is what finally fills them. It is also what
        // makes the three views of one run the same run: the Trace tab, the
        // Phoenix span, and `trace_id:"..."` in the log store.
        rememberTrace(db, runId, span);
        const result = await runnable.execute(args, { signal });
        span.setAttributes({
          [SemanticConventions.OUTPUT_VALUE]: safeJson(result.output),
          [SemanticConventions.OUTPUT_MIME_TYPE]: "application/json",
        });
        return result;
      },
    );

    // A run you stopped has already been written down as stopped. Whatever came
    // back after that is the answer to a question nobody is waiting on.
    if (!stillOpen(db, runId)) {
      log.info(`workflow ${slug} run ${ordinal} finished after being stopped — result dropped`);
      return;
    }
    record(db, runId, slug, args, outcome, startedAt, ordinal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!stillOpen(db, runId)) {
      log.info(`workflow ${slug} run ${ordinal} failed after being stopped — error dropped`, { error: message });
      return;
    }
    log.error(`workflow ${slug} run ${ordinal} failed`, { error: message });
    halt(db, runId, slug, args, message, startedAt, ordinal);
  } finally {
    inFlight.delete(runId);
  }
}

/** Put the run's trace and span ids on its row, best-effort. A tracing setup
 *  that is switched off hands out a no-op span whose ids are all zeroes; there
 *  is nothing to correlate with, so nothing is written. */
function rememberTrace(db: Db, runId: string, span: { spanContext(): { traceId: string; spanId: string } }): void {
  const { traceId, spanId } = span.spanContext();
  if (!traceId || /^0+$/.test(traceId)) return;
  db.update(s.workflowRuns).set({ traceId, spanId }).where(eq(s.workflowRuns.id, runId)).run();
}

/** A finished run: the step, the result, the changed list and the write-up. */
function record(
  db: Db,
  runId: string,
  slug: string,
  args: unknown,
  outcome: WorkflowOutcome,
  startedAt: number,
  ordinal: number,
): void {
  const endedAt = new Date();
  const durationMs = endedAt.getTime() - startedAt;

  db.transaction((t) => {
    step(t, runId, slug, args, outcome.output, "ok", durationMs, endedAt);

    outcome.effects.forEach((text, i) => {
      t.insert(s.runEffects).values({ id: ulid(), runId, ordinal: i, text, effectKind: "note" }).run();
    });
    outcome.prose.forEach((text, i) => {
      t.insert(s.narratives)
        .values({ id: ulid(), subjectId: runId, slot: "summary", surface: "any", text, ordinal: i, generatedAt: endedAt })
        .run();
    });

    t.update(s.workflowRuns)
      .set({ state: "done", stepIndex: 1, endedAt, durationMs })
      .where(eq(s.workflowRuns.id, runId))
      .run();
  });

  write(db, runId, 2, "ok", `Run ${ordinal} finished in ${Math.round(durationMs / 1000)}s.`, endedAt);
}

/** A run that threw. The error is on the row and in the log, both readable. */
function halt(
  db: Db,
  runId: string,
  slug: string,
  args: unknown,
  message: string,
  startedAt: number,
  ordinal: number,
): void {
  const endedAt = new Date();
  const durationMs = endedAt.getTime() - startedAt;

  db.transaction((t) => {
    step(t, runId, slug, args, null, "failed", durationMs, endedAt);
    t.update(s.workflowRuns)
      .set({ state: "failed", endedAt, durationMs, error: message })
      .where(eq(s.workflowRuns.id, runId))
      .run();
  });

  write(db, runId, 2, "error", `Run ${ordinal} halted: ${message}`, endedAt);
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The one step a run has today.
 *
 * A tool step rather than a plain one, because that is what carries `toolArgs`
 * and `toolResult` — which is where the Output pane reads the result from, and
 * why the Trace tab has something to draw. When workflows start reporting their
 * own stages this becomes their parent rather than the whole tree.
 */
function step(
  t: Tx,
  runId: string,
  slug: string,
  args: unknown,
  output: unknown,
  state: "ok" | "failed",
  durationMs: number,
  endedAt: Date,
): void {
  const id = ulid(endedAt.getTime());
  t.insert(s.entities).values({ id, kind: "run_step", createdAt: endedAt, updatedAt: endedAt }).run();
  t.insert(s.runSteps)
    .values({
      id,
      runId,
      parentId: null,
      ordinal: 0,
      depth: 0,
      name: `workflow.${slug.replace(/-/g, "_")}`,
      detail: summarise(args),
      state,
      isTool: true,
      toolName: slug,
      toolArgs: args as Record<string, unknown>,
      toolResult: output,
      startedAt: new Date(endedAt.getTime() - durationMs),
      endedAt,
      durationMs,
    })
    .run();
}

/** The trace's one-line aside: `hoursBack=24, limit=5`, and never a wall of text. */
function summarise(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const pairs = Object.entries(args as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const printed = value instanceof Date ? value.toISOString() : String(value);
      return `${key}=${printed.length > 40 ? `${printed.slice(0, 39)}…` : printed}`;
    });
  return pairs.length ? pairs.join(", ") : null;
}

/**
 * One log line, written twice on purpose.
 *
 * The row goes in outside any transaction so it lands while the run is still
 * open and the browser's next poll can see it — that is the durable half, and
 * what the Logs tab falls back to when the log store is not there.
 *
 * The same line also goes through `log`, which is what puts it in VictoriaLogs
 * carrying `run_id`, the active `trace_id`, and the service that emitted it.
 * That call is fire-and-forget by construction, so a log store that is down
 * cannot slow a run down or fail one.
 */
function write(db: Db, runId: string, seq: number, level: (typeof s.LOG_LEVEL)[number], text: string, at: Date): void {
  db.insert(s.runLogs).values({ runId, at, seq, level, text }).run();
  log[level](text, { run_id: runId, seq });
}

/**
 * Whether a slug can be started at all, for a caller deciding what to draw.
 * A workflow the catalog does not know is a design fixture with runs on the
 * record and no code behind it.
 */
export function isRunnable(slug: string): boolean {
  return catalogEntry(slug) != null && runnableWorkflow(slug) != null;
}
