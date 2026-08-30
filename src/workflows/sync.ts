// Put the catalog on the Workflows surface.
//
// The database is where the UI reads its list from, so a workflow that exists
// only in code is invisible. This walks the catalog and makes the `workflows`
// table agree with it: one row per entry, matched on slug, plus the version and
// schedule rows the queries join through.
//
// ## It does not run on boot, and it must not
//
// It used to, and that made the database a cache of this file. An agent asked
// for a 3am daily run wrote `FREQ=DAILY;BYHOUR=3` into `workflow_schedules`,
// the screen drew it, and the next restart deleted the row outright — because
// this entry says `rrule: null` and the old `upsertSchedule` read null as
// "there should be no schedule" rather than "the catalog has no opinion".
// Nobody would have seen it go.
//
// A record that a restart can rewrite is not a record. So the catalog SEEDS —
// `bun run db:sync-workflows`, deliberately, by a person — and after that the
// row is the truth and this file has no further opinion about it. What boot
// does now is look and tell you (`describeDrift`), which is a report and not a
// write.
//
// Additive, and it never deletes: the design's fixtures share this table and
// the feed, calendar and reminders all point at them.
import { eq } from "drizzle-orm";
import { ulid, type Db } from "../db";
import * as s from "../db/schema";
import { WORKFLOW_CATALOG } from "./catalog";

export interface SyncResult {
  added: number;
  updated: number;
}

/**
 * Write the catalog into the database. Run by a person, never on boot.
 *
 * Existing rows keep their name and trigger in step with the catalog, because
 * those are descriptions of the code. Their SCHEDULE is left exactly as it is,
 * because that is somebody's decision — see `upsertSchedule`.
 */
export function syncWorkflowCatalog(db: Db, now: Date = new Date()): SyncResult {
  return db.transaction((t) => {
    let added = 0;
    let updated = 0;

    for (const entry of WORKFLOW_CATALOG) {
      const [existing] = t.select().from(s.workflows).where(eq(s.workflows.slug, entry.slug)).limit(1).all();

      if (existing) {
        // The name and the trigger are the catalog's to change; `pausedAt` and
        // `lastRunId` are the product's, and are not touched.
        if (existing.name !== entry.name || existing.triggerKind !== entry.trigger) {
          t.update(s.workflows)
            .set({ name: entry.name, triggerKind: entry.trigger })
            .where(eq(s.workflows.id, existing.id))
            .run();
          updated += 1;
        }
        upsertSchedule(t, existing.id, entry.rrule, entry.cadence);
        continue;
      }

      const id = ulid(now.getTime());
      t.insert(s.entities).values({ id, kind: "workflow", createdAt: now, updatedAt: now }).run();
      t.insert(s.workflows)
        .values({
          id,
          slug: entry.slug,
          name: entry.name,
          triggerKind: entry.trigger,
          enabled: true,
          createdAt: now,
        })
        .run();

      const versionId = ulid(now.getTime());
      t.insert(s.workflowVersions)
        .values({
          id: versionId,
          workflowId: id,
          version: 1,
          // The step shape lifts out of here when the editor exists. For now
          // the cadence label is the only thing config carries.
          config: { cadence: entry.cadence },
          createdAt: now,
          createdBy: "system",
        })
        .run();
      t.update(s.workflows).set({ currentVersionId: versionId }).where(eq(s.workflows.id, id)).run();

      upsertSchedule(t, id, entry.rrule, entry.cadence);
      added += 1;
    }

    return { added, updated };
  });
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Give a workflow the schedule the catalog suggests — ONCE, and only if it has
 * none.
 *
 * Seed, not synchronise. An existing row is left completely alone, including
 * when the catalog disagrees with it, because the catalog is a starting point
 * and the row is a decision: somebody moved that job to 3am, through the
 * screen or by asking the agent, and this file does not get to overrule them
 * on the next restart.
 *
 * `rrule: null` in the catalog now means "this ships unscheduled", not "this
 * must never have a schedule". It used to delete, which is how an agent-written
 * 3am rule vanished on a boot with nothing logged.
 *
 * `nextRunAt` stays null: the cron worker owns firing and fills it in from the
 * rule it actually built.
 */
function upsertSchedule(t: Tx, workflowId: string, rrule: string | null, label: string): void {
  const [existing] = t
    .select({ id: s.workflowSchedules.id })
    .from(s.workflowSchedules)
    .where(eq(s.workflowSchedules.workflowId, workflowId))
    .limit(1)
    .all();

  if (existing || !rrule) return;

  t.insert(s.workflowSchedules)
    .values({ id: ulid(), workflowId, rrule, label, enabled: true })
    .run();
}

/** Every slug the catalog owns, for a caller that wants to log what it wrote. */
export const CATALOGUED_SLUGS = WORKFLOW_CATALOG.map((entry) => entry.slug);

/** What the catalog and the database disagree about. Nothing is written. */
export interface Drift {
  /** In the catalog, absent from the database. Run the sync script. */
  unseeded: string[];
  /** In the database with a schedule, but no code behind the slug. */
  unrunnable: string[];
}

/**
 * Look, and say what you see.
 *
 * This is what boot does now instead of writing. The two things worth knowing
 * are both silent failures otherwise: a workflow nobody has seeded cannot be
 * run or scheduled and does not appear on the screen to explain why, and a
 * schedule pointing at a slug with no code sits there saying "Daily, 03:00"
 * and never fires.
 *
 * `isRunnable` is passed in rather than imported so this stays as import-light
 * as ./catalog.ts — a caller that only wants the first half should not have to
 * load every workflow implementation to get it.
 */
export function describeDrift(db: Db, isRunnable: (slug: string) => boolean): Drift {
  const known = new Set(db.select({ slug: s.workflows.slug }).from(s.workflows).all().map((row) => row.slug));

  const scheduled = db
    .select({ slug: s.workflows.slug })
    .from(s.workflowSchedules)
    .innerJoin(s.workflows, eq(s.workflows.id, s.workflowSchedules.workflowId))
    .where(eq(s.workflowSchedules.enabled, true))
    .all()
    .map((row) => row.slug);

  return {
    unseeded: WORKFLOW_CATALOG.filter((entry) => !known.has(entry.slug)).map((entry) => entry.slug),
    unrunnable: scheduled.filter((slug) => !isRunnable(slug)),
  };
}
