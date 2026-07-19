import { z } from "zod";

// Loader for tasks.yaml — the repo-root file binding registered tasks to cron
// schedules. Parsing uses Bun's native YAML support; validation is Zod, same
// as every other schema in the codebase. Task-name/arg validation against the
// registry is deliberately NOT done here (the worker fail-fasts on that at
// startup) so the server can still boot and list config even if the worker
// would reject it.

const scheduleSchema = z.object({
  name: z.string().min(1),
  task: z.string().min(1),
  cron: z.string().min(1),
  timezone: z.string().optional(),
  enabled: z.boolean().default(true),
  args: z.record(z.string(), z.unknown()).default({}),
});

export const tasksConfigSchema = z.object({
  tasks: z
    .array(scheduleSchema)
    .refine(
      (schedules) => new Set(schedules.map((s) => s.name)).size === schedules.length,
      { error: "schedule names must be unique" },
    ),
});

export type TasksConfig = z.infer<typeof tasksConfigSchema>;
export type ScheduledTask = TasksConfig["tasks"][number];

export const DEFAULT_CONFIG_PATH = new URL("../../tasks.yaml", import.meta.url).pathname;

export async function loadTasksConfig(path = DEFAULT_CONFIG_PATH): Promise<TasksConfig> {
  const raw = Bun.YAML.parse(await Bun.file(path).text());
  return tasksConfigSchema.parse(raw);
}
