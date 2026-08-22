import { Elysia, t } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { loadTasksConfig } from "./tasks";
import { agentRoutes } from "./http/routes/agents";
import { messageRoutes } from "./http/routes/messages";
import { safetyRoutes } from "./http/routes/safety";
import { screenshotRoutes } from "./http/routes/screenshots";
import { createTaskRoutes } from "./http/routes/tasks";

const tasksConfig = await loadTasksConfig();

export const app = new Elysia({
  // Long-running agent endpoints can exceed Elysia's default 30s timeout.
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
  .use(screenshotRoutes)
  .use(agentRoutes)
  .use(createTaskRoutes(tasksConfig))
  .use(messageRoutes)
  .use(safetyRoutes);
