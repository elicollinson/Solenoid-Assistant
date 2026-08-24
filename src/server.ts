import { loadRuntimeConfig } from "./core/config";
import { log } from "./core/logger";
import { initTracing, shutdownTracing } from "./core/tracing";
import { initNotionMcpCache, shutdownNotionMcpCache } from "./mcp/notionCache";
import { installShutdownHandler } from "./core/shutdown";
import { disposePromptGuard } from "./safety/promptGuard";

const config = loadRuntimeConfig();
initTracing(config);

await initNotionMcpCache().catch((error) => {
  log.warn("Notion MCP cache init failed — Notion-dependent agents will error at call time", {
    error: error instanceof Error ? error.message : String(error),
  });
});

const { app } = await import("./index");
app.listen(config.port);

log.info(`Service listening on http://localhost:${app.server?.port}`);
log.info(`API docs at http://localhost:${app.server?.port}/openapi`);

installShutdownHandler(async () => {
  await app.stop();
  await disposePromptGuard();
  await shutdownNotionMcpCache();
  await shutdownTracing();
});
