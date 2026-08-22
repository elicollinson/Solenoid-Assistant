// Notion MCP connection cache.
//
// The Notion OAuth connection is expensive to establish (discovery + transport
// handshake), and the access token rotates on refresh. This module connects
// once at app startup, calls `notion-fetch` with `id: "self"` to verify the
// workspace and cache identity info, and keeps the live MCP `Client` around for
// any agent that needs Notion tools. Callers get the shared client via
// `getNotionMcpClient()` rather than opening their own connection.
//
// The `notion-fetch` result is also cached — it contains the workspace name,
// user info, and current tool-access status, which may be useful for other
// agents or endpoints.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { NotionMcpClient } from "./notionClient";
import { log } from "../core/logger";
import { isMcpAuthError } from "./errors";

// ---------------------------------------------------------------------------
// Cached state
// ---------------------------------------------------------------------------

let cachedClient: Client | undefined;
let cachedFetchResult: NotionFetchSelfResult | undefined;
let initPromise: Promise<NotionMcpCache> | undefined;

// ---------------------------------------------------------------------------
// Types (Zod schemas → inferred types)
// ---------------------------------------------------------------------------

/** Zod schema for the `notion-fetch` `{ id: "self" }` response. */
export const notionFetchSelfResultSchema = z.object({
  self: z
    .object({
      workspace: z.object({ id: z.string(), name: z.string() }).optional(),
      user: z
        .object({
          id: z.string(),
          name: z.string(),
          type: z.string(),
          email: z.string(),
        })
        .optional(),
      current_tool_access: z
        .record(
          z.string(),
          z.object({
            status: z.string(),
            upgrade_url: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

/** Parsed shape of the `notion-fetch` `{ id: "self" }` response. */
export type NotionFetchSelfResult = z.infer<typeof notionFetchSelfResultSchema>;

/** Zod schema for the `callTool` result content array (only the fields we read). */
const callToolResultSchema = z.object({
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .optional(),
});

export interface NotionMcpCache {
  /** The live MCP client — keep alive while Notion tools are in use. */
  client: Client;
  /** The parsed `notion-fetch` self result, or undefined if the fetch failed. */
  fetchResult: NotionFetchSelfResult | undefined;
}

// ---------------------------------------------------------------------------
// Initialization (call once at startup)
// ---------------------------------------------------------------------------

/**
 * Connects to the Notion MCP server, calls `notion-fetch` with `id: "self"` to
 * verify the workspace, and caches both the client and the fetch result.
 *
 * Safe to call multiple times — subsequent calls return the existing cache.
 * If the initial connection fails, the error propagates but the cache is
 * left empty so a later retry is possible.
 *
 * @example
 *   // At app startup (src/index.ts):
 *   await initNotionMcpCache().catch((err) => log.warn("Notion cache init failed", { error: err }));
 */
export async function initNotionMcpCache(): Promise<NotionMcpCache> {
  // Already initialized — return immediately.
  if (cachedClient) {
    return { client: cachedClient, fetchResult: cachedFetchResult };
  }

  // De-duplicate concurrent callers.
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const notionClient = new NotionMcpClient();
    await notionClient.initialize();

    if (!notionClient.hasTokens) {
      throw new Error(
        "Notion MCP tokens not found in .env — run `bun run scripts/notion-mcp-auth.ts` first.",
      );
    }

    log.info("Connecting to Notion MCP server for cache initialization...");
    const client = await notionClient.connect();
    cachedClient = client;

    // Verify the connection and cache workspace identity info.
    try {
      const result = await client.callTool({
        name: "notion-fetch",
        arguments: { id: "self" },
      });

      const resultParsed = callToolResultSchema.safeParse(result);
      if (!resultParsed.success) {
        log.warn("Notion fetch returned malformed callTool result (non-fatal)", {
          error: resultParsed.error.message,
        });
      } else {
        const text = resultParsed.data.content?.[0]?.text;
        if (text) {
          const fetchParsed = notionFetchSelfResultSchema.safeParse(
            JSON.parse(text),
          );
          if (fetchParsed.success) {
            cachedFetchResult = fetchParsed.data;
          } else {
            log.warn(
              "Notion fetch returned malformed self result (non-fatal)",
              { error: fetchParsed.error.message },
            );
          }
        }
      }

      const ws = cachedFetchResult?.self?.workspace;
      log.info("Notion MCP cache initialized", {
        workspace: ws ? `${ws.name} (${ws.id})` : "unknown",
      });
    } catch (err) {
      // Non-fatal: the client is still usable for other tools. The fetch
      // result just won't be available.
      log.warn("Notion fetch on startup failed (non-fatal — client still cached)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { client: cachedClient, fetchResult: cachedFetchResult };
  })();

  try {
    return await initPromise;
  } finally {
    // Clear the promise so a failed init can be retried on the next call.
    // On success, cachedClient is set so the early return at the top handles
    // subsequent calls without re-entering here.
    initPromise = undefined;
  }
}

// ---------------------------------------------------------------------------
// Auth-error detection (shared with callers)
// ---------------------------------------------------------------------------

/**
 * Detects whether an error from the Notion MCP server is auth-related
 * (expired/invalid access token). Used by callers to decide whether to retry
 * with {@link reconnectNotionMcpCache}.
 *
 * Notion returns `{"error":"invalid_token","error_description":"Invalid access token"}`
 * when the access token has expired — this does NOT contain "401" or
 * "unauthorized", so we check for `invalid_token` and `Invalid access token`
 * in addition to the standard HTTP auth indicators.
 */
export function isNotionAuthError(error: unknown): boolean {
  return isMcpAuthError(error);
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * Returns the cached Notion MCP client, or `undefined` if the cache has not
 * been initialized (or initialization failed). Callers should NOT close this
 * client — it is shared and managed by the cache.
 */
export function getNotionMcpClient(): Client | undefined {
  return cachedClient;
}

/**
 * Returns the cached `notion-fetch` self result, or `undefined` if the cache
 * has not been initialized or the startup fetch failed.
 */
export function getNotionFetchResult(): NotionFetchSelfResult | undefined {
  return cachedFetchResult;
}

/** Close and clear the shared client during application shutdown. */
export async function shutdownNotionMcpCache(): Promise<void> {
  const client = cachedClient;
  cachedClient = undefined;
  cachedFetchResult = undefined;
  initPromise = undefined;
  reconnectPromise = undefined;
  await client?.close().catch(() => {});
}

// ---------------------------------------------------------------------------
// Reconnection (for runtime token expiry)
// ---------------------------------------------------------------------------

let reconnectPromise: Promise<NotionMcpCache> | undefined;

/**
 * Clears the stale cached client and re-initializes the cache with a fresh
 * Notion MCP connection. The `NotionMcpClient.connect()` method will
 * auto-refresh the expired access token via the refresh token before
 * reconnecting.
 *
 * Use this when a tool call on the cached client fails with an auth error
 * (expired token during runtime — the server has been running long enough
 * for the ~8h access token to expire). After reconnection, the new client is
 * cached and subsequent `getNotionMcpClient()` calls return it.
 *
 * Concurrent callers are de-duplicated — only one reconnection happens at a
 * time.
 */
export async function reconnectNotionMcpCache(): Promise<NotionMcpCache> {
  // De-duplicate concurrent reconnect callers.
  if (reconnectPromise) return reconnectPromise;

  reconnectPromise = (async () => {
    // Try to close the stale client (best-effort — it may already be broken).
    if (cachedClient) {
      try {
        await cachedClient.close();
      } catch {
        // Ignore — the connection is likely already dead.
      }
    }

    // Reset cache state so initNotionMcpCache re-enters the connection logic.
    cachedClient = undefined;
    cachedFetchResult = undefined;
    initPromise = undefined;

    log.info("Reconnecting to Notion MCP server (token likely expired)...");
    const cache = await initNotionMcpCache();
    log.info("Notion MCP cache reconnected successfully");
    return cache;
  })();

  try {
    return await reconnectPromise;
  } finally {
    reconnectPromise = undefined;
  }
}
