
import { join } from "node:path";
import { Agent } from "../core/rawAgent";
import { createOkfTools } from "../tools/okf";
import { okfManagerPrompt } from "../prompts";
import { createOllamaClient } from "../core/ollama";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";

// Anchored to this module, not the process cwd: a bare "../../okf" resolves
// against wherever the server was launched from (with `bun start` at the repo
// root that meant ~/Documents/okf), so the store's location silently depended
// on the launch directory.
export interface CreateOkfManagerAgentOptions {
  root?: string;
  actor?: string;
  config?: RuntimeConfig;
}

export function createOkfManagerAgent(
  options: CreateOkfManagerAgentOptions = {},
): Agent {
  const config = options.config ?? loadRuntimeConfig();
  const { all } = createOkfTools({
    root: options.root ?? join(import.meta.dir, "../../okf"),
    actor: options.actor ?? "okfManagerAgent",
  });
  return new Agent({
    name: "okf-manager",
    client: createOllamaClient({}, config),
    systemPrompt: okfManagerPrompt,
    model: config.model,
    tools: all,
  });
}

export const okfManagerAgent = createOkfManagerAgent();
