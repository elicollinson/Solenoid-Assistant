// Recommendation ingestion agent.
//
// Connects to Notion's MCP server and exposes a filtered subset of its tools
// (create-pages, update-page) to the agent, plus a custom `notion-search-by-name`
// tool backed by the Notion REST API for deterministic, per-database title
// searches. The agent uses them to insert or update a single record in a Notion
// gallery database based on a structured input (name, url, description,
// image_url, collection).
//
// By default the agent reuses the shared Notion MCP client cached at app
// startup (see src/mcp/notionCache.ts). Callers may also pass their own
// `mcpClient` — in that case the caller is responsible for its lifecycle.
//
// The factory is async because it must ensure the Notion MCP client is
// connected before the tools are available.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Agent } from "../core/rawAgent";
import { Ollama } from "ollama";
import {
  recommendationIngestionPrompt,
  recommendationIngestionSchema,
  recommendationIngestionInputSchema,
  validateNotionDsIds,
  type RecommendationIngestionResult,
  type RecommendationIngestionInput,
} from "../prompts";
import { loadMcpTools, type ToolFilter } from "../mcp/adapter";
import {
  getNotionMcpClient,
  initNotionMcpCache,
  reconnectNotionMcpCache,
  isNotionAuthError,
} from "../mcp/notionCache";
import { createNotionSearchTool } from "../notion/searchTool";

// Default filter: create + update via MCP are enough to ingest a record.
// Search is now handled by the custom `notion-search-by-name` tool (REST API).
// Notion MCP tool names are hyphenated, not underscored.
export const DEFAULT_NOTION_TOOL_FILTER: ToolFilter = [
  "notion-create-pages",
  "notion-update-page",
];

export interface CreateRecommendationIngestionOptions {
  /** Which Notion MCP tools to expose (create/update). Search is handled by the custom REST API tool. */
  toolFilter?: ToolFilter;
  /** Override the system prompt. */
  systemPrompt?: string;
  /** Override the model. */
  model?: string;
  /** Override max tool-calling iterations. */
  maxIterations?: number;
  /**
   * An externally-provided MCP client. When set, the caller owns the client
   * and must keep it alive (and close it when done). When omitted, the agent
   * uses the shared cached client from `src/mcp/notionCache.ts`.
   */
  mcpClient?: Client;
}

export interface RecommendationIngestionAgent {
  agent: Agent;
  /** The live MCP client backing the agent's tools. */
  mcpClient: Client;
  /**
   * Whether the caller owns the client (and should close it when done).
   * `false` when using the shared startup cache — in that case, do NOT close.
   */
  ownsClient: boolean;
}

/**
 * Creates a recommendation ingestion agent backed by live Notion MCP tools.
 *
 * The agent's `run` method accepts a JSON-serialized
 * `RecommendationIngestionInput` as its prompt string and, when called with
 * `recommendationIngestionSchema`, returns a structured `RecommendationIngestionResult`.
 *
 * @example
 *   const { agent } = await createRecommendationIngestionAgent();
 *   const input: RecommendationIngestionInput = {
 *     name: "Dune",
 *     url: "https://en.wikipedia.org/wiki/Dune_(novel)",
 *     collection: "book",
 *   };
 *   const result = await agent.run(JSON.stringify(input), recommendationIngestionSchema);
 *   // → { status: "created", match: "none", page_id: "...", page_url: "...", warnings: [], error: null }
 *
 * @example
 *   // With a custom MCP client (caller manages lifecycle):
 *   const { agent, mcpClient, ownsClient } = await createRecommendationIngestionAgent({ mcpClient });
 *   try { ... } finally { if (ownsClient) mcpClient.close(); }
 */
export async function createRecommendationIngestionAgent(
  opts: CreateRecommendationIngestionOptions = {},
): Promise<RecommendationIngestionAgent> {
  // Fail fast if the Notion data source IDs aren't configured — otherwise the
  // agent would send literal placeholders to Notion and silently "succeed".
  validateNotionDsIds();

  let mcpClient: Client;
  let ownsClient: boolean;

  if (opts.mcpClient) {
    mcpClient = opts.mcpClient;
    ownsClient = true;
  } else {
    // Use the shared cached client, initializing the cache if needed.
    let client = getNotionMcpClient();
    if (!client) {
      const cache = await initNotionMcpCache();
      client = cache.client;
    }
    mcpClient = client;
    ownsClient = false;
  }

  // Build the custom deterministic search tool (REST API) alongside the
  // MCP create/update tools.
  const notionSearchTool = createNotionSearchTool();

  let tools;
  try {
    const mcpTools = await loadMcpTools(mcpClient, opts.toolFilter ?? DEFAULT_NOTION_TOOL_FILTER);
    tools = [notionSearchTool, ...mcpTools];
  } catch (err) {
    // If the cached client's token expired during runtime, the listTools()
    // call inside loadMcpTools will fail with an auth error. Reconnect with
    // a fresh token and retry once.
    if (!ownsClient && isNotionAuthError(err)) {
      const cache = await reconnectNotionMcpCache();
      mcpClient = cache.client;
      const mcpTools = await loadMcpTools(mcpClient, opts.toolFilter ?? DEFAULT_NOTION_TOOL_FILTER);
      tools = [notionSearchTool, ...mcpTools];
    } else {
      throw err;
    }
  }

  const agent = new Agent({
    client: new Ollama({
      host: process.env.OLLAMA_API_URL || "https://ollama.com",
      headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY || ""}` },
    }),
    systemPrompt: opts.systemPrompt ?? recommendationIngestionPrompt(),
    model: opts.model ?? process.env.MODEL ?? "glm-5.2",
    tools,
    maxIterations: opts.maxIterations,
  });

  return { agent, mcpClient, ownsClient };
}

export {
  recommendationIngestionSchema,
  recommendationIngestionInputSchema,
  type RecommendationIngestionResult,
  type RecommendationIngestionInput,
};