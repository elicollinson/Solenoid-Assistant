import { z } from "zod";
import {
  withSpanKind,
  safeJson,
  SemanticConventions,
} from "../core/tracing";

// ---------------------------------------------------------------------------
// A task bundles everything about one schedulable capability in ONE place,
// mirroring `defineTool` in core/tools.ts: the Zod schema validates args
// whether they arrive from tasks.yaml (cron worker) or an HTTP trigger, and
// `runTask` is the single execution seam both entrypoints share — so a manual
// run exercises exactly the code a scheduled run does, traces included.
// ---------------------------------------------------------------------------

export interface TaskDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  execute: (args: z.infer<S>) => Promise<unknown>;
}

export function defineTask<S extends z.ZodType>(config: TaskDef<S>): TaskDef<S> {
  return config;
}

/** Thrown when a task's args fail schema validation — maps to HTTP 400. */
export class TaskArgsError extends Error {
  constructor(taskName: string, issue: string) {
    super(`Invalid args for task "${taskName}": ${issue}`);
    this.name = "TaskArgsError";
  }
}

export const tasks = new Map<string, TaskDef>();

export function registerTask(task: TaskDef): void {
  tasks.set(task.name, task);
}

export function getTask(name: string): TaskDef | undefined {
  return tasks.get(name);
}

export interface TaskRunResult {
  output: unknown;
  startedAt: string;
  durationMs: number;
}

export async function runTask(name: string, rawArgs: unknown): Promise<TaskRunResult> {
  const task = getTask(name);
  if (!task) throw new Error(`Unknown task "${name}"`);

  const parsed = task.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) throw new TaskArgsError(name, z.prettifyError(parsed.error));

  return withSpanKind(
    "CHAIN",
    `task:${name}`,
    {
      [SemanticConventions.INPUT_VALUE]: safeJson(parsed.data),
      [SemanticConventions.INPUT_MIME_TYPE]: "application/json",
    },
    async (span) => {
      const startedAt = new Date().toISOString();
      const t0 = performance.now();
      const output = await task.execute(parsed.data);
      span.setAttributes({
        [SemanticConventions.OUTPUT_VALUE]: typeof output === "string" ? output : safeJson(output),
        [SemanticConventions.OUTPUT_MIME_TYPE]: typeof output === "string" ? "text/plain" : "application/json",
      });
      return { output, startedAt, durationMs: Math.round(performance.now() - t0) };
    },
  );
}
