// Register the tracer provider before any agent handles a request. (ESM
// hoists imports, so agent modules load first — fine, since spans are only
// created at call time and the tracer is resolved lazily.)
import { initTracing, shutdownTracing } from "./core/tracing";
initTracing();
import { Ollama } from "ollama";
import { Elysia, t } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { demoAgentGG } from "./agents/demo";
import { imessageIntakeAgent } from "./agents/imessageIntake";
import { Agent } from "./core/rawAgent";
import { calculateTool } from "./tools/demo";
import pLimit from "p-limit";


import {
  weatherPrompt,
  imessageIntakePrompt,
  memoryGraderPrompt,
} from "./prompts";
import {
  tasks,
  getTask,
  runTask,
  TaskArgsError,
  loadTasksConfig,
} from "./tasks";
import { imessageIntakeSchema, memoryGraderSchema } from "./prompts";

const PORT = Number(process.env.PORT ?? 3000);

// Schedule config is display/default-args only here — the worker process
// (src/worker.ts) owns actual scheduling and re-reads the file on its own
// startup.
const tasksConfig = await loadTasksConfig();

const app = new Elysia({
  // Agent endpoints run 30-50s before writing any response bytes, which trips
  // Elysia's default 30s idleTimeout (Bun closes the socket and clients
  // silently retry the GET, re-running the whole agent). 0 disables it.
  serve: { idleTimeout: 255 },
})
  .use(
    openapi({
      documentation: {
        info: {
          title: "Manual Personal Assistant API",
          version: "0.1.0",
        },
      },
    }),
  )
  .get("/health", () => ({ status: "ok" as const }), {
    detail: { summary: "Health check" },
    response: t.Object({ status: t.Literal("ok") }),
  })
  .post(
    "/agent",
    async ({ body, set }) => {
      const city = body.city.trim();
      if (!city) {
        set.status = 400;
        return { error: 'Missing "city" field' };
      }

      try {
        const response = await demoAgentGG.run(weatherPrompt, { city });
        return { city, response };
      } catch (err) {
        set.status = 502;
        return {
          error: err instanceof Error ? err.message : "Agent call failed",
        };
      }
    },
    {
      detail: { summary: "Get weather for a city via the demo agent" },
      body: t.Object({
        city: t.String({
          minLength: 1,
          description: "City to get weather for",
        }),
      }),
      response: {
        200: t.Object({
          city: t.String(),
          response: t.String(),
        }),
        400: t.Object({ error: t.String() }),
        502: t.Object({ error: t.String() }),
      },
    },
  )
  .get(
    "/tasks",
    () =>
      [...tasks.values()].map((task) => ({
        task: task.name,
        description: task.description,
        schedules: tasksConfig.tasks
          .filter((s) => s.task === task.name)
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

      // Explicit args win; otherwise fall back to the first enabled schedule
      // for this task in tasks.yaml, so a bare POST tests the cron config.
      const args =
        body?.args ??
        tasksConfig.tasks.find((s) => s.task === name && s.enabled)?.args ??
        {};

      try {
        const result = await runTask(name, args);
        return { task: name, ...result };
      } catch (err) {
        if (err instanceof TaskArgsError) {
          set.status = 400;
          return { error: err.message };
        }
        set.status = 502;
        return {
          error: err instanceof Error ? err.message : "Task run failed",
        };
      }
    },
    {
      detail: { summary: "Run a scheduled task by name and return its output" },
      params: t.Object({
        name: t.String({ description: 'Registered task name, e.g. "weather"' }),
      }),
      body: t.Optional(
        t.Object({
          args: t.Optional(
            t.Unknown({ description: "Overrides the args from tasks.yaml" }),
          ),
        }),
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
  )
  .get(
    "/messageExtraction",
    async ({ set }) => {
      try {
        const extractedResponse = await imessageIntakeAgent.run(
          imessageIntakePrompt(),
          imessageIntakeSchema,
        );
        const limit = pLimit(8);

        const gradedMemories = await Promise.all(
          extractedResponse.memoryContext.map((memory: string) =>
            limit(async () => {
              const memoryEval = await new Agent({
                client: new Ollama({
                  host: process.env.OLLAMA_API_URL || "https://ollama.com",
                  headers: {
                    Authorization: `Bearer ${process.env.OLLAMA_API_KEY || ""}`,
                  },
                }),
                model: process.env.MODEL || "glm-5.2",
                tools: [calculateTool],
              }).run(memoryGraderPrompt({ output: memory }), memoryGraderSchema);
              return { memory, pass: memoryEval.pass };
            }),
          ),
        );
        const validatedMemories = gradedMemories
          .filter((graded) => graded.pass)
          .map((graded) => graded.memory);

        return { ...extractedResponse, memoryContext: validatedMemories };
      } catch (err) {
        set.status = 502;
        return {
          error: err instanceof Error ? err.message : "Agent call failed",
        };
      }
    },
    {
      detail: {
        summary: "Extract action items from recent iMessage conversations",
      },
      response: {
        200: t.Object({
          actionItems: t.Array(t.String()),
          conversationSummaries: t.Array(t.String()),
          memoryContext: t.Array(t.String()),
        }),
        502: t.Object({ error: t.String() }),
      },
    },
  )
  .listen(PORT);

console.log(`Service listening on http://localhost:${app.server?.port}`);
console.log(`API docs at http://localhost:${app.server?.port}/openapi`);

// Flush queued spans (batch exporter) before the process exits.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await shutdownTracing();
    process.exit(0);
  });
}
