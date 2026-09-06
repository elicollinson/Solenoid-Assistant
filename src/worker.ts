// The cron worker: runs what the DATABASE says to run, when it says to.
//
// Runs as its own process (`bun run start:worker`), separate from the HTTP
// server — both are launched together by `bun start` (scripts/start-all.ts).
//
// It used to read `tasks.yaml`, and that was the bug behind "I asked for a
// daily 3am run, the screen agreed, and nothing happened". There were two
// schedulers: `workflow_schedules`, which the Workflows screen drew, the
// calendar laid out and the agent could write — and which nothing executed —
// and this process, reading a file neither the screen nor the agent could see.
// Both halves worked exactly as built and the product did not.
//
// So the row is the schedule now. There is no second list, and a unit of work
// is a workflow whether a person starts it or a rule does.
//
// ## It re-reads
//
// A schedule changed while this is up takes effect within RELOAD_MS without a
// restart, which matters because the agent can change one mid-conversation and
// "you have to restart the worker" is not an answer you can give somebody who
// just asked for a 3am run. The reload is a diff: an unchanged database costs
// one query, and jobs are only torn down when the fingerprint moves.
import { configureLogging } from "./core/logger";
configureLogging({ service: "solenoid-worker" });

import { initTracing, shutdownTracing } from "./core/tracing";
initTracing();

import { Cron } from "croner";
import { getDb } from "./db";
import { flushLogs, log, shutdownLogging, withLogContext } from "./core/logger";
import { installShutdownHandler } from "./core/shutdown";
import { hasRunInFlight, startWorkflowRun } from "./workflows/runner";
import {
  noteFiring,
  noteNextRuns,
  readSchedules,
  scheduleFingerprint,
  type DueSchedule,
} from "./workflows/schedule";

const scheduler = log.child("scheduler");

/** How often to notice that a schedule changed. */
const RELOAD_MS = 30_000;

const db = getDb();
let jobs: Cron[] = [];
let fingerprint = "";

/**
 * Build one croner job from one row.
 *
 * The jitter is applied inside the firing rather than to the rule, because it
 * is a spread and not an offset: several rules landing on 03:00 should not all
 * open a model connection in the same second, and each firing wants its own
 * delay rather than the whole schedule moving.
 */
function schedule(entry: DueSchedule): Cron {
  return new Cron(
    entry.cron,
    {
      name: entry.slug,
      timezone: entry.tz,
      // croner's own guard, which only covers the handler below — the run it
      // starts outlives that. `hasRunInFlight` is the real one.
      protect: true,
      catch: (err: unknown) =>
        scheduler.error(
          `[${entry.slug}] could not start: ${err instanceof Error ? err.message : String(err)}`,
          { workflow: entry.slug },
        ),
    },
    async (self: Cron) => {
      if (entry.jitterSecs > 0) {
        await Bun.sleep(Math.floor(Math.random() * entry.jitterSecs * 1000));
      }
      // Every line the run logs — at any depth, through any tool — inherits the
      // workflow from here, which is what makes `workflow:message-extraction` a
      // useful thing to type into the Logs tab.
      await withLogContext({ component: "task", workflow: entry.slug }, async () => {
        // The run row is the guard, not the handler. `startWorkflowRun` opens
        // a row and returns; the work continues under its own span, so croner
        // sees this firing finish in milliseconds and would happily start
        // another on top of a job still going.
        if (hasRunInFlight(db, entry.slug)) {
          scheduler.warn(`[${entry.slug}] previous run still going, skipping this firing`, {
            workflow: entry.slug,
          });
          return;
        }
        const started = new Date();
        const run = startWorkflowRun(db, entry.slug, entry.args, { trigger: "schedule" });
        noteFiring(db, entry.scheduleId, started, self.nextRun());
        scheduler.info(`[${entry.slug}] started run ${run.ordinal}`, {
          workflow: entry.slug,
          run_id: run.runId,
        });
      });
    },
  );
}

/** Tear down what is running and build what the database now says. */
function reload(first: boolean): void {
  const reading = readSchedules(db);
  const next = scheduleFingerprint(reading);
  if (!first && next === fingerprint) return;
  fingerprint = next;

  for (const job of jobs) job.stop();
  jobs = reading.due.map(schedule);

  scheduler.info(
    `${first ? "Worker scheduling" : "Schedule changed —"} ${jobs.length} workflow(s) from the database`,
    { scheduled: jobs.length, unusable: reading.unusable.length },
  );
  for (const job of jobs) {
    scheduler.info(`  ${job.name}: next run ${job.nextRun()?.toISOString() ?? "never"}`, {
      workflow: job.name ?? "unnamed",
      next_run: job.nextRun()?.toISOString() ?? "never",
    });
  }
  // Said out loud, every time. A schedule that exists and cannot run is the
  // exact failure this file was rewritten to end, and it must never again be
  // possible for one to sit in the database saying "Daily, 03:00" while
  // nothing anywhere reports that it will not happen.
  for (const { slug, reason } of reading.unusable) {
    scheduler.warn(`  ${slug}: scheduled but will not run — ${reason}`, { workflow: slug });
  }

  // The home screen's "NEXT UP" reads `nextRunAt`, and this process is the only
  // one that can know it.
  //
  // Both halves are written. The rules that WILL fire get their real next time;
  // the ones that cannot are cleared to null, because a schedule that will
  // never run must not sit in "NEXT UP" promising a time — and five of them
  // were, with times in the past, left over from the seed.
  noteNextRuns(
    db,
    new Map([
      ...reading.due.map((entry, index): [string, Date | null] => [
        entry.scheduleId,
        jobs[index]?.nextRun() ?? null,
      ]),
      ...reading.unusable.map((entry): [string, Date | null] => [entry.scheduleId, null]),
    ]),
  );
}

reload(true);
const poll = setInterval(() => {
  try {
    reload(false);
  } catch (error) {
    // A bad read must not kill the worker: the jobs already built keep firing,
    // and the next tick tries again.
    scheduler.error(`could not re-read schedules: ${error instanceof Error ? error.message : String(error)}`);
  }
}, RELOAD_MS);

installShutdownHandler(async () => {
  clearInterval(poll);
  for (const job of jobs) job.stop();
  await shutdownTracing();
  await flushLogs();
  await shutdownLogging();
});
