// Take the workflows with no code behind them out of the database.
//
// The Workflows table has carried two kinds of row: the ones in
// src/workflows/catalog.ts, which this service can actually run, and the
// design's demonstrations, which have runs and prose on the record and nothing
// behind them. The second kind was useful while the surface was being built
// against a design and is a lie once the surface is real — a workflow you
// cannot start is not a workflow.
//
// This is destructive and deliberately not called on boot. `scripts/db-prune.ts`
// runs it; `bun run db:seed` writes the demonstrations back, which is what that
// command is for.
//
// Deletion goes through `entities` rather than through `workflows`. Every
// citable row is an entity first, and `entityId()` cascades from it — so
// removing the entity takes the workflow, its versions, schedules,
// instructions, permissions, runs, steps, logs and effects with it in one
// statement. Deleting the `workflows` row instead would cascade to the runs but
// strand every one of their `entities` rows.
import { and, eq, inArray, isNotNull, notInArray, or } from "drizzle-orm";
import type { Db } from "../index";
import * as s from "../schema";
import { CATALOGUED_SLUGS } from "../../workflows/sync";

export interface PruneResult {
  /** The slugs that were removed, in the order they were found. */
  removed: string[];
  /** How many runs went with them. */
  runs: number;
  /** Feed entries that were accounts of those runs. */
  activity: number;
  /** Blocks on the calendar that were those workflows firing. */
  calendar: number;
  /** Suggestions scoped to one of them. Kept, not deleted — they now stand
   *  unscoped. See the note in `pruneUncataloguedWorkflows`. */
  unscopedSuggestions: number;
}

/**
 * Remove every workflow this codebase cannot run, and the record of it running.
 *
 * The line is drawn at what a row is *about*. A feed entry saying "Q3 vendor
 * reconciliation is running, step 6 of 11" is an account of a run; delete the
 * run and the account is not merely stale but false, and the "Open workflow"
 * button under it leads to a 404. The same goes for a block on the calendar
 * that is a workflow firing. Both go.
 *
 * A reminder, a suggestion or a memory is not about a run — it merely mentions
 * one. Those columns are `on delete set null` by design, and the rows stand on
 * their own once the thing they point at is gone: "tell Ferris whether the
 * credit note stands" is still a thing to do. Those are kept, and counted so
 * the caller can see what lost a link.
 */
export function pruneUncataloguedWorkflows(db: Db): PruneResult {
  const keep = [...CATALOGUED_SLUGS];

  return db.transaction((t) => {
    const doomed = t
      .select({ id: s.workflows.id, slug: s.workflows.slug })
      .from(s.workflows)
      .where(notInArray(s.workflows.slug, keep))
      .all();

    if (doomed.length === 0) {
      return { removed: [], runs: 0, activity: 0, calendar: 0, unscopedSuggestions: 0 };
    }

    const workflowIds = doomed.map((w) => w.id);
    const runIds = t
      .select({ id: s.workflowRuns.id })
      .from(s.workflowRuns)
      .where(inArray(s.workflowRuns.workflowId, workflowIds))
      .all()
      .map((r) => r.id);
    const stepIds = runIds.length
      ? t.select({ id: s.runSteps.id }).from(s.runSteps).where(inArray(s.runSteps.runId, runIds)).all().map((r) => r.id)
      : [];

    // An entry about one of these workflows, or about one of their runs — the
    // design's feed sets both columns, but a row with only the run is still an
    // account of it.
    const activityIds = t
      .select({ id: s.activityItems.id })
      .from(s.activityItems)
      .where(
        or(
          inArray(s.activityItems.workflowId, workflowIds),
          runIds.length ? inArray(s.activityItems.runId, runIds) : undefined,
        ),
      )
      .all()
      .map((r) => r.id);

    // Only the blocks that *are* one of these workflows running. A commitment
    // of yours that happens to name one keeps its place in the week.
    const calendarIds = t
      .select({ id: s.calendarItems.id })
      .from(s.calendarItems)
      .where(and(inArray(s.calendarItems.workflowId, workflowIds), eq(s.calendarItems.kind, "run")))
      .all()
      .map((r) => r.id);

    // A reminder names a workflow through `links`, whose ends cascade — those
    // edges go with it and leave nothing dangling. A suggestion carries the id
    // in a column that nulls, so it survives as a suggestion about nothing in
    // particular, which is what it always was underneath.
    const unscopedSuggestions = count(t, s.recommendations, s.recommendations.scopeWorkflowId, workflowIds);

    // Deepest first. Cascade reaches a workflow's own rows from the top, but a
    // run's `entities` row is not among them — nothing points from a workflow
    // to it — so each generation is deleted by its own ids.
    for (const ids of [stepIds, runIds, activityIds, calendarIds, workflowIds]) {
      if (ids.length) t.delete(s.entities).where(inArray(s.entities.id, ids)).run();
    }

    // The night's opening line counted the entries that just went. Written
    // copy, not a tally, so nothing recomputes it — and "I handled nine things
    // overnight" above an empty feed is the sort of sentence that makes a
    // person stop believing the rest of the screen.
    if (activityIds.length) {
      const left = t.select({ id: s.activityItems.id }).from(s.activityItems).all().length;
      if (left === 0) {
        t.delete(s.surfaceNotes)
          .where(and(eq(s.surfaceNotes.screen, "home"), eq(s.surfaceNotes.slot, "line"), isNotNull(s.surfaceNotes.onDate)))
          .run();
      }
    }

    return {
      removed: doomed.map((w) => w.slug),
      runs: runIds.length,
      activity: activityIds.length,
      calendar: calendarIds.length,
      unscopedSuggestions,
    };
  });
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** How many rows on another surface point at one of these, and will stop. */
function count(t: Tx, table: typeof s.recommendations, column: Parameters<typeof inArray>[0], ids: string[]): number {
  if (ids.length === 0) return 0;
  return t.select({ id: table.id }).from(table).where(inArray(column, ids)).all().length;
}

/** Whether anything here would be removed, for a caller that wants to ask first. */
export function uncataloguedWorkflows(db: Db): string[] {
  return db
    .select({ slug: s.workflows.slug })
    .from(s.workflows)
    .where(notInArray(s.workflows.slug, [...CATALOGUED_SLUGS]))
    .all()
    .map((w) => w.slug);
}

/** One workflow by slug, for a caller pruning a single row rather than the lot. */
export function removeWorkflow(db: Db, slug: string): boolean {
  const [workflow] = db.select({ id: s.workflows.id }).from(s.workflows).where(eq(s.workflows.slug, slug)).limit(1).all();
  if (!workflow) return false;
  db.delete(s.entities).where(eq(s.entities.id, workflow.id)).run();
  return true;
}
