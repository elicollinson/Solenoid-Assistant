// Screenshot classifier agent with web search capability.
//
// Connects to Tavily's MCP server at construction time and exposes web search
// tools (search, extract) to the agent. The agent receives a text description
// of what's in a screenshot (from a vision call) and uses web search to verify
// or discover the identity of media items before classifying them.
//
// The factory is async because it must connect to the remote MCP server before
// the tools are available. The returned resource owns that connection; callers
// close the resource when they finish using the agent.

import { Agent } from "../core/rawAgent";
import { classifierWithSearchPrompt, ClassificationResultSchema, type ClassificationResult } from "../prompts";
import { connectToTavilyMcp } from "../mcp/tavilyClient";
import { loadMcpTools, type ToolFilter } from "../mcp/adapter";
import { createOllamaClient } from "../core/ollama";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";
import { agentResource, type AgentResource } from "./resource";

// Default filter: search + extract are enough to verify item identity.
export const DEFAULT_TAVILY_TOOL_FILTER: ToolFilter = [
  "tavily_search",
  "tavily_extract",
];

export interface CreateClassifierAgentOptions {
  /** Which Tavily tools to expose. Defaults to [search, extract]. */
  toolFilter?: ToolFilter;
  /** Override the system prompt. */
  systemPrompt?: string;
  /** Override the model. */
  model?: string;
  /** Override max tool-calling iterations. */
  maxIterations?: number;
  /** Runtime dependency override, primarily for app composition and tests. */
  config?: RuntimeConfig;
}

/**
 * Creates a screenshot classifier agent with live web tools from Tavily MCP.
 *
 * The agent's `run` method accepts a text description of what appears in a
 * screenshot (e.g., from a vision model) and returns a structured classification
 * result with category and canonical name. When the description contains an
 * item whose identity is unclear, the agent uses web search to verify it.
 *
 * @example
 *   const resource = await createClassifierAgent();
 *   const { agent } = resource;
 *   const result = await agent.run(
 *     "Screenshot shows a Steam store page for 'Baldur's Gate 3' with RPG gameplay footage",
 *     ClassificationResultSchema,
 *   );
 *   // → { classification: "Game", name: "Baldur's Gate 3" }
 *
 * @example
 *   // All Tavily tools (search, extract, crawl, map, research)
 *   const { agent } = await createClassifierAgent({ toolFilter: "tavily" });
 */
export async function createClassifierAgent(
  opts: CreateClassifierAgentOptions = {},
): Promise<AgentResource> {
  const config = opts.config ?? loadRuntimeConfig();
  const mcpClient = await connectToTavilyMcp(config.tavily.apiKey);
  try {
    const tools = await loadMcpTools(
      mcpClient,
      opts.toolFilter ?? DEFAULT_TAVILY_TOOL_FILTER,
    );
    const agent = new Agent({
      name: "screenshot-classifier",
      client: createOllamaClient({}, config),
      systemPrompt: opts.systemPrompt ?? classifierWithSearchPrompt,
      model: opts.model ?? config.model,
      tools,
      maxIterations: opts.maxIterations,
    });
    return agentResource(agent, () => mcpClient.close());
  } catch (error) {
    await mcpClient.close().catch(() => {});
    throw error;
  }
}

export { ClassificationResultSchema, type ClassificationResult };
