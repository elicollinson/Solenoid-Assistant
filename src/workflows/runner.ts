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
import { and, asc, desc, eq } from "drizzle-orm";
import { ulid, type Db } from "../db";
import * as s from "../db/schema";
import { log as baseLog, withLogContext } from "../core/logger";

/** Everything this file says is `component:workflow`, including the lines
 *  written before a run's context exists. */
const log = baseLog.child("workflow");
import { SemanticConventions, safeJson, withSpanKind } from "../core/tracing";
import { catalogEntry } from "./catalog";
import { inferenceHeld } from "./inferenceHold";
import { WorkflowArgsError, parseWorkflowArgs, runnableWorkflow, type RunnableWorkflow, type WorkflowOutcome } from "./registry";
import { withRunPermissions } from "./permissions";
import { withRunGuidance, workflowGuidanceSchema } from "../core/runGuidance";
import { withoutTurn } from "../chat/turn";
import { z } from "zod";

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
  /** User guidance for this execution; never saved as workflow configuration. */
  guidance?: string;
  /** Invocation provenance, supplied by the caller, never by the model. */
  source?: { kind: "chat"; conversationId?: string };
  /**
   * Who set this off. Defaults to a person pressing Run.
   *
   * Not cosmetic: the Activity feed, the run history and the calendar all read
   * it, and a run the clock started that is written down as "manual / user"
   * tells you that you did something you did not do. The worker passes
   * "schedule"; nothing else currently needs to.
   */
  trigger?: (typeof s.RUN_TRIGGER)[number];
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
  if (run.state === "queued") {
    // Nothing has been sent anywhere yet, so this one can be promised exactly.
    db.delete(s.runQueue).where(eq(s.runQueue.runId, runId)).run();
    db.update(s.workflowRuns).set({ state: "cancelled", endedAt: now }).where(eq(s.workflowRuns.id, runId)).run();
    write(db, runId, nextSeq(db, runId), "warn", `Run ${run.ordinal} taken off the queue by you before it started.`, now);
    return;
  }
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

/**
 * Whether this workflow already has a run going.
 *
 * The scheduler's guard. croner's own `protect` cannot do this job: it skips a
 * firing while the HANDLER is still running, and the handler here returns as
 * soon as the run row exists — the work continues under its own span. So an
 * hourly rule over a ninety-minute job would start a second, a third and a
 * fourth, all writing to the same workflow.
 *
 * A question rather than a refusal inside `startWorkflowRun`, because starting
 * a second run deliberately is a legitimate thing for a person to do from the
 * Run button. It is the clock that should not.
 */
export function hasRunInFlight(db: Db, slug: string): boolean {
  const [running] = db
    .select({ id: s.workflowRuns.id })
    .from(s.workflowRuns)
    .innerJoin(s.workflows, eq(s.workflows.id, s.workflowRuns.workflowId))
    .where(and(eq(s.workflows.slug, slug), eq(s.workflowRuns.state, "running")))
    .limit(1)
    .all();
  return Boolean(running);
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

/** A trigger that passed every check, and what it resolved to. */
interface Admitted {
  workflow: typeof s.workflows.$inferSelect;
  runnable: RunnableWorkflow;
  args: unknown;
  guidance?: string;
}

/**
 * Everything that can refuse a trigger, before any row is written, so a
 * rejected trigger leaves no trace of an execution that never happened.
 */
function admit(
  db: Db,
  slug: string,
  rawArgs: unknown,
  options: Pick<StartOptions, "guidance" | "lookup">,
): Admitted {
  const lookup = options.lookup ?? runnableWorkflow;

  const [workflow] = db.select().from(s.workflows).where(eq(s.workflows.slug, slug)).limit(1).all();
  if (!workflow) throw new UnknownWorkflowError(slug);

  const runnable = lookup(slug);
  if (!runnable) throw new NotRunnableError(slug, "there is no code behind it yet");
  if (workflow.pausedAt) throw new NotRunnableError(slug, "you paused it");

  // Throws WorkflowArgsError, which the route turns into a 400.
  const args = parseWorkflowArgs(slug, rawArgs, runnable);
  const parsedGuidance = workflowGuidanceSchema.safeParse(options.guidance);
  if (!parsedGuidance.success) throw new WorkflowArgsError(slug, z.prettifyError(parsedGuidance.error));
  const guidance = parsedGuidance.data || undefined;
  return { workflow, runnable, args, ...(guidance ? { guidance } : {}) };
}

/** Write the run row, and its queue entry when it is going to wait. */
function openRun(
  db: Db,
  { workflow, args, guidance }: Admitted,
  trigger: (typeof s.RUN_TRIGGER)[number],
  state: "running" | "queued",
  now: Date,
): { runId: string; ordinal: number } {
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
        trigger,
        // The actor follows the trigger rather than being a second thing to
        // get wrong: only a person can press Run, and only the clock can fire
        // a schedule.
        triggeredBy: trigger === "manual" ? "user" : "system",
        state,
        // One step until a workflow reports its own stages. Said rather than
        // left null, so the detail pane can draw a meter at all.
        stepIndex: 0,
        stepTotal: 1,
        // A queued run has not started; it gets its start time when it does.
        startedAt: state === "running" ? now : null,
      })
      .run();
    if (state === "queued") {
      t.insert(s.runQueue).values({ runId, args: args as Record<string, unknown>, guidance: guidance ?? null, queuedAt: now }).run();
    }
    t.update(s.workflows).set({ lastRunId: runId }).where(eq(s.workflows.id, workflow.id)).run();
  });
  return { runId, ordinal };
}

/** Hand an open, `running` row to the work. */
function launch(db: Db, runId: string, ordinal: number, { workflow, runnable, args, guidance }: Admitted): StartedRun {
  const controller = new AbortController();
  inFlight.set(runId, controller);

  return {
    runId,
    ordinal,
    settled: withoutTurn(() => withRunGuidance(guidance, () =>
      execute(db, runId, runnable, args, ordinal, controller.signal, workflow.id, guidance))),
  };
}

/** Validate, open a run, and start the work. */
export function startWorkflowRun(db: Db, slug: string, rawArgs: unknown, options: StartOptions = {}): StartedRun {
  const now = options.now ?? new Date();
  const trigger = options.trigger ?? "manual";
  const admitted = admit(db, slug, rawArgs, options);
  const { args, guidance } = admitted;
  const { runId, ordinal } = openRun(db, admitted, trigger, "running", now);

  write(db, runId, 0, "info", `Run ${ordinal} started ${options.source?.kind === "chat" ? "from chat" : trigger === "schedule" ? "by the schedule" : "by you"}.`, now);
  // Durable even for cancelled or crashed runs. Ordinary invocations retain
  // the existing arguments log contract.
  write(db, runId, 1, "debug", guidance || options.source
    ? `Invocation: ${safeJson({ args, guidance, source: options.source })}`
    : `Arguments: ${safeJson(args)}`, now);

  return launch(db, runId, ordinal, admitted);
}

/** What asking for a run produced: started now, or waiting out a hold. */
export type RequestedRun =
  | (StartedRun & { queued: false })
  | (QueuedRun & { queued: true });

/**
 * Start a run, or queue it while inference is on hold.
 *
 * The one entry point for a run a person asks for, from the Run button or
 * from chat: a hold means the Studio belongs to an eval, so new work waits
 * whoever starts it. Runs already going are left to finish.
 */
export function requestWorkflowRun(db: Db, slug: string, rawArgs: unknown, options: StartOptions = {}): RequestedRun {
  return inferenceHeld(db, options.now)
    ? { ...queueWorkflowRun(db, slug, rawArgs, { ...options, trigger: options.trigger ?? "manual" }), queued: true }
    : { ...startWorkflowRun(db, slug, rawArgs, options), queued: false };
}

export interface QueuedRun {
  runId: string;
  ordinal: number;
  /** True when an identical run was already waiting and this one was folded into it. */
  coalesced: boolean;
}

/**
 * Validate and open a run that waits for the inference hold to lift.
 *
 * Same checks as starting one, so a trigger that could never run is refused
 * now rather than when the queue drains. A run already waiting for the same
 * workflow with the same arguments absorbs the new one: an hourly rule over a
 * six-hour eval should catch up once, not six times back to back.
 */
export function queueWorkflowRun(
  db: Db,
  slug: string,
  rawArgs: unknown,
  options: Pick<StartOptions, "now" | "trigger" | "lookup" | "guidance" | "source"> = {},
): QueuedRun {
  const now = options.now ?? new Date();
  const trigger = options.trigger ?? "schedule";
  const admitted = admit(db, slug, rawArgs, options);

  const waiting = db
    .select({ runId: s.runQueue.runId, args: s.runQueue.args, guidance: s.runQueue.guidance, ordinal: s.workflowRuns.ordinal })
    .from(s.runQueue)
    .innerJoin(s.workflowRuns, eq(s.workflowRuns.id, s.runQueue.runId))
    .where(and(eq(s.workflowRuns.workflowId, admitted.workflow.id), eq(s.workflowRuns.state, "queued")))
    .all();
  const same = waiting.find((row) =>
    safeJson(row.args) === safeJson(admitted.args) && (row.guidance ?? undefined) === admitted.guidance);
  if (same) return { runId: same.runId, ordinal: same.ordinal, coalesced: true };

  const { runId, ordinal } = openRun(db, admitted, trigger, "queued", now);
  const by = options.source?.kind === "chat" ? "from chat" : trigger === "schedule" ? "by the schedule" : "by you";
  write(db, runId, 0, "info", `Run ${ordinal} queued ${by}: inference is on hold, so it waits for the hold to lift.`, now);
  write(db, runId, 1, "debug", admitted.guidance || options.source
    ? `Invocation: ${safeJson({ args: admitted.args, guidance: admitted.guidance, source: options.source })}`
    : `Arguments: ${safeJson(admitted.args)}`, now);
  return { runId, ordinal, coalesced: false };
}

/** The run that has waited longest, if any. */
export function nextQueuedRun(db: Db): string | undefined {
  const [next] = db
    .select({ runId: s.runQueue.runId })
    .from(s.runQueue)
    .orderBy(asc(s.runQueue.queuedAt), asc(s.runQueue.runId))
    .limit(1)
    .all();
  return next?.runId;
}

/**
 * Take a run off the queue and start it.
 *
 * Re-admitted rather than trusted: the workflow may have been paused, or its
 * code changed, while the run waited. A run that can no longer start is
 * written down as cancelled, with the reason, rather than vanishing.
 */
export function startQueuedRun(
  db: Db,
  runId: string,
  options: Pick<StartOptions, "now" | "lookup"> = {},
): StartedRun | undefined {
  const now = options.now ?? new Date();
  const [row] = db
    .select({
      args: s.runQueue.args,
      guidance: s.runQueue.guidance,
      queuedAt: s.runQueue.queuedAt,
      state: s.workflowRuns.state,
      ordinal: s.workflowRuns.ordinal,
      slug: s.workflows.slug,
    })
    .from(s.runQueue)
    .innerJoin(s.workflowRuns, eq(s.workflowRuns.id, s.runQueue.runId))
    .innerJoin(s.workflows, eq(s.workflows.id, s.workflowRuns.workflowId))
    .where(eq(s.runQueue.runId, runId))
    .limit(1)
    .all();
  if (!row) return undefined;
  db.delete(s.runQueue).where(eq(s.runQueue.runId, runId)).run();
  if (row.state !== "queued") return undefined;

  let admitted: Admitted;
  try {
    admitted = admit(db, row.slug, row.args, { ...options, ...(row.guidance ? { guidance: row.guidance } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.update(s.workflowRuns)
      .set({ state: "cancelled", endedAt: now, error: message })
      .where(eq(s.workflowRuns.id, runId))
      .run();
    write(db, runId, nextSeq(db, runId), "warn", `Run ${row.ordinal} left the queue without starting: ${message}`, now);
    return undefined;
  }

  db.update(s.workflowRuns)
    .set({ state: "running", startedAt: now, versionId: admitted.workflow.currentVersionId })
    .where(eq(s.workflowRuns.id, runId))
    .run();
  const waitedMin = Math.round((now.getTime() - row.queuedAt.getTime()) / 60_000);
  write(db, runId, nextSeq(db, runId), "info", `Run ${row.ordinal} started from the queue after waiting ${waitedMin} min.`, now);
  return launch(db, runId, row.ordinal, admitted);
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
  workflowId: string,
  guidance?: string,
): Promise<void> {
  // Everything the work says, at any depth, comes out carrying this run's id
  // without a single signature between here and there having to mention it.
  // That is what makes `run_id:"01J..."` in VictoriaLogs the whole story of a
  // run rather than the four sentences the runner wrote down about it.
  return withLogContext(
    { component: "workflow", run_id: runId, workflow: runnable.slug },
    // And every WRITE inside it, at any depth, through any agent, is governed
    // by this workflow's permissions — for the same reason and by the same
    // mechanism. Here rather than passed to each agent because the agents that
    // matter are module-level singletons built long before any run exists:
    // `okfManagerAgent` is constructed at import and is the one that writes
    // memory out of other people's messages. An option every factory had to
    // remember would be a hole exactly where a hole is least affordable.
    () => withRunPermissions(
      { db, workflowId, runId, slug: runnable.slug },
      () => run(db, runId, runnable, args, ordinal, signal, guidance),
    ),
  );
}

async function run(
  db: Db,
  runId: string,
  runnable: RunnableWorkflow,
  args: unknown,
  ordinal: number,
  signal: AbortSignal,
  guidance?: string,
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
        const result = await runnable.execute(args, { signal, db, ...(guidance ? { guidance } : {}) });
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

  write(db, runId, nextSeq(db, runId), "ok", `Run ${ordinal} finished in ${Math.round(durationMs / 1000)}s.`, endedAt);
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

  write(db, runId, nextSeq(db, runId), "error", `Run ${ordinal} halted: ${message}`, endedAt);
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
