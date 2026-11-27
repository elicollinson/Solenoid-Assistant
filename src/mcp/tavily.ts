import {
  McpManager,
  mcpToolName,
  type AgentTool as EngineAgentTool,
  type McpClientLike,
} from "@elicollinson/solenoid-engine";
import { createEngineLogger } from "../core/engine";
import type { ToolFilter } from "./adapter";
import { buildTavilyMcpUrl, connectToTavilyMcp } from "./tavilyClient";

export const TAVILY_SERVER_NAME = "tavily";

export const DEFAULT_TAVILY_TOOL_FILTER: ToolFilter = [
  "tavily_search",
  "tavily_extract",
];

function matchesFilter(name: string, filter?: ToolFilter): boolean {
  if (!filter) return true;
  if (typeof filter === "function") return filter(name);
  if (typeof filter === "string") return name.startsWith(filter);
  return filter.includes(name);
}

function createTavilyClientAdapter(apiKey?: string): () => Promise<McpClientLike> {
  return async () => {
    const client = await connectToTavilyMcp(apiKey);
    return {
      listTools: () => client.listTools(),
      callTool: async (params) => {
        const result = await client.callTool(params);
        if ("content" in result) {
          return {
            content: result.content,
            ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
          };
        }
        return { content: result.toolResult };
      },
      close: () => client.close(),
    };
  };
}

export interface TavilyMcpPoolOptions {
  apiKey?: string;
  idleTtlMs?: number;
  createClient?: () => Promise<McpClientLike>;
}

/**
 * Create a lazy-pooled `@elicollinson/solenoid-engine` `McpManager` configured
 * for Tavily MCP (honoring `TAVILY_MCP_URL` credential-proxy overrides and
 * Streamable HTTP -> SSE fallback).
 */
export function createTavilyMcpManager(options: TavilyMcpPoolOptions = {}): McpManager {
  const url = buildTavilyMcpUrl(options.apiKey);
  const connect = options.createClient ?? createTavilyClientAdapter(options.apiKey);
  const manager = new McpManager({
    idleTtlMs: options.idleTtlMs,
    logger: createEngineLogger("mcp"),
    createClient: async () => connect(),
  });
  manager.configure({
    [TAVILY_SERVER_NAME]: {
      type: "http",
      url,
      ...(options.idleTtlMs !== undefined ? { idleTtlMs: options.idleTtlMs } : {}),
    },
  });
  return manager;
}

export interface TavilyToolsHandle {
  manager: McpManager;
  tools: EngineAgentTool[];
  close(): Promise<void>;
}

/**
 * Discover Tavily MCP tools via the lazy-pooled `McpManager` using deduplicated
 * `mcpToolName` (`tavily_search` stays `tavily_search`) and optional filtering.
 */
export async function connectTavilyTools(
  options: TavilyMcpPoolOptions & { toolFilter?: ToolFilter } = {},
): Promise<TavilyToolsHandle> {
  const manager = createTavilyMcpManager(options);
  try {
    const discovered = await manager.discoverTools(TAVILY_SERVER_NAME);
    const filter = options.toolFilter ?? DEFAULT_TAVILY_TOOL_FILTER;
    const tools = discovered.filter((tool) =>
      matchesFilter(tool.definition.function.name, filter),
    );
    return {
      manager,
      tools,
      close: () => manager.close(),
    };
  } catch (error) {
    await manager.close().catch(() => {});
    throw error;
  }
}

export { buildTavilyMcpUrl, mcpToolName };
