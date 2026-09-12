import { Elysia, t } from "elysia";
import { isSurface, type Surface } from "../../shared/surface";
import { getDb, type Db } from "../../db";
import { loadCalendar, loadCalendarItem } from "../../db/queries/calendar";
import { loadHome } from "../../db/queries/home";
import { loadKnowledge, loadKnowledgeObject } from "../../db/queries/knowledge";
import { loadRecommendation, loadRecommendations } from "../../db/queries/recommendations";
import { loadReminder, loadReminders } from "../../db/queries/reminders";
import { loadWorkflow, loadWorkflows } from "../../db/queries/workflows";
import {
  NoSuchWorkflowDecisionError,
  NoSuchWorkflowError,
  grantWorkflowPermission,
  readDeferredWrite,
  settleDeferredWrite,
  setWorkflowInstructions,
  setWorkflowPaused,
} from "../../db/mutations/workflows";
import { autoSettleWorkflowWrites, runDeferredWrite } from "../../workflows/deferred";
import {
  NoSuchRecommendationError,
  RecommendationSettledError,
  answerRecommendation,
} from "../../db/mutations/recommendations";
import { WorkflowArgsError } from "../../workflows/registry";
import {
  NotRunnableError,
  NotRunningError,
  UnknownWorkflowError,
  startWorkflowRun,
  stopCurrentRun,
} from "../../workflows/runner";

/**
 * The web app's own routes. Everything here answers "what does this screen
 * draw", so there is one route per surface rather than one per table — the home
 * screen would otherwise be six round trips before it can render anything.
 *
 * The reads are one per surface; the writes are the four things the Workflows
 * detail pane can change — start a run, stop it, pause the workflow, and
 * rewrite its standing instruction.
 *
 * Starting answers 202 and the id of a run that is already under way rather
 * than holding the request open: a screenshot sweep outlives any sensible
 * timeout, and the screen it came from is already reading run state on a timer.
 * The other three answer with what they set and leave the caller to re-read,
 * because that same timer is about to ask anyway.
 *
 * The database is injected so a test can point the routes at a temporary file
 * instead of the real one.
 */
/**
 * The deferred writes being made right now, by decision id.
 *
 * A double click is two requests, and both read the same open decision before
 * either has settled it — so the row is not enough on its own and this is the
 * thing that actually stops the tool running twice. Module-level for the same
 * reason `inFlight` is in ../../workflows/runner.ts: what is in flight is a
 * property of the process, not of a request or of the database.
 */
const answering = new Set<string>();

export function createUiRoutes(
  resolveDb: () => Db = getDb,
  refreshKnowledge: (db: Db) => Promise<unknown> = async () => {},
) {
  /**
   * Which frame is asking.
   *
   * Optional, because the desktop is the frame the design starts from and a
   * client that says nothing means that one. Named rather than free — asking as
   * something that is not a surface is refused rather than quietly answered as
   * the desktop, so a typo in a client shows up as a 422 here instead of as
   * long sentences on a small screen.
   *
   * `isSurface` still guards the read: the validator and the loader should not
   * have to be trusted to agree about what the two names are.
   */
  const asked = (query: { surface?: string }): Surface => (isSurface(query.surface) ? query.surface : "desktop");
  const surface = t.Object({ surface: t.Optional(t.Union([t.Literal("desktop"), t.Literal("phone")])) });

  return new Elysia({ name: "routes.ui" })
    .get("/api/home", ({ query }) => loadHome(resolveDb(), new Date(), asked(query)), {
      query: surface,
      detail: { summary: "Everything the home surface draws: header, rail, feed, aside" },
    })
    .get("/api/workflows", ({ query }) => loadWorkflows(resolveDb(), new Date(), asked(query)), {
      query: surface,
      detail: { summary: "The workflow table: state, cadence, last run and step for each" },
    })
    .get(
      "/api/workflows/:slug",
      ({ params, query, set }) => {
        const detail = loadWorkflow(resolveDb(), params.slug, new Date(), asked(query));
        if (!detail) {
          set.status = 404;
          return { error: `No workflow called ${params.slug}` };
        }
        return detail;
      },
      {
        params: t.Object({ slug: t.String() }),
        query: surface,
        detail: { summary: "One workflow: summary, executions, trace and logs" },
      },
    )
    .post(
      "/api/workflows/:slug/run",
      ({ params, body, set }) => {
        try {
          const started = startWorkflowRun(resolveDb(), params.slug, body?.args ?? {});
          set.status = 202;
          return { runId: started.runId, ordinal: started.ordinal, label: `Run ${started.ordinal}` };
        } catch (error) {
          // Four refusals, and each one is a different thing to say on screen:
          // no such workflow, nothing behind it, you paused it, or the
          // arguments are wrong. A 502 would collapse all four into "it broke".
          if (error instanceof UnknownWorkflowError) {
            set.status = 404;
            return { error: error.message };
          }
          if (error instanceof NotRunnableError) {
            set.status = 409;
            return { error: error.message };
          }
          if (error instanceof WorkflowArgsError) {
            set.status = 400;
            return { error: error.message };
          }
          set.status = 500;
          return { error: error instanceof Error ? error.message : "Could not start the run" };
        }
      },
      {
        params: t.Object({ slug: t.String() }),
        body: t.Optional(t.Object({ args: t.Optional(t.Record(t.String(), t.Unknown())) })),
        detail: { summary: "Start a run of one workflow and answer with the run it opened" },
        response: {
          202: t.Object({ runId: t.String(), ordinal: t.Number(), label: t.String() }),
          400: t.Object({ error: t.String() }),
          404: t.Object({ error: t.String() }),
          409: t.Object({ error: t.String() }),
          500: t.Object({ error: t.String() }),
        },
      },
    )
    .post(
      "/api/workflows/:slug/stop",
      ({ params, set }) => {
        try {
          return { runId: stopCurrentRun(resolveDb(), params.slug) };
        } catch (error) {
          if (error instanceof UnknownWorkflowError) {
            set.status = 404;
            return { error: error.message };
          }
          if (error instanceof NotRunningError) {
            set.status = 409;
            return { error: `Nothing to stop — ${params.slug} isn't running.` };
          }
          set.status = 500;
          return { error: error instanceof Error ? error.message : "Could not stop the run" };
        }
      },
      {
        params: t.Object({ slug: t.String() }),
        detail: { summary: "Stop the run this workflow has going, and stop recording what it returns" },
        response: {
          200: t.Object({ runId: t.String() }),
          404: t.Object({ error: t.String() }),
          409: t.Object({ error: t.String() }),
          500: t.Object({ error: t.String() }),
        },
      },
    )
    .post(
      "/api/workflows/:slug/pause",
      ({ params, body, set }) => {
        try {
          setWorkflowPaused(resolveDb(), params.slug, body.paused);
          return { paused: body.paused };
        } catch (error) {
          if (error instanceof NoSuchWorkflowError) {
            set.status = 404;
            return { error: error.message };
          }
          set.status = 500;
          return { error: error instanceof Error ? error.message : "Could not change it" };
        }
      },
      {
        params: t.Object({ slug: t.String() }),
        body: t.Object({ paused: t.Boolean() }),
        detail: { summary: "Pause or resume a workflow, so the schedule and the Run button both honour it" },
        response: {
          200: t.Object({ paused: t.Boolean() }),
          404: t.Object({ error: t.String() }),
          500: t.Object({ error: t.String() }),
        },
      },
    )
    .put(
      "/api/workflows/:slug/instructions",
      ({ params, body, set }) => {
        try {
          setWorkflowInstructions(resolveDb(), params.slug, body.text);
          return { text: body.text.trim() || null };
        } catch (error) {
          if (error instanceof NoSuchWorkflowError) {
            set.status = 404;
            return { error: error.message };
          }
          set.status = 500;
          return { error: error instanceof Error ? error.message : "Could not save it" };
        }
      },
      {
        params: t.Object({ slug: t.String() }),
        // Capped where a standing rule stops being one. The column is untyped
        // text; the limit is about what a person will read back later.
        body: t.Object({ text: t.String({ maxLength: 2000 }) }),
        detail: { summary: "Replace the standing instruction, retiring the one it supersedes" },
        response: {
          200: t.Object({ text: t.Union([t.String(), t.Null()]) }),
          404: t.Object({ error: t.String() }),
          500: t.Object({ error: t.String() }),
        },
      },
    )
    .put(
      "/api/workflows/:slug/permissions",
      async ({ params, body, set }) => {
        try {
          const db = resolveDb();
          grantWorkflowPermission(db, params.slug, {
            capability: body.capability,
            mode: body.mode,
            by: "user",
          });
          if (body.mode === "allow") {
            await autoSettleWorkflowWrites(db, params.slug, body.capability);
          }
          return { ok: true };
        } catch (error) {
          if (error instanceof NoSuchWorkflowError) {
            set.status = 404;
            return { error: error.message };
          }
          set.status = 500;
          return { error: error instanceof Error ? error.message : "Could not save permission" };
        }
      },
      {
        params: t.Object({ slug: t.String() }),
        body: t.Object({
          capability: t.String({ minLength: 1 }),
          mode: t.Union([t.Literal("allow"), t.Literal("ask"), t.Literal("deny")]),
        }),
        detail: { summary: "Set or update the permission mode for a workflow capability" },
        response: {
          200: t.Object({ ok: t.Boolean() }),
          404: t.Object({ error: t.String() }),
          500: t.Object({ error: t.String() }),
        },
      },
    )
    .get("/api/reminders", () => loadReminders(resolveDb()), {
      detail: { summary: "Everything I'm holding for you, bucketed by when it is due" },
    })
    .get(
      "/api/reminders/:id",
      ({ params, set }) => {
        const detail = loadReminder(resolveDb(), params.id);
        if (!detail) {
          set.status = 404;
          return { error: `No reminder with id ${params.id}` };
        }
        return detail;
      },
      {
        params: t.Object({ id: t.String() }),
        detail: { summary: "One reminder: why I set it, what it came from, and what has happened since" },
      },
    )
    .get("/api/recommendations", () => loadRecommendations(resolveDb()), {
      detail: { summary: "Standing suggestions, shelved by whether you have answered them" },
    })
    .get(
      "/api/recommendations/:id",
      ({ params, set }) => {
        const detail = loadRecommendation(resolveDb(), params.id);
        if (!detail) {
          set.status = 404;
          return { error: `No recommendation with id ${params.id}` };
        }
        return detail;
      },
      {
        params: t.Object({ id: t.String() }),
        detail: { summary: "One suggestion: what I noticed, what would change, and what I formed it from" },
      },
    )
    .post(
      "/api/workflows/decisions",
      async ({ body, set }) => {
        const db = resolveDb();
        const call = readDeferredWrite(db, body.actionId);
        if (!call) {
          set.status = 404;
          return { error: `No deferred write is waiting on action ${body.actionId}` };
        }
        // Answered already — in another tab, or by this one a moment ago. The
        // call runs before the outcome is recorded, so without this a replayed
        // actionId is a SECOND real write, and the 409 arrives from the settle
        // afterwards, too late to have prevented anything.
        if (!call.open) {
          set.status = 409;
          return { error: `That write has already been answered. Re-read; the feed says what was chosen.` };
        }
        // And the same question asked twice at once, which the row above cannot
        // see: both requests read `open` before either settles. One claim per
        // decision, held across the call, released whatever happens — the same
        // shape `inFlight` takes in ../../workflows/runner.ts, and for the same
        // reason. In-process because this route lives in one process; the row
        // check above is what survives a restart.
        if (answering.has(call.decisionId)) {
          set.status = 409;
          return { error: "That write is being made right now. Re-read in a moment for what it did." };
        }
        answering.add(call.decisionId);

        try {
          // "Leave it" settles without running anything. Nothing was written
          // when the run wanted to, and nothing is written now.
          if (!call.approves) {
            settleDeferredWrite(db, {
              decisionId: call.decisionId,
              actionId: body.actionId,
              ran: false,
              outcome: "You left it. Nothing was written.",
            });
            return { ran: false, outcome: "You left it. Nothing was written." };
          }

          // The call FIRST, its outcome second. A crash between the two leaves
          // a question still open over a write that happened, which you can
          // read and act on — where the reverse leaves the record claiming a
          // write that never did.
          const result = await runDeferredWrite(
            db,
            { runId: call.runId, tool: call.tool, args: call.args, requestId: body.actionId },
            // Just the handle, as ../routes/chat.ts builds its agent. The OKF
            // group falls back to the bundle this module ships beside, which
            // is the same one the run that deferred this was writing to.
            { db },
          );
          settleDeferredWrite(db, {
            decisionId: call.decisionId,
            actionId: body.actionId,
            ran: result.ran,
            outcome: result.summary,
            detail: result.detail ?? null,
            tool: call.tool,
            args: call.args,
            durationMs: result.durationMs,
            failed: !result.ran,
          });
          return { ran: result.ran, outcome: result.summary };
        } catch (error) {
          if (error instanceof NoSuchWorkflowDecisionError) {
            // Answered between the check above and the settle below. Not a
            // failure on this end: re-read and the feed says what was chosen.
            set.status = 409;
            return { error: error.message };
          }
          throw error;
        } finally {
          answering.delete(call.decisionId);
        }
      },
      {
        body: t.Object({
          actionId: t.String({
            minLength: 1,
            description:
              "The id of the button that was pressed. Never a boolean and never the tool name: " +
              "a client that could post its own call could run something nobody deferred.",
          }),
        }),
        detail: {
          summary:
            "Answer a write a workflow deferred, running it if you say so. The rule is checked " +
            "again first, so a capability narrowed since it was asked is refused now.",
        },
        response: {
          200: t.Object({ ran: t.Boolean(), outcome: t.String() }),
          404: t.Object({ error: t.String() }),
          409: t.Object({ error: t.String() }),
        },
      },
    )
    .post(
      "/api/recommendations/:id/answer",
      ({ params, body, set }) => {
        try {
          answerRecommendation(resolveDb(), params.id, body.stance, { by: "user" });
          return { status: body.stance };
        } catch (error) {
          if (error instanceof NoSuchRecommendationError) {
            set.status = 404;
            return { error: error.message };
          }
          // Already answered — by you in another tab, or withdrawn by me while
          // this page was open. A 409 rather than a 500: the request was fine,
          // the question is simply not open any more, and the next read says so.
          if (error instanceof RecommendationSettledError) {
            set.status = 409;
            return { error: error.message };
          }
          set.status = 500;
          return { error: error instanceof Error ? error.message : "Could not write it down" };
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({ stance: t.Union([t.Literal("adopted"), t.Literal("declined")]) }),
        detail: { summary: "Adopt or decline a suggestion, closing the question behind it" },
        response: {
          200: t.Object({ status: t.String() }),
          404: t.Object({ error: t.String() }),
          409: t.Object({ error: t.String() }),
          500: t.Object({ error: t.String() }),
        },
      },
    )
    .get("/api/calendar", ({ query }) => loadCalendar(resolveDb(), new Date(), asked(query)), {
      query: surface,
      detail: { summary: "The week: your commitments, my runs, the reminders due and the slots I am holding" },
    })
    .get(
      "/api/calendar/:id",
      ({ params, set }) => {
        const detail = loadCalendarItem(resolveDb(), params.id);
        if (!detail) {
          set.status = 404;
          return { error: `Nothing on the calendar with id ${params.id}` };
        }
        return detail;
      },
      {
        params: t.Object({ id: t.String() }),
        detail: { summary: "One thing on the canvas: why it is there, and the way through to whatever it projects" },
      },
    )
    .get("/api/knowledge", async ({ query }) => {
      const db = resolveDb();
      await refreshKnowledge(db);
      return loadKnowledge(db, new Date(), asked(query));
    }, {
      query: surface,
      detail: { summary: "The OKF store: every memory I hold, grouped by what it is about" },
    })
    .get(
      "/api/knowledge/:id",
      async ({ params, set }) => {
        const db = resolveDb();
        await refreshKnowledge(db);
        const detail = loadKnowledgeObject(db, params.id);
        if (!detail) {
          set.status = 404;
          return { error: `No memory with id ${params.id}` };
        }
        return detail;
      },
      {
        params: t.Object({ id: t.String() }),
        detail: { summary: "One memory: how it came to be, the facts in it, and what links to it" },
      },
    );
}
