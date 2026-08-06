// Inspect the type of each candidate database ID.
//
//   bun run scripts/notion-check-databases.ts
//
// Calls notion-fetch on each ID to determine whether it's a database
// (writable data source) or something else (linked view, page, etc.).

import { NotionMcpClient } from "../src/mcp/notionClient";
import { log } from "../src/core/logger";

const CANDIDATES = [
  { name: "Books", id: "3afaa6b5-f46f-80ca-90d7-e82ddbf8d00c" },
  { name: "Books List", id: "3afaa6b5-f46f-80bc-bafa-dbfc648efcd7" },
  { name: "Movies", id: "3afaa6b5-f46f-80ec-a5c9-fca725fcc4f1" },
  { name: "Movie List", id: "3afaa6b5-f46f-8056-bbdf-fac6f59154c7" },
  { name: "TV Shows", id: "3afaa6b5-f46f-8006-8c16-e150dbe338ab" },
  { name: "Show List", id: "3afaa6b5-f46f-808d-9697-d05f3da53f88" },
  { name: "Music", id: "3afaa6b5-f46f-805a-b360-efa352bb6eb1" },
  { name: "Music List", id: "3afaa6b5-f46f-801c-9c7d-cd2a74d1d761" },
  { name: "Games", id: "3afaa6b5-f46f-80b0-a467-f2342addd41d" },
  { name: "Game List", id: "3afaa6b5-f46f-8026-9484-e36f83e153c4" },
];

async function main(): Promise<void> {
  const client = new NotionMcpClient();
  await client.initialize();
  if (!client.hasTokens) {
    log.error("No tokens — run auth first");
    process.exit(1);
  }
  const mcpClient = await client.connect();

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  for (const { name, id } of CANDIDATES) {
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
  process.exit(0);
}

main();