import { Elysia, t } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { loadTasksConfig } from "./tasks";
import { agentRoutes } from "./http/routes/agents";
import { messageRoutes } from "./http/routes/messages";
import { safetyRoutes } from "./http/routes/safety";
import { screenshotRoutes } from "./http/routes/screenshots";
import { createTaskRoutes } from "./http/routes/tasks";
import { createUiRoutes } from "./http/routes/ui";
import { createWebRoutes, findWebBuild } from "./http/routes/web";

const tasksConfig = await loadTasksConfig();

// The built web app, when there is one. Absent in development, where Vite
// serves it on :5173 and proxies /api here; present once `bun run build:web`
// has run, which is what lets the installed app talk to one origin.
const webBuild = await findWebBuild(import.meta.dir.replace(/\/src$/, ""));

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
  .use(safetyRoutes)
  .use(createUiRoutes())
  // Last, and only if built: its wildcard would otherwise answer for routes
  // that belong to the API above it.
  .use(webBuild ? createWebRoutes(webBuild) : new Elysia({ name: "routes.web.absent" }));
