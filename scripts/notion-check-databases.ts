// Inspect the type of each candidate database ID.
//
//   bun run scripts/notion-check-databases.ts
//
// Calls notion-fetch on each ID to determine whether it's a database
// (writable data source) or something else (linked view, page, etc.).

import { NotionMcpClient } from "../src/mcp/notionClient";
import { loadRuntimeConfig } from "../src/core/config";
import { log } from "../src/core/logger";

const config = loadRuntimeConfig();
const configuredCandidates = [
  ["Books", config.notion.dataSourceIds.book],
  ["Movies", config.notion.dataSourceIds.movie],
  ["TV Shows", config.notion.dataSourceIds.tv],
  ["Music", config.notion.dataSourceIds.music],
  ["Games", config.notion.dataSourceIds.game],
] as const;

function candidates(): Array<{ name: string; id: string }> {
  const ids = process.argv.slice(2);
  if (ids.length > 0) return ids.map((id, index) => ({ name: `Candidate ${index + 1}`, id }));
  return configuredCandidates.flatMap(([name, id]) => (id ? [{ name, id }] : []));
}

async function main(): Promise<void> {
  const databaseCandidates = candidates();
  if (databaseCandidates.length === 0) {
    throw new Error(
      "No database IDs supplied. Pass IDs as arguments or configure the NOTION_DS_* variables.",
    );
  }
  const client = new NotionMcpClient();
  await client.initialize();
  if (!client.hasTokens) {
    log.error("No tokens — run auth first");
    process.exit(1);
  }
  const mcpClient = await client.connect();

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  for (const { name, id } of databaseCandidates) {
    try {
      const result = await mcpClient.callTool({
        name: "notion-fetch",
        arguments: { id },
      });
      const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
      if (!content || content.length === 0) {
        console.log(`  ${name.padEnd(12)} (${id}) — empty response`);
        continue;
      }
      const parsed = JSON.parse(content[0]!.text!);
      const type = parsed.type ?? parsed.object ?? "?";
      const title =
        parsed.title ??
        parsed.properties?.Name?.title?.[0]?.text?.content ??
        parsed.name ??
        "?";
      const parentType = parsed.parent?.type ?? "?";
      console.log(`  ${name.padEnd(12)} (${id})`);
      console.log(`    type: ${type}, title: ${title}, parent: ${parentType}`);
    } catch (err) {
      console.log(`  ${name.padEnd(12)} (${id}) — ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  await mcpClient.close();
  process.exit(0);
}

main().catch((error) => {
  log.error("Notion database check failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
