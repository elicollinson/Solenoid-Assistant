// Notion MCP connection test (CLI).
//
//   bun run scripts/notion-mcp-connect.ts
//
// Reads tokens from .env, connects to the Notion MCP server, lists available
// tools, and calls the `self` fetch tool to identify the connected workspace.

import { log } from "../src/core/logger";
import { NotionMcpClient } from "../src/mcp/notionClient";

async function main(): Promise<void> {
  const client = new NotionMcpClient();

  log.info("Initializing Notion MCP client...");
  await client.initialize();

  if (!client.hasTokens) {
    log.error(
      "No tokens found in .env — run the auth flow first:",
      {},
    );
    console.log("    bun run scripts/notion-mcp-auth.ts");
    process.exit(1);
  }

  log.info("Connecting to Notion MCP server...");
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
    console.log(`  Available tools (${tools.tools.length}):`);
    for (const tool of tools.tools) {
      console.log(`    • ${tool.name}: ${tool.description?.slice(0, 80) ?? ""}`);
    }
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  } catch (err) {
    log.warn("Failed to list tools", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Identify the connected workspace via the `self` fetch tool
  log.info("Identifying connected workspace...");
  try {
    const result = await mcpClient.callTool({
      name: "notion-fetch",
      arguments: { id: "self" },
    });

    // Tool results come back as MCP content blocks, not as a typed object.
    // The SDK's callTool return type is a broad record, so we cast to access
    // the content array.
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    if (!content || content.length === 0) {
      throw new Error("Empty content array from notion-fetch");
    }

    const block = content[0]!;
    if (block.type !== "text" || !block.text) {
      throw new Error("Expected a text content block from notion-fetch");
    }

    const parsed = JSON.parse(block.text) as {
      self?: {
        workspace?: { id: string; name: string };
        user?: { id: string; name: string; type: string; email: string };
        current_tool_access?: Record<
          string,
          { status: string; upgrade_url?: string }
        >;
      };
    };

    const self = parsed.self;
    if (self) {
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      if (self.workspace) {
        console.log(`  Workspace: ${self.workspace.name} (${self.workspace.id})`);
      }
      if (self.user) {
        console.log(`  User: ${self.user.name} (${self.user.email})`);
      }
      if (self.current_tool_access) {
        console.log("  Tool access:");
        for (const [toolName, access] of Object.entries(
          self.current_tool_access,
        )) {
          console.log(`    • ${toolName}: ${access.status}`);
        }
      }
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }
  } catch (err) {
    log.warn("Failed to identify workspace (this is non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info("Connection test complete!");
  process.exit(0);
}

main();