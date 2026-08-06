// Screenshot classifier agent with web search capability.
//
// Connects to Tavily's MCP server at construction time and exposes web search
// tools (search, extract) to the agent. The agent receives a text description
// of what's in a screenshot (from a vision call) and uses web search to verify
// or discover the identity of media items before classifying them.
//
// The factory is async because it must connect to the remote MCP server before
// the tools are available. The returned `mcpClient` must be kept alive for the
// agent's tools to function — closing it invalidates the tool callbacks.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Agent } from "../core/rawAgent";
import { Ollama } from "ollama";
import { classifierWithSearchPrompt, ClassificationResultSchema, type ClassificationResult } from "../prompts";
import { connectToTavilyMcp } from "../mcp/tavilyClient";
import { loadMcpTools, type ToolFilter } from "../mcp/adapter";

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
}

export interface ClassifierAgent {
  agent: Agent;
  /** The live MCP client — keep this reference alive while the agent is in use. */
  mcpClient: Client;
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
 *   const { agent, mcpClient } = await createClassifierAgent();
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
): Promise<ClassifierAgent> {
  const mcpClient = await connectToTavilyMcp();

  const tools = await loadMcpTools(mcpClient, opts.toolFilter ?? DEFAULT_TAVILY_TOOL_FILTER);

  const agent = new Agent({
    client: new Ollama({
      host: process.env.OLLAMA_API_URL || "https://ollama.com",
      headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY || ""}` },
    }),
    systemPrompt: opts.systemPrompt ?? classifierWithSearchPrompt,
    model: opts.model ?? process.env.MODEL ?? "glm-5.2",
    tools,
    maxIterations: opts.maxIterations,
  });

  return { agent, mcpClient };
}

export { ClassificationResultSchema, type ClassificationResult };
