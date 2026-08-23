import { Elysia, t } from "elysia";
import {
  TaskArgsError,
  getTask,
  runTask,
  tasks,
  type TasksConfig,
} from "../../tasks";

export function createTaskRoutes(config: TasksConfig) {
  return new Elysia({ name: "routes.tasks" })
    .get(
      "/tasks",
      () =>
        [...tasks.values()].map((task) => ({
          task: task.name,
          description: task.description,
          schedules: config.tasks
            .filter((schedule) => schedule.task === task.name)
            .map(({ name, cron, timezone, enabled, args }) => ({
              name,
              cron,
              timezone,
              enabled,
              args,
            })),
        })),
      {
        detail: { summary: "List registered tasks and their cron schedules" },
        response: t.Array(
          t.Object({
            task: t.String(),
            description: t.String(),
            schedules: t.Array(
              t.Object({
                name: t.String(),
                cron: t.String(),
                timezone: t.Optional(t.String()),
                enabled: t.Boolean(),
                args: t.Record(t.String(), t.Unknown()),
              }),
            ),
          }),
        ),
      },
    )
    .post(
      "/tasks/:name/run",
      async ({ params, body, set }) => {
        const name = params.name;
        if (!getTask(name)) {
          set.status = 404;
          return { error: `Unknown task "${name}"` };
        }
        const args =
          body?.args ??
          config.tasks.find((schedule) => schedule.task === name && schedule.enabled)?.args ??
          {};
        try {
          const result = await runTask(name, args);
          return { task: name, ...result };
        } catch (error) {
          if (error instanceof TaskArgsError) {
            set.status = 400;
            return { error: error.message };
          }
          set.status = 502;
          return { error: error instanceof Error ? error.message : "Task run failed" };
        }
      },
      {
        detail: { summary: "Run a scheduled task by name and return its output" },
        params: t.Object({ name: t.String({ description: "Registered task name" }) }),
        body: t.Optional(
          t.Object({ args: t.Optional(t.Unknown({ description: "Overrides tasks.yaml" })) }),
        ),
        response: {
          200: t.Object({
            task: t.String(),
            startedAt: t.String(),
            durationMs: t.Number(),
            output: t.Unknown(),
          }),
          400: t.Object({ error: t.String() }),
          404: t.Object({ error: t.String() }),
          502: t.Object({ error: t.String() }),
        },
      },
    );
}
