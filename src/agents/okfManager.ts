import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";
import { AssistantAgent } from "../core/engine";
import { createModelRoutes } from "../core/providerFactory";
import { knowledgeIndex } from "../knowledgeSearch/runtime";
import { DEFAULT_OKF_ROOT } from "../okf/bundle";
import { okfManagerPrompt } from "../prompts";
import { createSecurityScreener } from "../safety/modelArmor";
import { createOkfTools } from "../tools/okf";

// Anchored to this module, not the process cwd: a bare "../../okf" resolves
// against wherever the server was launched from, so the store's location
// cannot depend on the launch directory.
export interface CreateOkfManagerAgentOptions {
  root?: string;
  actor?: string;
  config?: RuntimeConfig;
}

export function createOkfManagerAgent(
  options: CreateOkfManagerAgentOptions = {},
): AssistantAgent {
  const config = options.config ?? loadRuntimeConfig();
  const root = options.root ?? DEFAULT_OKF_ROOT;
  const { all } = createOkfTools({
    root,
    actor: options.actor ?? "okfManagerAgent",
    index: knowledgeIndex(root),
  });
  return new AssistantAgent({
    name: "okf-manager",
    routes: createModelRoutes(config),
    systemPrompt: okfManagerPrompt,
    tools: all,
    screen: createSecurityScreener(config),
    abortOnWriteQuarantine: true,
  });
}

export const okfManagerAgent = createOkfManagerAgent();
