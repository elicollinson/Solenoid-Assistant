import { describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectAndLoadMcpTools, loadMcpTools } from "./adapter";

describe("MCP tool adapter", () => {
  test("filters tools and joins text content", async () => {
    const client = {
      listTools: async () => ({
        tools: [
          { name: "keep", description: "kept", inputSchema: { type: "object" } },
          { name: "drop", description: "dropped", inputSchema: { type: "object" } },
        ],
      }),
      callTool: async () => ({
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "ignored" },
          { type: "text", text: "second" },
        ],
      }),
    } as unknown as Client;

    const tools = await loadMcpTools(client, ["keep"]);
    expect(tools.map((tool) => tool.definition.function.name)).toEqual(["keep"]);
    expect(await tools[0]!.execute({})).toBe("first\n[image content]\nsecond");
  });

  test("closes a newly connected client when tool discovery fails", async () => {
    let closed = false;
    const client = {
      listTools: async () => {
        throw new Error("discovery failed");
      },
      close: async () => {
        closed = true;
      },
    } as unknown as Client;

    expect(connectAndLoadMcpTools(async () => client)).rejects.toThrow(/discovery failed/);
    expect(closed).toBe(true);
  });
});
