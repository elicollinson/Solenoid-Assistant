// Content card sourcing agent with live web tools via Tavily MCP.
//
// Connects through `@elicollinson/solenoid-engine`'s lazy-pooled `McpManager`
// and exposes filtered web tools to source structured media content cards.

import type { ModelRouteChain } from "@elicollinson/solenoid-engine";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";
import { AssistantAgent } from "../core/engine";
import { createModelRoutes } from "../core/providerFactory";
import type { ToolFilter } from "../mcp/adapter";
import { connectTavilyTools, DEFAULT_TAVILY_TOOL_FILTER } from "../mcp/tavily";
import {
  contentCardSchema,
  contentCardSourcingPrompt,
  type ContentCard,
} from "../prompts";
import { createSecurityScreener } from "../safety/modelArmor";
import { agentResource, type AgentResource } from "./resource";

export { DEFAULT_TAVILY_TOOL_FILTER };

export interface CreateContentCardSourcingOptions {
  /** Which Tavily tools to expose. Defaults to [tavily_search, tavily_extract]. */
  toolFilter?: ToolFilter;
  /** Override the system prompt. */
  systemPrompt?: string;
  /** Override the model. */
  model?: string;
  /** Override the complete ordered model route chain. */
  routes?: ModelRouteChain;
  /** Runtime dependency override, primarily for app composition and tests. */
  config?: RuntimeConfig;
}

/**
 * Creates a content card sourcing agent with live web tools from Tavily MCP.
 */
export async function createContentCardSourcingAgent(
  opts: CreateContentCardSourcingOptions = {},
): Promise<AgentResource> {
  const config = opts.config ?? loadRuntimeConfig();
  const tavily = await connectTavilyTools({
    apiKey: config.tavily.apiKey,
    toolFilter: opts.toolFilter ?? DEFAULT_TAVILY_TOOL_FILTER,
  });
  try {
    const agent = new AssistantAgent({
      name: "content-card-sourcing",
      routes: opts.routes ?? createModelRoutes(config, { primaryModel: opts.model }),
      systemPrompt: opts.systemPrompt ?? contentCardSourcingPrompt,
      tools: tavily.tools,
      screen: createSecurityScreener(config),
    });
    return agentResource(agent, () => tavily.close());
  } catch (error) {
    await tavily.close().catch(() => {});
    throw error;
  }
}

export { contentCardSchema, type ContentCard };
