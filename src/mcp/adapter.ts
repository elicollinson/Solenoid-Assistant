// MCP → AgentTool adapter.
//
// Remote MCP servers expose tools as { name, description, inputSchema }.
// The Agent class (src/core/rawAgent.ts) consumes AgentTool — a Zod schema
// for validation, a `Tool` definition for the model, and an `execute` callback.
// This module bridges the two so an agent can use remote MCP tools with the
// same `tools: [...]` option it uses for local tools.
//
// Filtering: pass a filter to expose only a subset of the server's tools to a
// given agent. A string matches by prefix ("tavily" → all tavily_* tools); an
// array matches by exact name; a function is a predicate.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import type { Tool } from "ollama";
import type { AgentTool } from "../core/tools";

// ---------------------------------------------------------------------------
// Filter type — flexible enough for prefix, allowlist, or predicate
// ---------------------------------------------------------------------------

export type ToolFilter = string | string[] | ((name: string) => boolean);

function makePredicate(filter?: ToolFilter): ((name: string) => boolean) | undefined {
  if (!filter) return undefined;
  if (typeof filter === "function") return filter;
  if (typeof filter === "string") {
    // Prefix match: "tavily" matches "tavily_search", "tavily_extract", etc.
    return (name: string) => name.startsWith(filter);
  }
  // Array: exact match against any entry
  return (name: string) => filter.includes(name);
}

// ---------------------------------------------------------------------------
// Convert one MCP Tool → AgentTool
// ---------------------------------------------------------------------------

/**
 * Wraps a remote MCP tool as a local AgentTool. The model sees the server's
 * JSON Schema for parameters; at runtime, args are forwarded to the server via
 * `client.callTool` and the text content of the result is returned.
 *
 * The Zod schema is intentionally permissive (`z.record(z.string(), z.unknown())`):
 * the MCP server validates the arguments on its end, and we don't want to
 * duplicate (or drift from) the server's schema locally.
 */
export function mcpToolToAgentTool(
  client: Client,
  mcpTool: { name: string; description?: string; inputSchema?: Record<string, unknown> },
): AgentTool {
  // Permissive schema: the MCP server does its own validation.
  const schema = z.record(z.string(), z.unknown());

  // The model-facing definition reuses the server's JSON Schema directly.
  const definition: Tool = {
    type: "function",
    function: {
      name: mcpTool.name,
      description: mcpTool.description ?? "",
      parameters: (mcpTool.inputSchema ?? { type: "object", properties: {} }) as Tool["function"]["parameters"],
    },
  };

  async function execute(args: unknown): Promise<string> {
    const result = await client.callTool({
      name: mcpTool.name,
      arguments: args as Record<string, unknown>,
    });

    // MCP results come back as content blocks. Concatenate text blocks into
    // a single string; non-text blocks are stringified so the model sees them.
    const content = (result as { content?: Array<{ type: string; text?: string; data?: string }> }).content;
    if (!content || content.length === 0) return "";

    const parts: string[] = [];
    for (const block of content) {
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      } else {
        // Images, audio, etc. — represent as a placeholder
        parts.push(`[${block.type} content]`);
      }
    }
    return parts.join("\n");
  }

  return { definition, schema, execute };
}

// ---------------------------------------------------------------------------
// Load tools from a connected MCP client, with optional filtering
// ---------------------------------------------------------------------------

/**
 * Fetches the tool list from a connected MCP client and returns them as
 * AgentTools ready to pass to an Agent. Optional `filter` narrows the set:
 *
 *   loadMcpTools(client, "tavily")            // prefix: all tavily_* tools
 *   loadMcpTools(client, ["tavily_search"])   // allowlist: just this one
 *   loadMcpTools(client, (n) => n.endsWith("_search"))  // predicate
 *   loadMcpTools(client)                       // everything
 */
export async function loadMcpTools(
  client: Client,
  filter?: ToolFilter,
): Promise<AgentTool[]> {
  const { tools } = await client.listTools();

  const predicate = makePredicate(filter);
  const selected = predicate ? tools.filter((t) => predicate(t.name)) : tools;

  return selected.map((t) => mcpToolToAgentTool(client, t));
}

// ---------------------------------------------------------------------------
// Convenience: connect + load in one step
// ---------------------------------------------------------------------------

/**
 * Connects to a remote MCP server (via a connect function), loads its tools
 * (optionally filtered), and returns both the client (to keep alive) and the
 * AgentTools. The caller must hold the client reference for the lifetime of
 * the agent — closing it invalidates the tool callbacks.
 *
 * Example:
 *   const { client, tools } = await connectAndLoadMcpTools(
 *     () => connectToTavilyMcp(),
 *     "tavily",
 *   );
 *   const agent = new Agent({ ..., tools });
 */
export async function connectAndLoadMcpTools(
  connect: () => Promise<Client>,
  filter?: ToolFilter,
): Promise<{ client: Client; tools: AgentTool[] }> {
  const client = await connect();
  const tools = await loadMcpTools(client, filter);
  return { client, tools };
}