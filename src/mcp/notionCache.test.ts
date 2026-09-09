import { afterEach, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getNotionMcpClient,
  getNotionMcpHealth,
  initNotionMcpCache,
  isNotionAuthError,
  shutdownNotionMcpCache,
} from "./notionCache";
import {
  isNotionAuthenticationRequiredError,
  NotionAuthenticationRequiredError,
} from "./errors";

afterEach(async () => {
  await shutdownNotionMcpCache();
});

function client(options: { self?: unknown; error?: Error; closed?: () => void } = {}): Client {
  return {
    callTool: async () => {
      if (options.error) throw options.error;
      return {
        content: [{ type: "text", text: JSON.stringify(options.self ?? {}) }],
      };
    },
    close: async () => options.closed?.(),
  } as unknown as Client;
}

function connection(mcpClient: Client, hasTokens = true) {
  return {
    hasTokens,
    initialize: async () => {},
    connect: async () => mcpClient,
  };
}

describe("Notion MCP cache health", () => {
  test("reports reconnect-required credentials without exposing credential values", async () => {
    const error = await initNotionMcpCache({
      createConnection: () => connection(client(), false),
    }).catch((caught) => caught);

    expect(isNotionAuthenticationRequiredError(error)).toBe(true);
    expect(isNotionAuthError(error)).toBe(true);
    expect(getNotionMcpHealth()).toEqual({
      status: "authentication_required",
      reason: "missing_credentials",
      recovery: "bun run auth:notion; restart service",
    });
    expect(JSON.stringify(getNotionMcpHealth())).not.toContain("TOKEN");
  });

  test("does not cache a client whose self-check reports revoked authentication", async () => {
    let closed = false;
    const stale = client({
      error: new Error('{"error":"invalid_token","error_description":"Invalid access token"}'),
      closed: () => { closed = true; },
    });

    const error = await initNotionMcpCache({
      createConnection: () => connection(stale),
    }).catch((caught) => caught);

    expect(isNotionAuthenticationRequiredError(error)).toBe(true);
    expect(closed).toBe(true);
    expect(getNotionMcpClient()).toBeUndefined();
    expect(getNotionMcpHealth()).toMatchObject({
      status: "authentication_required",
      reason: "refresh_rejected",
    });
  });

  test("retries successfully after credentials are refreshed", async () => {
    let attempts = 0;
    const fresh = client({
      self: { self: { workspace: { id: "workspace-id", name: "Workspace" } } },
    });
    const createConnection = () => {
      attempts++;
      if (attempts === 1) {
        return {
          hasTokens: true,
          initialize: async () => {},
          connect: async () => { throw new NotionAuthenticationRequiredError("refresh_rejected"); },
        };
      }
      return connection(fresh);
    };

    await expect(initNotionMcpCache({ createConnection })).rejects.toBeInstanceOf(
      NotionAuthenticationRequiredError,
    );
    const recovered = await initNotionMcpCache({ createConnection });

    expect(attempts).toBe(2);
    expect(recovered.client).toBe(fresh);
    expect(getNotionMcpHealth()).toEqual({ status: "ready", workspaceConnected: true });
  });

  test("distinguishes transient initialization failure from authentication", async () => {
    const error = await initNotionMcpCache({
      createConnection: () => ({
        hasTokens: true,
        initialize: async () => { throw new TypeError("network details omitted"); },
        connect: async () => client(),
      }),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(TypeError);
    expect(getNotionMcpHealth()).toEqual({ status: "unavailable", reason: "TypeError" });
  });
});
