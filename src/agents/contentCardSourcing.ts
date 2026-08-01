// Content card sourcing agent.
//
// Connects to Tavily's MCP server at construction time and exposes a filtered
// subset of its web tools (search, extract) to the agent. The agent uses them
// to find a piece of media (Game, Musician, Movie, TV Show, Song, Album, Book)
// and return a structured content card with name, description, cover image,
// and URL.
//
// The factory is async because it must connect to the remote MCP server before
// the tools are available. The returned `mcpClient` must be kept alive for the
// agent's tools to function — closing it invalidates the tool callbacks.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Agent } from "../core/rawAgent";
import { Ollama } from "ollama";
import { contentCardSourcingPrompt, contentCardSchema, type ContentCard } from "../prompts";
import { connectToTavilyMcp } from "../mcp/tavilyClient";
import { loadMcpTools, type ToolFilter } from "../mcp/adapter";

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
  /** Override max tool-calling iterations. */
  maxIterations?: number;
}

export interface ContentCardSourcingAgent {
  agent: Agent;
  /** The live MCP client — keep this reference alive while the agent is in use. */
  mcpClient: Client;
}

/**
 * Creates a content card sourcing agent with live web tools from Tavily MCP.
 *
 * The agent's `run` method accepts a string query naming the media item and,
 * when called with the `contentCardSchema`, returns a structured result with
 * name, type, description, coverImageUrl, and url.
 *
 * @example
 *   const { agent, mcpClient } = await createContentCardSourcingAgent();
 *   const card = await agent.run("The Witcher 3", contentCardSchema);
 *   // → { name: "The Witcher 3: Wild Hunt", type: "Game", description: ..., ... }
 *
 * @example
 *   // All Tavily tools (search, extract, crawl, map, research)
 *   const { agent } = await createContentCardSourcingAgent({ toolFilter: "tavily" });
 */
export async function createContentCardSourcingAgent(
  opts: CreateContentCardSourcingOptions = {},
): Promise<ContentCardSourcingAgent> {
  const mcpClient = await connectToTavilyMcp();

  const tools = await loadMcpTools(mcpClient, opts.toolFilter ?? DEFAULT_TAVILY_TOOL_FILTER);

  const agent = new Agent({
    client: new Ollama({
      host: process.env.OLLAMA_API_URL || "https://ollama.com",
      headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY || ""}` },
    }),
    systemPrompt: opts.systemPrompt ?? contentCardSourcingPrompt,
    model: opts.model ?? process.env.MODEL ?? "glm-5.2",
    tools,
    maxIterations: opts.maxIterations,
  });

  return { agent, mcpClient };
}

export { contentCardSchema, type ContentCard };