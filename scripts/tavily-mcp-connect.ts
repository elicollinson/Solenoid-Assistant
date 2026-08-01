// Tavily MCP connection test (CLI).
//
//   bun run scripts/tavily-mcp-connect.ts
//
// Reads the API key from .env, connects to Tavily's MCP server, lists
// available tools, and runs a sample search to verify the key works.

import { log } from "../src/core/logger";
import { TavilyMcpClient } from "../src/mcp/tavilyClient";

async function main(): Promise<void> {
  const client = new TavilyMcpClient();

  log.info("Initializing Tavily MCP client...");
  try {
    client.initialize();
  } catch (err) {
    log.error("Initialization failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  log.info("Connecting to Tavily MCP server...");
  let mcpClient;
  try {
    mcpClient = await client.connect();
  } catch (err) {
    log.error("Connection failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // List available tools
  log.info("Listing available tools...");
  try {
    const tools = await mcpClient.listTools();
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`  Tavily tools (${tools.tools.length}):`);
    for (const tool of tools.tools) {
      const desc = tool.description?.slice(0, 80) ?? "";
      console.log(`    • ${tool.name}: ${desc}`);
    }
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  } catch (err) {
    log.warn("Failed to list tools", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Run a sample search to verify the key works
  log.info("Running sample search...");
  try {
    const result = await mcpClient.callTool({
      name: "tavily_search",
      arguments: { query: "latest AI news" },
    });

    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    if (!content || content.length === 0) {
      throw new Error("Empty content array from tavily_search");
    }

    const block = content[0]!;
    if (block.type === "text" && block.text) {
      // Truncate for terminal display
      const preview = block.text.length > 500
        ? block.text.slice(0, 500) + "..."
        : block.text;
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("  Sample search result:");
      console.log(`  ${preview}`);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    } else {
      console.log("  (Non-text result returned)");
    }
  } catch (err) {
    log.warn("Sample search failed (key may be invalid or rate-limited)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info("Connection test complete!");
  process.exit(0);
}

main();