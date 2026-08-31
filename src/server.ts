import { loadRuntimeConfig } from "./core/config";
import { getDb } from "./db";
import { configureLogging, flushLogs, log, shutdownLogging } from "./core/logger";
import { initTracing, shutdownTracing } from "./core/tracing";
import { initNotionMcpCache, shutdownNotionMcpCache } from "./mcp/notionCache";
import { installShutdownHandler } from "./core/shutdown";
import { disposePromptGuard } from "./safety/promptGuard";
import { describeDrift } from "./workflows/sync";
import { isRunnable } from "./workflows/runner";

const config = loadRuntimeConfig();
// Before anything else that might have something to say. Naming the service
// here rather than in the logger is what separates this process's lines from
// the worker's in a store that holds both.
configureLogging({ service: "solenoid-server", config });
initTracing(config);

// Boot LOOKS at the database and does not write to it.
//
// This used to call syncWorkflowCatalog, which made a restart able to rewrite
// rows a person or the agent had set — and in one case delete them outright,
// silently. A record a restart can change is not a record. Seeding is now a
// thing you run: `bun run db:sync-workflows`.
//
// What is left is a report, and both halves of it are failures that are
// otherwise invisible from the screen.
const drift = describeDrift(getDb(), isRunnable);
if (drift.unseeded.length) {
  log.warn(
    `${drift.unseeded.length} workflow(s) in the catalog have no row yet — they will not appear or run. ` +
      "Seed them with `bun run db:sync-workflows`.",
    { unseeded: drift.unseeded.join(",") },
  );
}
for (const slug of drift.unrunnable) {
  log.warn(`Workflow "${slug}" has a live schedule and no code behind it — it will never fire.`, {
    workflow: slug,
  });
}

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
  // Last, so it carries whatever the four lines above had to say.
  await flushLogs();
  await shutdownLogging();
});
