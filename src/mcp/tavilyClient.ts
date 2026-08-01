// Tavily MCP client — connects to Tavily's hosted MCP server for live web
// access (search, extract, crawl, map). Unlike Notion, Tavily uses a simple
// API key in the URL query string — no OAuth flow needed.
//
// The server endpoint is:
//   https://mcp.tavily.com/mcp/?tavilyApiKey=<API_KEY>
//
// Tools exposed (prefixed `tavily_`):
//   tavily_search   — web search with AI-optimized results
//   tavily_extract  — extract clean content from URLs
//   tavily_crawl    — crawl a website recursively
//   tavily_map      — map a website's URL structure
//   tavily_research — deep research with multi-step reasoning

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { log } from "../core/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TAVILY_MCP_SERVER_BASE = "https://mcp.tavily.com/mcp";

// ---------------------------------------------------------------------------
// Build the server URL with the API key
// ---------------------------------------------------------------------------

/**
 * Builds the Tavily MCP server URL with the API key embedded as a query param.
 * The key comes from TAVILY_API_KEY in .env (Bun auto-loads it).
 */
export function buildTavilyMcpUrl(apiKey?: string): string {
  const key = apiKey ?? process.env.TAVILY_API_KEY;
  if (!key) {
    throw new Error(
      "TAVILY_API_KEY is not set. Add it to .env (get one at https://app.tavily.com).",
    );
  }
  return `${TAVILY_MCP_SERVER_BASE}/?tavilyApiKey=${key}`;
}

// ---------------------------------------------------------------------------
// Connect to the MCP server with Streamable HTTP (SSE fallback)
// ---------------------------------------------------------------------------

export async function createTavilyMcpClient(
  apiKey?: string,
  useSSE: boolean = false,
): Promise<Client> {
  const serverUrl = buildTavilyMcpUrl(apiKey);

  const client = new Client(
    {
      name: "manual-personal-assistant",
      version: "1.0.0",
    },
    {
      capabilities: {
        roots: {},
        sampling: {},
      },
    },
  );

  let transport;

  if (useSSE) {
    // Tavily's SSE endpoint follows the same pattern with /sse suffix
    const sseUrl = serverUrl.replace("/mcp", "/sse");
    transport = new SSEClientTransport(new URL(sseUrl), {
      requestInit: {
        headers: {
          "User-Agent": "ManualPersonalAssistant-MCP-Client/1.0",
        },
      },
    });
  } else {
    transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      requestInit: {
        headers: {
          "User-Agent": "ManualPersonalAssistant-MCP-Client/1.0",
        },
      },
    });
  }

  await client.connect(transport);

  return client;
}

/**
 * Connect to Tavily MCP, trying Streamable HTTP first and falling back to SSE.
 */
export async function connectToTavilyMcp(apiKey?: string): Promise<Client> {
  try {
    return await createTavilyMcpClient(apiKey, false);
  } catch (error) {
    log.warn("Streamable HTTP failed, falling back to SSE", {
      error: error instanceof Error ? error.message : String(error),
    });
    return await createTavilyMcpClient(apiKey, true);
  }
}

// ---------------------------------------------------------------------------
// Client class (mirrors the NotionMcpClient shape for consistency)
// ---------------------------------------------------------------------------

export class TavilyMcpClient {
  private apiKey: string | undefined;
  private client: Client | undefined;

  /** Initialize from .env. */
  initialize(): void {
    this.apiKey = process.env.TAVILY_API_KEY;
    if (!this.apiKey) {
      throw new Error(
        "TAVILY_API_KEY is not set. Add it to .env (get one at https://app.tavily.com).",
      );
    }
  }

  /** Connect to the MCP server. */
  async connect(): Promise<Client> {
    if (!this.apiKey) {
      throw new Error("Not initialized — call initialize() first");
    }
    this.client = await connectToTavilyMcp(this.apiKey);
    return this.client;
  }

  get isConnected(): boolean {
    return this.client !== undefined;
  }

  get hasApiKey(): boolean {
    return this.apiKey !== undefined;
  }
}