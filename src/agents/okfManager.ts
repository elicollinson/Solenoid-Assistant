
import { Agent } from "../core/rawAgent";
import { knowledgeIndex } from "../knowledgeSearch/runtime";
import { DEFAULT_OKF_ROOT } from "../okf/bundle";
import { createOkfTools } from "../tools/okf";
import { okfManagerPrompt } from "../prompts";
import { createModelRoutes } from "../core/providerFactory";
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
  const root = options.root ?? DEFAULT_OKF_ROOT;
  const { all } = createOkfTools({
    root,
    actor: options.actor ?? "okfManagerAgent",
    index: knowledgeIndex(root),
  });
  return new Agent({
    name: "okf-manager",
    routes: createModelRoutes(config),
    systemPrompt: okfManagerPrompt,
    tools: all,
  });
}

export const okfManagerAgent = createOkfManagerAgent();
