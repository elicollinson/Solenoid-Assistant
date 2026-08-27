import { loadRuntimeConfig } from "./core/config";
import { getDb } from "./db";
import { log } from "./core/logger";
import { initTracing, shutdownTracing } from "./core/tracing";
import { initNotionMcpCache, shutdownNotionMcpCache } from "./mcp/notionCache";
import { installShutdownHandler } from "./core/shutdown";
import { disposePromptGuard } from "./safety/promptGuard";
import { syncWorkflowCatalog } from "./workflows/sync";

const config = loadRuntimeConfig();
initTracing(config);

// The Workflows surface reads its list out of the database, so anything this
// service can run has to have a row there. Additive and idempotent — it is here
// rather than in src/index.ts so importing the app in a test opens no database.
const synced = syncWorkflowCatalog(getDb());
log.info(`Workflow catalog synced — ${synced.added} added, ${synced.updated} updated`);

await initNotionMcpCache().catch((error) => {
  log.warn("Notion MCP cache init failed — Notion-dependent agents will error at call time", {
    error: error instanceof Error ? error.message : String(error),
  });
});

const { app } = await import("./index");
app.listen({ port: config.port, hostname: config.host });

// Two different things, said separately.
//
// The URL is where to go, so it is always one a browser will accept — 0.0.0.0
// is a bind wildcard and Safari refuses to open it at all. The binding is who
// else can get there, which is worth saying out loud every start: "listening on
// localhost" while bound to every interface is the sort of line that hides an
// open door for a year.
const loopback = config.host === "127.0.0.1" || config.host === "::1" || config.host === "localhost";
const reach = loopback ? "this machine only" : "anything that can reach this machine on any network it is on";
log.info(`Service listening on http://localhost:${app.server?.port} — bound to ${config.host}, ${reach}`);
log.info(`API docs at http://localhost:${app.server?.port}/openapi`);

installShutdownHandler(async () => {
  await app.stop();
  await disposePromptGuard();
  await shutdownNotionMcpCache();
  await shutdownTracing();
});
