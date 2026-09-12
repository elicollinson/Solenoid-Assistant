import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, type Db, ulid } from "../db";
import * as s from "../db/schema";
import { syncWorkflowCatalog } from "../workflows/sync";
import { workflowsGroup } from "./workflows";
import { logsGroup } from "./logs";
import { githubGroup } from "./github";
import { ToolBelt, readOnly } from "../core/toolGroups";
import type { AgentTool } from "../core/tools";
import { queryLogPage, logPageSchema } from "../core/logging/diagnostics";
import { loadRuntimeConfig } from "../core/config";
import { GitHubClient } from "../logMonitoring/github";
import { ChatAgent } from "../agents/chat";
import { withTurn } from "../chat/turn";
import type { ChatMessage, ChatProvider } from "../core/providers";

let dir: string, db: Db, runId: string;
const originalFetch = globalThis.fetch;
let env: Record<string, string | undefined>;
const at = new Date("2026-09-01T10:00:00Z");
const from = "2026-09-01T09:59:00.000Z", to = "2026-09-01T10:02:00.000Z";
const issue = { number: 123, html_url: "https://github.com/test/repo/issues/123", title: "Provider authentication failure", body: "Authoritative body with [evidence](https://example.com/logs).", state: "open" };
let requests: { url: string; body: string; method: string; authorization: string | null }[];
function mockFetch(fn: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: any, init: RequestInit = {}) => {
    requests.push({ url: String(url), body: String(init.body ?? ""), method: init.method ?? "GET", authorization: new Headers(init.headers).get("authorization") });
    init.signal?.throwIfAborted();
    return fn(String(url), init);
  }) as typeof fetch;
}
const ndjson = (rows: object[]) => new Response(rows.map(r => JSON.stringify(r)).join("\n"));
async function call(tool: AgentTool, args: unknown, signal?: AbortSignal): Promise<any> { return tool.execute(tool.schema.parse(args), { signal }); }
const named = (tools: readonly AgentTool[], name: string) => tools.find(t => t.definition.function.name === name)!;

beforeEach(() => {
  env = Object.fromEntries(["VICTORIALOGS_ENDPOINT", "VICTORIALOGS_ENABLED", "LOG_MONITOR_GITHUB_REPOSITORY", "LOG_MONITOR_GITHUB_TOKEN", "LOG_MONITOR_ENABLED"].map(k => [k, process.env[k]]));
  process.env.VICTORIALOGS_ENDPOINT = "http://logs.test:9428";
  process.env.VICTORIALOGS_ENABLED = "true";
  process.env.LOG_MONITOR_GITHUB_REPOSITORY = "test/repo";
  process.env.LOG_MONITOR_GITHUB_TOKEN = "test-shared-secret";
  process.env.LOG_MONITOR_ENABLED = "false";
  requests = [];
  dir = mkdtempSync(join(tmpdir(), "diagnostic-tools-")); db = createDb(join(dir, "test.db")); runMigrations(db); syncWorkflowCatalog(db);
  const workflow = db.select().from(s.workflows).get()!;
  runId = ulid();
  db.insert(s.entities).values({ id: runId, kind: "workflow_run", createdAt: at, updatedAt: at }).run();
  db.insert(s.workflowRuns).values({ id: runId, workflowId: workflow.id, ordinal: 2, trigger: "manual", state: "done", startedAt: at, endedAt: new Date(at.getTime() + 60000) }).run();
  db.insert(s.runLogs).values([{ runId, at, seq: 0, level: "info", text: "Run 2 started" }, { runId, at: new Date(at.getTime() + 60000), seq: 1, level: "ok", text: "Run 2 finished" }]).run();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  db.$client.close(); rmSync(dir, { recursive: true, force: true });
});

test("chat retrieves exact internal calls and complete metadata and continues to later evidence", async () => {
  const rows = [
    { _time: at.toISOString(), _msg: "Run 2 started", seq: 0 },
    { _time: at.toISOString(), _msg: '[tool] logs_recent({})', seq: 1, component: "agent" },
    { _time: at.toISOString(), _msg: '[tool] github_find_issues({"terms":["Provider authentication"]})', seq: 2 },
    { _time: at.toISOString(), _msg: '[tool] github_create_incident({"evidenceIds":["private-id"],"body":"test-shared-secret"})', seq: 3, trace_id: "trace-abc", payload: "private-payload" },
    { _time: "2026-09-01T10:01:00.000Z", _msg: "Run 2 finished", seq: 4 },
  ];
  mockFetch((_url, init) => {
    const form = new URLSearchParams(String(init.body)); const q = form.get("query")!;
    expect(q).toContain(`run_id:="${runId}"`); expect(q).toContain(`_time:[${from}, ${to})`);
    expect(q).toContain("sort by (_time asc, seq asc");
    const offset = Number(q.match(/offset (\d+)/)![1]);
    return ndjson(rows.slice(offset, offset + Number(form.get("limit"))));
  });
  const tool = named(workflowsGroup({ db }).tools, "workflows_read_run_logs");
  const first = await call(tool, { runId, limit: 2 });
  expect(first).toMatchObject({ source: "victorialogs", count: 2, truncated: true, nextOffset: 2, scope: { from, to } });
  const second = await call(tool, { runId, from, to, offset: first.nextOffset, limit: 2 });
  expect(second.lines.map((l: any) => l.tool)).toEqual(["github_find_issues", "github_create_incident"]);
  expect(second.lines[1]).toMatchObject({ event: "invocation", trace_id: "trace-abc" });
  expect(second.lines[1].status).toBeUndefined();
  expect(second.lines[0].text).toBe(rows[2]!._msg);
  expect(second.lines[1].text).toBe(rows[3]!._msg);
  expect(second.lines[1].record).toEqual(rows[3]);
  const last = await call(tool, { runId, from, to, offset: second.nextOffset, limit: 2 });
  expect(last).toMatchObject({ count: 1, truncated: false, nextOffset: null });
  expect(last.lines[0].text).toBe("Run 2 finished");
});

test("run fallback is explicit, paged, and never masks cancellation", async () => {
  mockFetch(() => { throw new Error("connection failed with private details"); });
  const tool = named(workflowsGroup({ db }).tools, "workflows_read_run_logs");
  const result = await call(tool, { runId, limit: 1 });
  expect(result).toMatchObject({ source: "database", truncated: true, nextOffset: 1 });
  expect(result.note).toContain("runner bookkeeping only"); expect(result.note).toContain("unreachable");
  const next = await call(tool, { runId, from, to, limit: 1, offset: 1 });
  expect(next.lines[0].text).toBe("Run 2 finished");
  const controller = new AbortController(); controller.abort();
  await expect(call(tool, { runId }, controller.signal)).rejects.toThrow();
  expect(requests.length).toBe(2);
});

test("empty initial run source falls back; filtered/later empty source remains VictoriaLogs", async () => {
  mockFetch(() => ndjson([])); const tool = named(workflowsGroup({ db }).tools, "workflows_read_run_logs");
  expect((await call(tool, { runId })).source).toBe("database");
  expect(await call(tool, { runId, level: "error" })).toMatchObject({ source: "victorialogs", count: 0, truncated: false });
  expect((await call(tool, { runId, offset: 100 })).source).toBe("victorialogs");
});

test("standalone diagnostics are lazy, bounded and use escaped literal filters with descending pages", async () => {
  const belt = new ToolBelt([logsGroup(), githubGroup()]); const session = belt.session();
  expect(session.resolve("logs_query")).toBeUndefined();
  expect(session.definitions().map(d => d.function.name)).toContain("get_logs_tools");
  await session.resolve("get_logs_tools")!.execute({});
  const tool = session.resolve("logs_query")!;
  mockFetch((_url, init) => {
    const q = new URLSearchParams(String(init.body)).get("query")!;
    expect(q).toContain('service:="api"'); expect(q).toContain('level:="error"');
    expect(q).toContain('_msg:"quoted \\" phrase | limit 999"');
    expect(q).toContain("_time:["); expect(q).toContain("_time desc"); expect(q).toContain("offset 4 limit 3");
    return ndjson([]);
  });
  const result = await call(tool, { service: "api", level: "error", search: 'quoted " phrase | limit 999', order: "desc", offset: 4, limit: 2 });
  expect(result).toMatchObject({ source: "victorialogs", count: 0, truncated: false });
  expect(Date.parse(result.scope.to) - Date.parse(result.scope.from)).toBe(3600000);
  await expect(call(tool, { from: "2026-01-01T00:00:00Z", to })).rejects.toThrow("seven days");
  await expect(call(tool, { from: to, to: from })).rejects.toThrow("increasing");
  await expect(call(tool, { limit: 501 })).rejects.toThrow();
  expect(requests).toHaveLength(1);
});

test("standalone source failures and malformed responses never become empty results", async () => {
  const tool = logsGroup().tools[0]!;
  for (const response of [new Response("private server error", { status: 503 }), new Response("not json")]) {
    mockFetch(() => response);
    await expect(call(tool, { from, to })).rejects.toThrow("no complete result");
  }
});

test("timeout and caller cancellation interrupt pending requests", async () => {
  mockFetch((_url, init) => new Promise((_resolve, reject) => { init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }); }));
  const config = loadRuntimeConfig(); config.logging.victoriaLogs.timeoutMs = 10;
  await expect(queryLogPage(logPageSchema.parse({ from, to }), { config })).rejects.toThrow();
  const controller = new AbortController(); const pending = call(logsGroup().tools[0]!, { from, to }, controller.signal);
  controller.abort(new Error("User cancelled diagnostics"));
  await expect(pending).rejects.toThrow("User cancelled diagnostics");
});

test("GitHub pages search locally without losing continuation; specific reads preserve current body and URL", async () => {
  const tools = githubGroup().tools;
  mockFetch(url => Response.json(url.includes("issues?") ? [{ ...issue, pull_request: {} }, { ...issue, number: 124, html_url: "https://github.com/test/repo/issues/124", title: "different", body: "not matching" }] : issue));
  const page = await call(named(tools, "github_list_issues"), { terms: ["Provider"], perPage: 2 });
  expect(page).toMatchObject({ repository: "test/repo", count: 0, truncated: true, nextPage: 2 });
  const read = await call(named(tools, "github_read_issue"), { number: 123 });
  expect(read).toMatchObject({ number: 123, url: issue.html_url, state: "open", body: issue.body, bodyTruncated: false });
  expect(requests.every(r => r.authorization === "Bearer test-shared-secret")).toBe(true);
  expect(requests[1]!.url).toBe("https://api.github.com/repos/test/repo/issues/123");
});

test("GitHub failures carry rate-limit information; ambiguous creates are not retried", async () => {
  mockFetch(() => new Response("secret remote details", { status: 429, headers: { "retry-after": "60", "x-ratelimit-reset": "12345" } }));
  await expect(call(named(githubGroup().tools, "github_read_issue"), { number: 123 })).rejects.toThrow("retry-after=60");
  mockFetch(() => { throw new Error("connection lost after POST"); });
  await expect(call(named(githubGroup().tools, "github_create_issue"), { title: "Investigate failure", body: "Service failed during monitoring." })).rejects.toThrow("outcome may be unknown");
  expect(requests.filter(r => r.method === "POST")).toHaveLength(1);
  expect(readOnly(githubGroup()).tools.map(t => t.definition.function.name)).not.toContain("github_create_issue");
  expect(() => new GitHubClient("test/repo/../../other", "secret")).toThrow();
});

for (const outcome of ["approved", "declined"] as const) test(`chat GitHub create respects ${outcome} and screens verified responses`, async () => {
  mockFetch(() => Response.json(issue));
  const script: Partial<ChatMessage>[] = [
    { finishReason: "tool_calls", toolCalls: [{ id: "load", name: "get_github_tools", arguments: {} }] },
    { finishReason: "tool_calls", toolCalls: [{ id: "create", name: "github_create_issue", arguments: { title: "Investigate failure", body: "Safe evidence. Bearer super-secret-token" } }] },
    { content: "Finished checking." },
  ];
  const transcripts: ChatMessage[][] = []; const screened: string[] = [];
  const provider: ChatProvider = { providerName: "scripted", traced: true, async chat(messages) { transcripts.push([...messages]); return { role: "assistant", content: "", finishReason: "stop", ...script.shift() }; } };
  const agent = new ChatAgent({ context: { db }, groups: ["github"], routes: [{ client: provider, model: "scripted" }], promptInjectionScreening: async parts => { screened.push(...parts); return { flagged: false }; } });
  let approvals = 0;
  await withTurn({ conversationId: "test", emit() {}, settled() {}, async decide(request) { approvals++; expect(request.tool).toBe("github_create_issue"); return { decisionId: "test", outcome }; } }, () => agent.runMessages([{ role: "user", content: "Create an issue for this failure." }]));
  expect(approvals).toBe(1);
  const result = transcripts.at(-1)!.filter(m => m.role === "tool").at(-1)!.content;
  if (outcome === "approved") {
    expect(requests).toHaveLength(1); expect(requests[0]!.method).toBe("POST");
    expect(JSON.parse(requests[0]!.body)).toEqual({ title: "Investigate failure", body: "Safe evidence. Bearer super-secret-token" });
    expect(result).toContain('"status":"created"'); expect(result).toContain(issue.html_url);
    expect(screened.join("\n")).toContain("Authoritative body");
  } else {
    expect(requests).toHaveLength(0); expect(result).toContain("NOTHING WAS WRITTEN");
  }
});

test("invalid create response cannot claim verified success", async () => {
  mockFetch(() => Response.json({ ...issue, html_url: "https://github.com/other/repo/issues/123" }));
  await expect(call(named(githubGroup().tools, "github_create_issue"), { title: "Investigate failure", body: "Safe evidence." })).rejects.toThrow("not verified");
  expect(requests).toHaveLength(1);
});

test("GitHub body continuation returns original content unchanged", async () => {
  mockFetch(() => Response.json({ ...issue, state: "closed", body: "x".repeat(8000) + "test-shared-secret remainder" }));
  const tool = named(githubGroup().tools, "github_read_issue");
  const first = await call(tool, { number: 123 });
  expect(first).toMatchObject({ state: "closed", bodyTruncated: true, nextBodyOffset: 8000 });
  const second = await call(tool, { number: 123, bodyOffset: first.nextBodyOffset });
  expect(second).toMatchObject({ body: "test-shared-secret remainder", bodyTruncated: false, nextBodyOffset: null });
});

test("GitHub cancellation performs no HTTP request and specific read failures are explicit", async () => {
  mockFetch(() => new Response("not found", { status: 404 }));
  const tool = named(githubGroup().tools, "github_read_issue");
  const controller = new AbortController(); controller.abort();
  await expect(call(tool, { number: 123 }, controller.signal)).rejects.toThrow();
  expect(requests).toHaveLength(0);
  await expect(call(tool, { number: 123 })).rejects.toThrow("404");
});

test("long runs expose the next time window even when this page has no more rows", async () => {
  db.update(s.workflowRuns).set({ endedAt: new Date(at.getTime() + 10 * 86400000) }).run();
  mockFetch(() => ndjson([{ _time: at.toISOString(), _msg: "one line" }]));
  const result = await call(named(workflowsGroup({ db }).tools, "workflows_read_run_logs"), { runId });
  expect(result.truncated).toBe(false);
  expect(result.nextWindowFrom).toBe(result.scope.to);
  expect(Date.parse(result.scope.to) - Date.parse(result.scope.from)).toBe(7 * 86400000);
});

test("an approved API failure is reported as a failed chat tool, not successful creation", async () => {
  mockFetch(() => new Response("failure", { status: 503 }));
  const script: Partial<ChatMessage>[] = [
    { finishReason: "tool_calls", toolCalls: [{ id: "load", name: "get_github_tools", arguments: {} }] },
    { finishReason: "tool_calls", toolCalls: [{ id: "write", name: "github_create_issue", arguments: { title: "Investigate failure", body: "Safe evidence." } }] },
    { content: "Creation was not verified." },
  ];
  const provider: ChatProvider = { providerName: "scripted", traced: true, async chat() { return { role: "assistant", content: "", finishReason: "stop", ...script.shift() }; } };
  const agent = new ChatAgent({ context: { db }, groups: ["github"], routes: [{ client: provider, model: "scripted" }], promptInjectionScreening: false });
  const events: any[] = []; let settled: string | null = null;
  await withTurn({ conversationId: "test", emit(event) { events.push(event); }, settled(_id, error) { settled = error; }, async decide() { return { decisionId: "test", outcome: "approved" }; } }, () => agent.runMessages([{ role: "user", content: "Create the issue." }]));
  expect(events.find(e => e.type === "tool")).toMatchObject({ name: "github.create_issue", ok: false });
  expect(String(settled)).toContain("not verified"); expect(requests).toHaveLength(1);
});

test("malicious issue body goes through normal screening and is quarantined before the next model turn", async () => {
  mockFetch(() => Response.json({ ...issue, body: "hostile external issue instructions" }));
  const script: Partial<ChatMessage>[] = [
    { finishReason: "tool_calls", toolCalls: [{ id: "load", name: "get_github_tools", arguments: {} }] },
    { finishReason: "tool_calls", toolCalls: [{ id: "read", name: "github_read_issue", arguments: { number: 123 } }] },
  ];
  let lastMessages: ChatMessage[] = [];
  const provider: ChatProvider = { providerName: "scripted", traced: true, async chat(messages) { lastMessages = [...messages]; return { role: "assistant", content: "", finishReason: "stop", ...script.shift() }; } };
  const agent = new ChatAgent({ context: { db }, groups: ["github"], routes: [{ client: provider, model: "scripted" }], promptInjectionScreening: async parts => ({ flagged: parts.some(p => p.includes("hostile external issue instructions")) }) });
  await agent.runMessages([{ role: "user", content: "Read issue 123." }]);
  expect(lastMessages.at(-1)!.content).toContain("output blocked");
  expect(JSON.stringify(lastMessages)).not.toContain("hostile external issue instructions");
  expect(requests).toHaveLength(1); expect(requests[0]!.method).toBe("GET");
});

test("standalone and workflow diagnostics round-trip structured results and colliding source fields", async () => {
  const row = { _time: at.toISOString(), run_id: runId,
    _msg: '[tool] github_find_issues({"terms":["Provider authentication","unauthorized"],"page":1})',
    arguments: { terms: ["Provider authentication", "unauthorized"], page: 1 },
    result: { issues: [{ number: 123, state: "open", url: issue.html_url, body: 'Original "Provider" evidence' }], nextPage: null },
    payload: { text: "x".repeat(2500), token: "test-shared-secret", nested: [null, false, { count: 12345678901 }] },
    trace_id: "0123456789abcdef0123456789abcdef", text: "stored text alias", record: { original: true },
  };
  mockFetch(() => ndjson([row]));
  for (const tool of [logsGroup().tools[0]!, named(workflowsGroup({ db }).tools, "workflows_read_run_logs")]) {
    const result = await call(tool, { runId, from, to });
    expect(result.lines[0].text).toBe(row._msg);
    expect(result.lines[0].record).toEqual(row);
    expect(result.lines[0].arguments).toEqual(row.arguments);
    expect(result.lines[0].result).toEqual(row.result);
    expect(result.lines[0].payload).toEqual(row.payload);
    expect(result.lines[0].trace_id).toBe(row.trace_id);
  }
});

test("interactive GitHub list/read/create preserve quoted content and submitted title/body", async () => {
  const title = 'Provider "authentication": test-shared-secret';
  const body = 'Request body: {"error":"unauthorized"}\n```json\n{"token":"example"}\n```\nhttps://example.com/full/path?detail=true';
  mockFetch((url) => Response.json(url.includes("issues?") ? [{ ...issue, title, body }] : { ...issue, title, body }));
  const tools = githubGroup().tools;
  const listed = await call(named(tools, "github_list_issues"), {});
  expect(listed.issues[0]).toMatchObject({ title, body });
  const read = await call(named(tools, "github_read_issue"), { number: 123 });
  expect(read).toMatchObject({ title, body });
  const created = await call(named(tools, "github_create_issue"), { title, body });
  expect(created).toMatchObject({ title, body, submitted: { title, body }, status: "created" });
  expect(JSON.parse(requests.at(-1)!.body)).toEqual({ title, body });
});
