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
import { getTask, runTask, loadTasksConfig, type ScheduledTask } from "./tasks";
import { log } from "./core/logger";

// Fail fast: a typo'd task name, bad args, or bad cron expression should kill
// the worker at startup with a clear message — not surface at 7am when the
// schedule first fires.
function validateSchedule(s: ScheduledTask): string[] {
  const errors: string[] = [];
  const task = getTask(s.task);
  if (!task) {
    errors.push(`[${s.name}] unknown task "${s.task}"`);
  } else {
    const parsed = task.schema.safeParse(s.args);
    if (!parsed.success) {
      errors.push(`[${s.name}] invalid args for task "${s.task}": ${parsed.error.message}`);
    }
  }
  try {
    new Cron(s.cron, { paused: true, timezone: s.timezone }).stop();
  } catch (err) {
    errors.push(
      `[${s.name}] invalid cron "${s.cron}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return errors;
}

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

// Flush queued spans (batch exporter) before the process exits.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    for (const job of jobs) job.stop();
    await shutdownTracing();
    process.exit(0);
  });
}
