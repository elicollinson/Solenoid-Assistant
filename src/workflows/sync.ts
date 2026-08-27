// Put the catalog on the Workflows surface.
//
// The database is where the UI reads its list from, so a workflow that exists
// only in code is invisible. This walks the catalog and makes the `workflows`
// table agree with it: one row per entry, matched on slug, plus the version and
// schedule rows the queries join through.
//
// Idempotent and additive. It never deletes — the design's fixtures share this
// table and the feed, calendar and reminders all point at them, so clearing
// what this does not own would take four other screens down with it. Runs are
// left alone for the same reason: they are the history of the thing.
//
// Called from src/server.ts on boot, which also means `bun run db:seed` — whose
// clear() takes every non-OKF entity with it — costs nothing but a restart.
import { eq } from "drizzle-orm";
import { ulid, type Db } from "../db";
import * as s from "../db/schema";
import { WORKFLOW_CATALOG } from "./catalog";

export interface SyncResult {
  added: number;
  updated: number;
}

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
 * The schedule row is what makes the table say "Daily, 07:00" rather than
 * "Unscheduled", and what the Scheduled filter counts. `nextRunAt` stays null:
 * the cron worker owns firing, and a second answer about when this next runs
 * would only be wrong.
 */
function upsertSchedule(t: Tx, workflowId: string, rrule: string | null, label: string): void {
  const [existing] = t
    .select()
    .from(s.workflowSchedules)
    .where(eq(s.workflowSchedules.workflowId, workflowId))
    .limit(1)
    .all();

  if (!rrule) {
    if (existing) t.delete(s.workflowSchedules).where(eq(s.workflowSchedules.id, existing.id)).run();
    return;
  }

  if (existing) {
    if (existing.rrule !== rrule || existing.label !== label) {
      t.update(s.workflowSchedules)
        .set({ rrule, label })
        .where(eq(s.workflowSchedules.id, existing.id))
        .run();
    }
    return;
  }

  t.insert(s.workflowSchedules)
    .values({ id: ulid(), workflowId, rrule, label, enabled: true })
    .run();
}

/** Every slug the catalog owns, for a caller that wants to log what it wrote. */
export const CATALOGUED_SLUGS = WORKFLOW_CATALOG.map((entry) => entry.slug);
