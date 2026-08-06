// Custom AgentTool wrapping the Notion REST API deterministic search.
//
// This replaces the MCP `notion-search` tool (fuzzy, workspace-wide) with a
// per-data-source query that filters by the title property — exact or substring
// match, scoped to one database. The tool takes a `name` and `collection`,
// maps the collection to its data source ID (reusing the NOTION_DS_* env vars
// by stripping the `collection://` prefix), and returns structured results.

import { z } from "zod";
import { defineTool } from "../core/tools";
import { searchDataSourceByName, toDataSourceId } from "./restClient";

// ---------------------------------------------------------------------------
// Data source ID map (reuses existing NOTION_DS_* env vars)
// ---------------------------------------------------------------------------

/** Maps collection keys to their data source env var values. */
const DS_ID_MAP: Record<string, string | undefined> = {
  book: process.env.NOTION_DS_BOOKS,
  movie: process.env.NOTION_DS_MOVIES,
  tv: process.env.NOTION_DS_TV,
  music: process.env.NOTION_DS_MUSIC,
  game: process.env.NOTION_DS_GAMES,
};

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const searchSchema = z.object({
  name: z.string().describe("The exact page name to search for"),
  collection: z
    .enum(["book", "movie", "tv", "music", "game"])
    .describe("Which data source (database) to search"),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a `notion-search-by-name` AgentTool that performs a deterministic
 * title-based search against a specific Notion data source via the REST API.
 *
 * Unlike the MCP `notion-search` tool, this:
 *   - Searches only the target data source, not the whole workspace
 *   - Uses an exact title filter first, then a substring fallback
 *   - Returns structured JSON: { found, exact_match, page, candidates }
 *
 * The tool requires `NOTION_API_TOKEN` (internal connection token) and the
 * `NOTION_DS_*` env vars to be set.
 */
export function createNotionSearchTool() {
  return defineTool({
    name: "notion-search-by-name",
    description:
      "Search a specific Notion data source for a page by exact or partial name. " +
      "Returns a JSON object: { found, exact_match, page, candidates }. " +
      "If exact_match is true, page is the matching page. If found is true but " +
      "exact_match is false, candidates contains partial matches.",
    schema: searchSchema,
    async execute({ name, collection }) {
      const dsEnvVar = DS_ID_MAP[collection];
      if (!dsEnvVar) {
        throw new Error(
          `No data source ID configured for collection "${collection}" — ` +
            `check that NOTION_DS_${collection.toUpperCase()}S is set in .env`,
        );
      }

      const dsId = toDataSourceId(dsEnvVar);
      const result = await searchDataSourceByName(dsId, name);
      return JSON.stringify(result);
    },
  });
}