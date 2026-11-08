import { afterEach, expect, test } from "bun:test";
import { buildTavilyMcpUrl } from "./tavilyClient";

const saved = process.env.TAVILY_MCP_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.TAVILY_MCP_URL;
  else process.env.TAVILY_MCP_URL = saved;
});

test("Tavily MCP URL defaults to Tavily and encodes the key", () => {
  delete process.env.TAVILY_MCP_URL;
  expect(buildTavilyMcpUrl("a&b")).toBe("https://mcp.tavily.com/mcp?tavilyApiKey=a%26b");
});

test("TAVILY_MCP_URL replaces the base, without a trailing slash", () => {
  process.env.TAVILY_MCP_URL = "http://proxy.test:8787/tavily/";
  expect(buildTavilyMcpUrl("k")).toBe("http://proxy.test:8787/tavily?tavilyApiKey=k");
});
