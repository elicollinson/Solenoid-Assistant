import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, type Db } from "../db";
import * as s from "../db/schema";
import { createReminder, reviseReminder, completeReminder, dismissReminder } from "../db/mutations/reminders";
import { loadReminder, loadReminders } from "../db/queries/reminders";
import { loadPushoverConfig, pushoverStatus } from "./config";
import { messageSchema, PushoverClient, type PushClient, type PushMessage, type PushResult } from "./client";
import { deliverDueReminder, expireSubmissions, sendPush, STALE_SUBMISSION_MS } from "./delivery";
import { pushoverGroup } from "../tools/pushover";
import { readOnly } from "../core/toolGroups";
import { ChatAgent } from "../agents/chat";
import { withTurn } from "../chat/turn";
import type { ChatMessage, ChatProvider } from "../core/providers";
import { validatePushover } from "../../scripts/pushover-validate";

const settings = { PUSHOVER_ENABLED: "true", PUSHOVER_REMINDERS_ENABLED: "true", PUSHOVER_APP_TOKEN: "A".repeat(30), PUSHOVER_USER_KEY: "U".repeat(30) };
const config = loadPushoverConfig(settings);
const accepted: PushResult = { status: "accepted", code: "queued", providerRequestId: "request-123" };
let dir: string, db: Db, now: number, messages: PushMessage[];
let env: Record<string, string | undefined>;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-push-")); db = createDb(join(dir, "test.db")); runMigrations(db);
  now = Date.parse("2026-09-12T15:00:00Z"); messages = [];
  env = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  for (const key of Object.keys(settings)) delete process.env[key];
});
afterEach(() => { globalThis.fetch = originalFetch; Object.entries(env).forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; }); db.$client.close(); rmSync(dir, { recursive: true, force: true }); });
const fake = (result: PushResult = accepted): PushClient => ({ async send(message) { messages.push(message); return result; } });
const due = (offset = 0, title = "Take the bread out") => createReminder(db, { title, dueAt: new Date(now + offset), setBy: "user" }, new Date(now - 1000));
const rows = () => db.select().from(s.pushDeliveries).all();
const deliver = (client = fake(), database = db) => deliverDueReminder(database, { config, client, now: () => now });

test("configuration is optional, locally validated and never exposes credentials", () => {
  expect(pushoverStatus(loadPushoverConfig({}))).toMatchObject({ enabled: false, ready: false, remindersReady: false });
  expect(pushoverStatus(config)).toMatchObject({ ready: true, remindersReady: true, networkValidated: false });
  const malformed = loadPushoverConfig({ ...settings, PUSHOVER_USER_KEY: "secret-invalid", PUSHOVER_TIMEOUT_MS: "oops" });
  expect(pushoverStatus(malformed)).toMatchObject({ ready: false, invalid: ["PUSHOVER_USER_KEY", "PUSHOVER_TIMEOUT_MS"] });
  expect(JSON.stringify(pushoverStatus(malformed))).not.toContain("secret-invalid");
  expect(pushoverStatus(loadPushoverConfig({ ...settings, PUSHOVER_REMINDERS_ENABLED: "false" })).remindersReady).toBe(false);
});

test("create schedules exactly at due time; acceptance never completes the reminder", async () => {
  const id = due(1000);
  expect(await deliver()).toBeNull(); expect(messages).toHaveLength(0);
  now += 1000;
  expect(await deliver()).toMatchObject({ status: "accepted" });
  expect(messages).toEqual([{ title: "Solenoid reminder", message: "Take the bread out" }]);
  expect(await deliver()).toBeNull(); expect(messages).toHaveLength(1);
  expect(loadReminders(db, new Date(now + 1)).rows.find(r => r.id === id)?.group).toBe("Overdue");
  expect(loadReminder(db, id, new Date(now))?.meta).toContainEqual({ label: "Push", value: "Accepted by Pushover; device delivery unverified" });
});

test("disabled or incomplete setup leaves due reminders queued and visible until enabled", async () => {
  const id = due(-1000);
  for (const cfg of [loadPushoverConfig({}), loadPushoverConfig({ PUSHOVER_ENABLED: "true", PUSHOVER_REMINDERS_ENABLED: "true" }), { ...config, remindersEnabled: false }]) {
    expect(await deliverDueReminder(db, { config: cfg, client: fake(), now: () => now })).toBeNull();
  }
  expect(rows()[0]?.state).toBe("pending"); expect(messages).toHaveLength(0);
  expect(loadReminder(db, id, new Date(now))?.meta.some(m => m.label === "Push" && m.value.includes("disabled"))).toBe(true);
  expect(await deliver()).toMatchObject({ status: "accepted" });
});

test("edits use latest title, reschedules replace pending sends, and snoozes notify again", async () => {
  const id = due(); reviseReminder(db, id, { title: "Take the cake out", dueAt: new Date(now + 60000) });
  expect(await deliver()).toBeNull();
  now += 60000; await deliver();
  expect(messages[0]?.message).toBe("Take the cake out");
  reviseReminder(db, id, { title: "A wording correction" });
  expect(await deliver()).toBeNull();
  reviseReminder(db, id, { dueAt: new Date(now + 1000) }); now += 1000;
  await deliver(); expect(messages).toHaveLength(2);
  expect(rows().map(r => r.state).sort()).toEqual(["accepted", "accepted", "cancelled"]);
});

test("rescheduling away and back to the same timestamp is a new occurrence", async () => {
  const id = due(); await deliver();
  reviseReminder(db, id, { dueAt: new Date(now + 1000) });
  reviseReminder(db, id, { dueAt: new Date(now) });
  await deliver(); expect(messages).toHaveLength(2);
});

test("Someday, cleared dates, completion and dismissal never dispatch", async () => {
  createReminder(db, { title: "Someday" });
  const clear = due(); reviseReminder(db, clear, { dueAt: null });
  const complete = due(); completeReminder(db, complete);
  const dismiss = due(); dismissReminder(db, dismiss, "No longer needed");
  expect(await deliver()).toBeNull(); expect(messages).toHaveLength(0);
  expect(rows().every(r => r.state === "cancelled")).toBe(true);
});

test("stored snoozedUntil delays dispatch; all-day uses its stored instant without timezone conversion", async () => {
  const id = due(); db.update(s.reminders).set({ snoozedUntil: new Date(now + 1000), allDay: true }).where(eq(s.reminders.id, id)).run();
  expect(await deliver()).toBeNull(); now += 1000;
  await deliver(); expect(messages).toHaveLength(1);
});

test("overdue reminders catch up after restart; accepted delivery is durable", async () => {
  due(-600000); db.$client.close(); db = createDb(join(dir, "test.db")); runMigrations(db);
  await deliver(); db.$client.close(); db = createDb(join(dir, "test.db"));
  expect(await deliver()).toBeNull(); expect(messages).toHaveLength(1);
});

test("two database connections cannot dispatch the same occurrence or concurrent pushes", async () => {
  due(); due();
  const second = createDb(join(dir, "test.db"));
  let release!: (result: PushResult) => void;
  const first = deliver({ send: async message => { messages.push(message); return new Promise(resolve => { release = resolve; }); } });
  try {
    expect(await deliver(fake(), second)).toBeNull();
    await expect(sendPush(second, "chat-send-1", { message: "Test" }, { config, client: fake(), now: () => now })).rejects.toThrow("busy");
    release(accepted); await first;
    await deliver(fake(), second); expect(messages).toHaveLength(2);
  } finally { second.$client.close(); }
});

test("unknown transport outcomes never resend, while the internal reminder remains overdue", async () => {
  const id = due(-1000);
  await deliver({ async send() { messages.push({ message: "attempt" }); throw new Error("private response body"); } });
  now += 3600000;
  expect(await deliver()).toBeNull(); expect(rows()[0]?.state).toBe("unknown");
  expect(loadReminders(db, new Date(now)).rows.find(r => r.id === id)?.group).toBe("Overdue");
  expect(loadReminder(db, id, new Date(now))?.history.some(h => h.text.includes("unknown"))).toBe(true);
  expect(messages).toHaveLength(1);
});

test("crashed reservations become unknown, never reclaimable", async () => {
  due(); db.update(s.pushDeliveries).set({ state: "submitting", updatedAt: now, attempts: 1 }).run();
  now += STALE_SUBMISSION_MS;
  expireSubmissions(db, now); expect(await deliver()).toBeNull(); expect(rows()[0]?.state).toBe("unknown");
  expect(messages).toHaveLength(0);
});

test("migration backfills open dated reminders, excluding closed and Someday", async () => {
  const folder = join(dir, "old-migrations"); mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 8);
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) copyFileSync(`drizzle/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`));
  const previous = createDb(join(dir, "previous.db"));
  try {
    runMigrations(previous, folder);
    createReminder(previous, { title: "Existing overdue", dueAt: new Date(now - 1000) });
    createReminder(previous, { title: "Existing someday" });
    const closed = createReminder(previous, { title: "Already finished", dueAt: new Date(now) }); completeReminder(previous, closed);
    runMigrations(previous);
    expect(previous.select().from(s.pushDeliveries).all()).toHaveLength(1);
    await deliver(fake(), previous); expect(messages[0]?.message).toBe("Existing overdue");
  } finally { previous.$client.close(); }
});

test("definite quota rejection waits for shared reset, then retries without duplicate acceptance", async () => {
  due();
  const reset = now + 60000;
  await deliver(fake({ status: "rejected", code: "quota_exceeded", providerRequestId: null, httpStatus: 429, quota: { limit: 10000, remaining: 0, resetAt: reset / 1000 } }));
  expect(rows()[0]?.state).toBe("pending");
  due(); expect(await deliver()).toBeNull();
  now = reset; await deliver(); await deliver();
  expect(rows().every(r => r.state === "accepted")).toBe(true); expect(messages).toHaveLength(3);
});

test("other rejections remain visible and do not loop", async () => {
  due(); await deliver(fake({ status: "rejected", code: "request_rejected", httpStatus: 400, providerRequestId: null }));
  now += 60000; expect(await deliver()).toBeNull(); expect(rows()[0]?.state).toBe("rejected");
});

test("closing during rejected quota request cannot resurrect a pending reminder", async () => {
  const id = due();
  await deliver({ async send() { completeReminder(db, id); return { status: "rejected", code: "quota_exceeded", httpStatus: 429, providerRequestId: null }; } });
  expect(rows()[0]?.state).toBe("cancelled"); now += 3600000; expect(await deliver()).toBeNull();
});

test("completion during an accepted request remains closed and history does not claim otherwise", async () => {
  const id = due();
  await deliver({ async send() { completeReminder(db, id); return accepted; } });
  const reminder = loadReminder(db, id, new Date(now));
  expect(reminder?.group).toBe("Closed");
  expect(reminder?.history.some(h => h.text.includes("Push accepted"))).toBe(true);
  expect(reminder?.history.some(h => h.text.includes("remains open"))).toBe(false);
});

test("reschedule during quota rejection cancels the old attempt and preserves the new occurrence", async () => {
  const id = due();
  await deliver({ async send() {
    reviseReminder(db, id, { dueAt: new Date(now + 60000) });
    return { status: "rejected", code: "quota_exceeded", httpStatus: 429, providerRequestId: null };
  } });
  expect(rows().map(r => r.state).sort()).toEqual(["cancelled", "pending"]);
});

test("pre-dispatch cancellation leaves scheduled work pending; safe failures can retry", async () => {
  due(); const controller = new AbortController(); controller.abort();
  expect(await deliverDueReminder(db, { config, client: fake(), signal: controller.signal, now: () => now })).toBeNull();
  expect(rows()[0]?.attempts).toBe(0);
  await deliver(fake({ status: "not_sent", code: "cancelled_before_send", providerRequestId: null }));
  expect(rows()[0]?.state).toBe("pending");
  now += 60000; await deliver(); expect(rows()[0]?.state).toBe("accepted");
});

test("long Unicode titles produce one bounded push and preserve the reminder", async () => {
  const title = "🧁".repeat(1200); const id = due(0, title); await deliver();
  expect([...messages[0]!.message]).toHaveLength(1024); expect(messages[0]?.message.endsWith("…")).toBe(true);
  expect(loadReminder(db, id)?.title).toBe(title);
});

test("manual deduplication survives restart and refuses changed payloads", async () => {
  await sendPush(db, "manual-123", { message: "Test" }, { config, client: fake(), now: () => now });
  db.$client.close(); db = createDb(join(dir, "test.db"));
  expect(await sendPush(db, "manual-123", { message: "Test" }, { config, client: fake(), now: () => now })).toMatchObject({ duplicateSuppressed: true });
  await expect(sendPush(db, "manual-123", { message: "Changed" }, { config, client: fake(), now: () => now })).rejects.toThrow("different");
  expect(messages).toHaveLength(1);
});

test("manual unknown remains protected; pre-dispatch failure can reuse its ID safely", async () => {
  const options = { config, client: fake({ status: "unknown", code: "acceptance_unverified", providerRequestId: null }), now: () => now };
  await expect(sendPush(db, "unknown-123", { message: "Test" }, options)).rejects.toThrow("unknown");
  await expect(sendPush(db, "unknown-123", { message: "Test" }, { ...options, client: fake() })).rejects.toThrow("no duplicate");
  expect(messages).toHaveLength(1);
  await expect(sendPush(db, "unsent-123", { message: "Test" }, { ...options, client: fake({ status: "not_sent", code: "cancelled_before_send", providerRequestId: null }) })).rejects.toThrow("not_sent");
  now += 60000;
  expect(await sendPush(db, "unsent-123", { message: "Test" }, { ...options, client: fake() })).toMatchObject({ status: "accepted" });
});

test("schema validates Unicode lengths, safe URLs and rejects extra fields", () => {
  expect(messageSchema.safeParse({ message: "🧁".repeat(1024) }).success).toBe(true);
  for (const message of [" ", "x".repeat(1025), "\ud800"]) expect(messageSchema.safeParse({ message }).success).toBe(false);
  for (const input of [{ message: "Test", token: "injected" }, { message: "Test", url: "javascript:alert(1)" },
    { message: "Test", url: "https://user:password@example.com" }, { message: "Test", urlTitle: "No URL" }]) expect(messageSchema.safeParse(input).success).toBe(false);
});

test("HTTP client sends one fixed request, preserving text and omitting noisy overrides", async () => {
  let calls = 0;
  const client = new PushoverClient(config, (async (url: string | URL | Request, init?: RequestInit) => {
    calls++; expect(url).toBe("https://api.pushover.net/1/messages.json"); expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ token: settings.PUSHOVER_APP_TOKEN, user: settings.PUSHOVER_USER_KEY, message: "Line 1\nLine 2", title: "A title", url: "https://example.com/", url_title: "Open" });
    return Response.json({ status: 1, request: "req-1" }, { headers: { "X-Limit-App-Remaining": "99" } });
  }) as unknown as typeof fetch);
  expect(await client.send({ message: "Line 1\nLine 2", title: "A title", url: "https://example.com/", urlTitle: "Open" })).toMatchObject({ status: "accepted", quota: { remaining: 99, limit: null, resetAt: null } });
  expect(calls).toBe(1);
});

test("HTTP failures are bounded, sanitized and never retried", async () => {
  for (const [response, outcome] of [[new Response("secret", { status: 500 }), "unknown"], [new Response("not json"), "unknown"],
    [new Response("private", { status: 400 }), "rejected"], [Response.json({ status: 0, errors: [settings.PUSHOVER_APP_TOKEN] }), "rejected"],
    [Response.json({ status: 1, request: `prefix-${settings.PUSHOVER_USER_KEY}` }), "accepted"], [new Response("x".repeat(20000)), "unknown"]] as const) {
    let calls = 0;
    const client = new PushoverClient(config, (async () => { calls++; return response; }) as unknown as typeof fetch);
    const result = await client.send({ message: "Test" });
    expect(result.status).toBe(outcome); expect(JSON.stringify(result)).not.toContain(settings.PUSHOVER_APP_TOKEN);
    expect(JSON.stringify(result)).not.toContain(settings.PUSHOVER_USER_KEY); expect(calls).toBe(1);
  }
});

test("cancellation before dispatch makes no HTTP request; cancellation after dispatch is unknown", async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const client = new PushoverClient(config, (async () => { calls++; return new Promise(() => {}); }) as unknown as typeof fetch);
  expect((await client.send({ message: "Test" }, controller.signal)).status).toBe("not_sent"); expect(calls).toBe(0);
  const during = new AbortController(); const pending = client.send({ message: "Test" }, during.signal); during.abort();
  expect((await pending).status).toBe("unknown"); expect(calls).toBe(1);
});

test("deadline covers a stalled response body", async () => {
  const client = new PushoverClient({ ...config, timeoutMs: 10 }, (async () => new Response(new ReadableStream({ start() {} }))) as unknown as typeof fetch);
  expect((await client.send({ message: "Test" })).status).toBe("unknown");
});

test("operator validation checks configured recipient without enablement or sending", async () => {
  let calls = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++; expect(url).toBe("https://api.pushover.net/1/users/validate.json");
    expect(JSON.parse(String(init?.body))).toEqual({ token: settings.PUSHOVER_APP_TOKEN, user: settings.PUSHOVER_USER_KEY });
    return Response.json({ status: 1, devices: ["private-device-name"] });
  }) as unknown as typeof fetch;
  expect(await validatePushover(fetchFn, {})).toMatchObject({ valid: false }); expect(calls).toBe(0);
  const result = await validatePushover(fetchFn, { ...settings, PUSHOVER_ENABLED: "false" });
  expect(result).toMatchObject({ valid: true, activeDevices: 1 }); expect(JSON.stringify(result)).not.toContain("private-device-name");
  expect(calls).toBe(1);
});

test("catalog read-only form is useful and direct writes require chat context", async () => {
  const group = pushoverGroup({ db }); expect(readOnly(group).tools.map(t => t.definition.function.name)).toEqual(["pushover_status"]);
  expect(group.tools[0]!.execute({})).toMatchObject({ ready: false });
  await expect(group.tools[1]!.execute({ message: "Test", requestId: "test-direct" })).rejects.toThrow("interactive chat");
});

for (const outcome of ["approved", "declined", "expired"] as const) test(`chat ${outcome} controls the send, with no workflow permission added`, async () => {
  Object.assign(process.env, settings); let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ status: 1, request: "req-chat" }); }) as unknown as typeof fetch;
  const script: Partial<ChatMessage>[] = [
    { finishReason: "tool_calls", toolCalls: [{ id: "load", name: "get_pushover_tools", arguments: {} }] },
    { finishReason: "tool_calls", toolCalls: [{ id: "send", name: "pushover_send", arguments: { message: "Test notification", requestId: "chat-test-1" } }] },
    { content: "Finished." },
  ];
  const provider: ChatProvider = { traced: true, providerName: "test", async chat() { return { role: "assistant", content: "", finishReason: "stop", ...script.shift() }; } };
  const agent = new ChatAgent({ context: { db }, groups: ["pushover"], routes: [{ client: provider, model: "test" }], promptInjectionScreening: false });
  let approvals = 0;
  await withTurn({ conversationId: "test", emit() {}, settled() {}, async decide(request) { approvals++; expect(JSON.stringify(request)).not.toContain(settings.PUSHOVER_APP_TOKEN); return { decisionId: "test", outcome }; } },
    () => agent.runMessages([{ role: "user", content: "Send a test push." }]));
  expect(approvals).toBe(1); expect(calls).toBe(outcome === "approved" ? 1 : 0);
  expect(db.select().from(s.workflowPermissions).all()).toHaveLength(0);
});

test("chat rejection is shown as a failed submission without leaking provider error text", async () => {
  Object.assign(process.env, settings);
  globalThis.fetch = (async () => Response.json({ status: 0, errors: [settings.PUSHOVER_APP_TOKEN] }, { status: 400 })) as unknown as typeof fetch;
  const script: Partial<ChatMessage>[] = [
    { finishReason: "tool_calls", toolCalls: [{ id: "load", name: "get_pushover_tools", arguments: {} }] },
    { finishReason: "tool_calls", toolCalls: [{ id: "send", name: "pushover_send", arguments: { message: "Test", requestId: "rejection-123" } }] },
    { content: "Not accepted." },
  ];
  const transcripts: ChatMessage[][] = [];
  const provider: ChatProvider = { traced: true, providerName: "test", async chat(messages) { transcripts.push([...messages]); return { role: "assistant", content: "", finishReason: "stop", ...script.shift() }; } };
  const agent = new ChatAgent({ context: { db }, groups: ["pushover"], routes: [{ client: provider, model: "test" }], promptInjectionScreening: false });
  let error: string | null = null;
  await withTurn({ conversationId: "test", emit() {}, settled(_id, failure) { error = failure; }, async decide() { return { decisionId: "test", outcome: "approved" }; } },
    () => agent.runMessages([{ role: "user", content: "Test the push." }]));
  expect(String(error)).toContain("rejected"); expect(JSON.stringify(transcripts)).not.toContain(settings.PUSHOVER_APP_TOKEN);
});
