// Cron worker: schedules the tasks declared in tasks.yaml. Runs as its own
// process (`bun run start:worker`), separate from the HTTP server — both are
// launched together by `bun start` (scripts/start-all.ts).
//
// Register the tracer provider before any task runs. (ESM hoists imports, so
// task/agent modules load first — fine, since spans are only created at call
// time and the tracer is resolved lazily.)
import { configureLogging } from "./core/logger";
configureLogging({ service: "solenoid-worker" });

import { initTracing, shutdownTracing } from "./core/tracing";
initTracing();

import { Cron } from "croner";
import { runTask, loadTasksConfig } from "./tasks";
import { validateSchedule } from "./tasks/validation";
import { flushLogs, log, shutdownLogging, withLogContext } from "./core/logger";
import { installShutdownHandler } from "./core/shutdown";

const scheduler = log.child("scheduler");

const config = await loadTasksConfig();
const enabled = config.tasks.filter((s) => s.enabled);
const disabled = config.tasks.length - enabled.length;

const errors = enabled.flatMap(validateSchedule);
if (errors.length > 0) {
  for (const e of errors) scheduler.error(`tasks.yaml: ${e}`, { file: "tasks.yaml" });
  await flushLogs();
  process.exit(1);
}

const jobs = enabled.map(
  (s) =>
    new Cron(
      s.cron,
      {
        name: s.name,
        timezone: s.timezone,
        // Skip a firing if the previous run is still in flight.
        protect: () =>
          scheduler.warn(`[${s.name}] previous run still in flight, skipping`, { schedule: s.name, task: s.task }),
        catch: (err) =>
          scheduler.error(`[${s.name}] run failed: ${err instanceof Error ? err.message : String(err)}`, {
            schedule: s.name,
            task: s.task,
          }),
      },
      // Every line a task logs — at any depth, through any tool — inherits the
      // schedule and the task name from here, which is what makes
      // `component:task task:weather` a useful thing to type in the UI.
      async () =>
        withLogContext({ component: "task", workflow: s.task }, async () => {
          scheduler.info(`[${s.name}] running task "${s.task}"`, { schedule: s.name, task: s.task });
          const res = await runTask(s.task, s.args);
          scheduler.ok(`[${s.name}] completed in ${res.durationMs}ms`, {
            schedule: s.name,
            task: s.task,
            duration_ms: res.durationMs,
          });
        }),
    ),
);

scheduler.info(`Worker scheduling ${jobs.length} task(s)${disabled ? ` (${disabled} disabled)` : ""}`, {
  scheduled: jobs.length,
  disabled,
});
for (const job of jobs) {
  scheduler.info(`  ${job.name}: next run ${job.nextRun()?.toISOString() ?? "never"}`, {
    schedule: job.name ?? "unnamed",
    next_run: job.nextRun()?.toISOString() ?? "never",
  });
}

installShutdownHandler(async () => {
  for (const job of jobs) job.stop();
  await shutdownTracing();
  await flushLogs();
  await shutdownLogging();
});
