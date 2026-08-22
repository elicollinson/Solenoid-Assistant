// Cron worker: schedules the tasks declared in tasks.yaml. Runs as its own
// process (`bun run start:worker`), separate from the HTTP server — both are
// launched together by `bun start` (scripts/start-all.ts).
//
// Register the tracer provider before any task runs. (ESM hoists imports, so
// task/agent modules load first — fine, since spans are only created at call
// time and the tracer is resolved lazily.)
import { initTracing, shutdownTracing } from "./core/tracing";
initTracing();

import { Cron } from "croner";
import { runTask, loadTasksConfig } from "./tasks";
import { validateSchedule } from "./tasks/validation";
import { log } from "./core/logger";
import { installShutdownHandler } from "./core/shutdown";

const config = await loadTasksConfig();
const enabled = config.tasks.filter((s) => s.enabled);
const disabled = config.tasks.length - enabled.length;

const errors = enabled.flatMap(validateSchedule);
if (errors.length > 0) {
  for (const e of errors) console.error(`tasks.yaml: ${e}`);
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
        protect: () => log.warn(`[${s.name}] previous run still in flight, skipping`),
        catch: (err) =>
          log.error(`[${s.name}] run failed: ${err instanceof Error ? err.message : String(err)}`),
      },
      async () => {
        log.info(`[${s.name}] running task "${s.task}"`);
        const res = await runTask(s.task, s.args);
        log.info(`[${s.name}] completed in ${res.durationMs}ms`);
      },
    ),
);

console.log(`Worker scheduling ${jobs.length} task(s)${disabled ? ` (${disabled} disabled)` : ""}:`);
for (const job of jobs) {
  console.log(`  ${job.name}: next run ${job.nextRun()?.toISOString() ?? "never"}`);
}

installShutdownHandler(async () => {
  for (const job of jobs) job.stop();
  await shutdownTracing();
});
