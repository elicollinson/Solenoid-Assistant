// Find Notion gallery database IDs for the recommendation ingestion agent.
//
//   bun run scripts/notion-find-databases.ts
//
// Connects to the Notion MCP server, searches for databases by collection
// type (books, movies, tv, music, games), and prints their IDs so you can
// set the NOTION_DS_* env vars.

import { NotionMcpClient } from "../src/mcp/notionClient";
import { log } from "../src/core/logger";

async function main(): Promise<void> {
  const client = new NotionMcpClient();
  await client.initialize();

  if (!client.hasTokens) {
    log.error("No tokens found in .env — run the auth flow first:");
    console.log("    bun run scripts/notion-mcp-auth.ts");
    process.exit(1);
  }

  const mcpClient = await client.connect();

  // Search for each collection type. The notion-search tool searches the
  // whole workspace, so we look for common terms.
  const searches = [
    { label: "Books", query: "books" },
    { label: "Movies", query: "movies" },
    { label: "TV", query: "tv shows" },
    { label: "Music", query: "music" },
    { label: "Games", query: "games" },
  ];

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Searching for gallery databases in your Notion workspace...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  for (const { label, query } of searches) {
    try {
      const result = await mcpClient.callTool({
        name: "notion-search",
        arguments: { query, page_size: 10 },
      });

      const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
      if (!content || content.length === 0) {
        console.log(`  ${label}: no results\n`);
        continue;
      }

      const text = content.map((b) => b.text ?? "").join("\n");
      const parsed = JSON.parse(text);

      const results = Array.isArray(parsed) ? parsed : parsed.results ?? [parsed];

      console.log(`  --- ${label} (search: "${query}") ---`);
      for (const r of results) {
        const title =
          r.properties?.Name?.title?.[0]?.text?.content ??
          r.title ??
          r.name ??
          "(untitled)";
        const id = r.id ?? "?";
        const parent = r.parent?.type ? ` (parent: ${r.parent.type})` : "";
        console.log(`    ${title} — id: ${id}${parent}`);
      }
      console.log();
    } catch (err) {
      console.log(`  ${label}: search failed — ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Copy the database IDs above into your .env:");
  console.log("    NOTION_DS_BOOKS=<id>");
  console.log("    NOTION_DS_MOVIES=<id>");
  console.log("    NOTION_DS_TV=<id>");
  console.log("    NOTION_DS_MUSIC=<id>");
  console.log("    NOTION_DS_GAMES=<id>");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  await mcpClient.close();
  process.exit(0);
}

main().catch((error) => {
  log.error("Notion database discovery failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
