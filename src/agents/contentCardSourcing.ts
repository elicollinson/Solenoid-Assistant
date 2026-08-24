// Content card sourcing agent.
//
// Connects to Tavily's MCP server at construction time and exposes a filtered
// subset of its web tools (search, extract) to the agent. The agent uses them
// to find a piece of media (Game, Musician, Movie, TV Show, Song, Album, Book)
// and return a structured content card with name, description, cover image,
// and URL.
//
// The factory is async because it must connect to the remote MCP server before
// the tools are available. The returned resource owns that connection; callers
// close the resource when they finish using the agent.

import { Agent, type ModelRouteInputChain } from "../core/rawAgent";
import { contentCardSourcingPrompt, contentCardSchema, type ContentCard } from "../prompts";
import { connectToTavilyMcp } from "../mcp/tavilyClient";
import { loadMcpTools, type ToolFilter } from "../mcp/adapter";
import { createModelRoutes } from "../core/providerFactory";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";
import { agentResource, type AgentResource } from "./resource";

// Default filter: search + extract are enough to source a content card.
export const DEFAULT_TAVILY_TOOL_FILTER: ToolFilter = [
  "tavily_search",
  "tavily_extract",
];

export interface CreateContentCardSourcingOptions {
  /** Which Tavily tools to expose. Defaults to [search, extract]. */
  toolFilter?: ToolFilter;
  /** Override the system prompt. */
  systemPrompt?: string;
  /** Override the model. */
  model?: string;
  /** Override the complete ordered model route chain. */
  routes?: ModelRouteInputChain;
  /** Per-provider-attempt timeout. Defaults to five minutes. */
  timeoutMs?: number;
  /** Runtime dependency override, primarily for app composition and tests. */
  config?: RuntimeConfig;
}

/**
 * Creates a content card sourcing agent with live web tools from Tavily MCP.
 *
 * The agent's `run` method accepts a string query naming the media item and,
 * when called with the `contentCardSchema`, returns a structured result with
 * name, type, description, coverImageUrl, and url.
 *
 * @example
 *   const resource = await createContentCardSourcingAgent();
 *   const { agent } = resource;
 *   const card = await agent.run("The Witcher 3", contentCardSchema);
 *   // → { name: "The Witcher 3: Wild Hunt", type: "Game", description: ..., ... }
 *
 * @example
 *   // All Tavily tools (search, extract, crawl, map, research)
 *   const { agent } = await createContentCardSourcingAgent({ toolFilter: "tavily" });
 */
export async function createContentCardSourcingAgent(
  opts: CreateContentCardSourcingOptions = {},
): Promise<AgentResource> {
  const config = opts.config ?? loadRuntimeConfig();
  const mcpClient = await connectToTavilyMcp(config.tavily.apiKey);
  try {
    const tools = await loadMcpTools(
      mcpClient,
      opts.toolFilter ?? DEFAULT_TAVILY_TOOL_FILTER,
    );
    const agent = new Agent({
      name: "content-card-sourcing",
      routes: opts.routes ?? createModelRoutes(config, { primaryModel: opts.model }),
      systemPrompt: opts.systemPrompt ?? contentCardSourcingPrompt,
      tools,
      timeoutMs: opts.timeoutMs,
    });
    return agentResource(agent, () => mcpClient.close());
  } catch (error) {
    await mcpClient.close().catch(() => {});
    throw error;
  }
}

export { contentCardSchema, type ContentCard };
