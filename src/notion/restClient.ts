// Notion REST API client — lightweight wrapper around the data source query
// endpoint for deterministic, per-database title searches.
//
// Unlike the MCP `notion-search` tool (which does a fuzzy, workspace-wide
// search), this client queries a specific data source with a filter on the
// title property — exact or substring match, scoped to one database.
//
// Uses Bun's built-in `fetch` — no new dependencies.
//
// API docs (validated from https://developers.notion.com):
//   - Endpoint: POST /v1/data_sources/{data_source_id}/query
//   - Notion-Version: 2026-03-11
//   - Auth: Authorization: Bearer {token}
//   - Title filter: { "property": "Name", "title": { "equals": "Dune" } }
//   - Filter conditions: equals, does_not_equal, contains, does_not_contain,
//     starts_with, ends_with, is_empty, is_not_empty
//   - Pagination: has_more + next_cursor → use start_cursor for next page
//   - Performance: filter_properties[] query param limits response fields

import { z } from "zod";
import { log } from "../core/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";

// ---------------------------------------------------------------------------
// Types (Zod schemas → inferred types)
// ---------------------------------------------------------------------------

/** Zod schema for the Notion page title property (both `title` and `Name` keys). */
const titlePropertySchema = z.object({
  title: z.array(z.object({ plain_text: z.string() })),
});

/** Zod schema for a single page result from the data source query endpoint. */
export const notionPageResultSchema = z.object({
  id: z.string(),
  url: z.string(),
  properties: z.object({
    title: titlePropertySchema.optional(),
    Name: titlePropertySchema.optional(),
    Link: z.object({ url: z.string().nullable() }).optional(),
    Description: z
      .object({ rich_text: z.array(z.object({ plain_text: z.string() })) })
      .optional(),
  }),
});

/** A single page result from the data source query endpoint (simplified). */
export type NotionPageResult = z.infer<typeof notionPageResultSchema>;

/** Zod schema for the data source query endpoint response (paginated). */
const queryResponseSchema = z.object({
  results: z.array(notionPageResultSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

/** Zod schema for the structured result of a deterministic name search. */
export const searchResultSchema = z.object({
  found: z.boolean(),
  exact_match: z.boolean(),
  page: notionPageResultSchema.nullable(),
  candidates: z.array(notionPageResultSchema),
});

/** Structured result of a deterministic name search. */
export type SearchResult = z.infer<typeof searchResultSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip the `collection://` prefix from MCP-style data source IDs.
 * The Notion MCP tools use `collection://<uuid>` format, but the REST API
 * expects bare UUIDs. This lets us reuse the existing NOTION_DS_* env vars.
 */
export function toDataSourceId(dsEnvVar: string): string {
  return dsEnvVar.replace(/^collection:\/\//, "");
}

function getHeaders(): Record<string, string> {
  const token = process.env.NOTION_API_TOKEN;
  if (!token) {
    throw new Error(
      "NOTION_API_TOKEN not set in .env — create an internal connection at " +
        "https://app.notion.com/developers/connections and add the token.",
    );
  }
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

/** Extract the page title from a result, handling both `title` and `Name` property keys. */
export function getPageTitle(page: NotionPageResult): string {
  const titleProp = page.properties.title ?? page.properties.Name;
  if (!titleProp?.title) return "";
  return titleProp.title.map((t) => t.plain_text).join("");
}

// ---------------------------------------------------------------------------
// Core API: search a data source by name
// ---------------------------------------------------------------------------

/**
 * Searches a specific Notion data source for pages matching the given name.
 * Uses the data source query endpoint with a title filter — deterministic,
 * not fuzzy, scoped to one database.
 *
 * Strategy:
 * 1. Query with `title.equals` (exact, case-insensitive) → if one result, that's EXACT
 * 2. If no exact match, query with `title.contains` (substring) → candidates for UNSURE
 *
 * @param dataSourceId - The bare UUID of the data source (strip `collection://` first)
 * @param name - The page name to search for
 */
export async function searchDataSourceByName(
  dataSourceId: string,
  name: string,
): Promise<SearchResult> {
  // Step 1: Exact match (Notion's `equals` is case-insensitive per docs)
  const exactResults = await queryDataSource(dataSourceId, {
    property: "Name",
    title: { equals: name },
  });

  if (exactResults.length === 1) {
    return { found: true, exact_match: true, page: exactResults[0] ?? null, candidates: [] };
  }
  if (exactResults.length > 1) {
    // Multiple exact matches — unlikely but treat as UNSURE
    return { found: true, exact_match: false, page: null, candidates: exactResults };
  }

  // Step 2: Contains match for partial/substring matches
  const partialResults = await queryDataSource(dataSourceId, {
    property: "Name",
    title: { contains: name },
  });

  return {
    found: partialResults.length > 0,
    exact_match: false,
    page: null,
    candidates: partialResults,
  };
}

// ---------------------------------------------------------------------------
// Low-level API call
// ---------------------------------------------------------------------------

/**
 * Queries a Notion data source with a filter, paginating through all results.
 * Uses `filter_properties[]` to limit response size to only the properties we need.
 */
async function queryDataSource(
  dataSourceId: string,
  filter: Record<string, unknown>,
): Promise<NotionPageResult[]> {
  const allResults: NotionPageResult[] = [];
  let startCursor: string | undefined;

  do {
    const url = new URL(`${NOTION_API_BASE}/data_sources/${dataSourceId}/query`);
    // Limit response to only the properties we need (performance per docs)
    url.searchParams.append("filter_properties[]", "title");
    url.searchParams.append("filter_properties[]", "Link");
    url.searchParams.append("filter_properties[]", "Description");

    const body: Record<string, unknown> = { filter };
    if (startCursor) {
      body.start_cursor = startCursor;
    }

    const res = await fetch(url, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      const status = res.status;
      let hint = "";
      if (status === 404) {
        hint = " — the data source may not exist or the connection lacks access (share the database with the internal connection)";
      } else if (status === 403) {
        hint = " — the connection may lack 'read content' capabilities (check the Configuration tab)";
      } else if (status === 429) {
        hint = " — rate limited, retry with backoff";
      }
      throw new Error(`Notion API error ${status}: ${errorBody}${hint}`);
    }

    const raw = await res.json();
    const parsed = queryResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Notion API returned malformed response: ${parsed.error.message}`,
      );
    }

    allResults.push(...parsed.data.results);

    startCursor = parsed.data.has_more && parsed.data.next_cursor ? parsed.data.next_cursor : undefined;
  } while (startCursor);

  return allResults;
}