import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, type Db } from "../db";
import { KnowledgeIndex, chunksFor } from "./index";
import { EmbeddingError, type EmbeddingConfig, type EmbeddingProvider } from "./embedding";
import { OkfStore } from "../okf/store";
import { serializeConcept } from "../okf/concept";

let dir = "", db: Db, root: string, now = 1_800_000_000_000;
const config: EmbeddingConfig = { enabled: true, project: "synthetic", location: "global", model: "gemini-embedding-2", dimensions: 3, dailyTokens: 100_000 };
let calls: string[] = [];
const provider: EmbeddingProvider = { async embed(input) {
  calls.push(input);
  return /cinema|movie|film/i.test(input) ? [1, 0, 0] : [0, 1, 0];
} };
function setup(c = config, p = provider) {
  dir = mkdtempSync(join(tmpdir(), "okf-vector-test-"));
  root = join(dir, "okf"); mkdirSync(root);
  db = initDb(join(dir, "test.sqlite")); calls = [];
  return new KnowledgeIndex(() => db, root, c, p, () => now);
}
function write(id: string, body: string, extra: Record<string, unknown> = {}) {
  writeFileSync(join(root, `${id}.md`), serializeConcept({ frontmatter: { type: "Memory", title: id, ...extra }, body }));
}
async function drain(index: KnowledgeIndex) {
  for (let i = 0; i < 100; i++) { if (await index.processOne() === "idle") return; }
  throw new Error("queue did not drain");
}
afterEach(() => { db?.$client.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

test("initial existing corpus is lexical only until intentional backfill; unchanged scans make zero calls", async () => {
  const index = setup(); write("Dad", "He enjoys movies.");
  expect(index.reconcile()).toMatchObject({ unindexed: 1, pending: 0 });
  expect(await index.processOne()).toBe("idle");
  index.reconcile({ enroll: "all" }); await drain(index);
  expect(index.status()).toMatchObject({ ready: 1, pending: 0 });
  const previous = calls.length; index.reconcile(); await drain(index);
  expect(calls.length).toBe(previous);
  expect(index.plan().estimatedOnlineCostUpperUsd).toBeGreaterThan(0);
});

test("reconciliation recovers a crash between file save and post-write enqueue", async () => {
  const index = setup(); write("Old", "Previously existing memory");
  index.prepareWrite();
  write("New", "Likes movies"); // process dies here, no post-write callback
  const restarted = new KnowledgeIndex(() => db, root, config, provider);
  expect(restarted.reconcile()).toMatchObject({ pending: 1, unindexed: 1 });
  await drain(restarted);
  expect(restarted.status().ready).toBe(1);
});

test("a second connection cannot claim the same running job", async () => {
  let finish!: (v: number[]) => void;
  const index = setup(config, { embed: async () => new Promise(resolve => { finish = resolve; }) });
  write("Dad", ""); index.reconcile({ enroll: "all" });
  const first = index.processOne();
  const otherDb = initDb(join(dir, "test.sqlite"));
  try {
    const other = new KnowledgeIndex(() => otherDb, root, config, provider, () => now);
    expect(await other.processOne()).toBe("idle");
    finish([1, 0, 0]); await first;
  } finally { otherDb.$client.close(); }
});

test("ready index falls back honestly when query budget is exhausted", async () => {
  const index = setup(); write("Dad", "Likes movies"); index.reconcile({ enroll: "all" }); await drain(index);
  const limited = new KnowledgeIndex(() => db, root, { ...config, dailyTokens: 0 }, provider, () => now);
  const before = calls.length;
  expect(await limited.search({ query: "movies" })).toMatchObject({ mode: "lexical", reason: "daily_budget_exhausted" });
  expect(calls.length).toBe(before);
});

test("write hooks enroll create, patch and move while preserving saved-memory feedback", async () => {
  const index = setup();
  const store = new OkfStore({ root, actor: "human:test", index });
  expect(await store.create({ id: "dad", type: "Memory", body: "Favorite movie: Moon" })).toMatchObject({ indexing: { pending: 1 } });
  await drain(index);
  expect((await store.search({ query: "cinema" })).results[0]?.id).toBe("dad");
  await store.patch({ id: "dad", bodyOps: [{ op: "replaceAll", content: "Enjoys gardening" }] });
  expect(index.status().ready).toBe(0);
  await drain(index);
  await store.move("dad", "father");
  expect((await store.search({ query: "dad" })).results.some(r => r.id === "dad")).toBe(false);
  await drain(index);
  await store.deprecate("father");
  expect((await store.search({ query: "gardening" })).results).toHaveLength(0);
  expect((await store.search({ query: "gardening", status: "deprecated" })).results).toHaveLength(1);
});

test("local index failure does not undo a successful memory save", async () => {
  setup();
  const broken = new KnowledgeIndex(() => { throw new Error("database unavailable"); }, root, config, provider);
  const store = new OkfStore({ root, actor: "human:test", index: broken });
  const saved = await store.create({ id: "Dad", type: "Memory", body: "Likes movies" });
  expect(saved.indexing).toEqual({ error: expect.stringContaining("Memory saved") });
  expect((await store.read("Dad")).body).toContain("Likes movies");
});

test("semantic synonyms, exact titles, FTS stemming, safe punctuation, and header-only matching", async () => {
  const index = setup(); write("Dad", "He likes movies. Walking on trails.");
  write("cinema", "A glossary entry.");
  index.reconcile({ enroll: "all" }); await drain(index);
  const found = await index.search({ query: "cinema" });
  expect(found.mode).toBe("hybrid");
  expect(found.results[0]?.conceptId).toBe("cinema");
  expect(found.results.some(r => r.conceptId === "Dad" && r.matchedIn.includes("semantic"))).toBe(true);
  const local = new KnowledgeIndex(() => db, root, { ...config, enabled: false }, provider);
  expect((await local.search({ query: "walked" })).results[0]?.conceptId).toBe("Dad");
  expect((await local.search({ query: '" OR * NEAR(' })).results).toHaveLength(0);
  expect((await index.search({ query: "movies", includeBody: false })).results).toHaveLength(0);
  expect((await index.search({ query: "okf:Dad" })).results[0]?.conceptId).toBe("Dad");
});

test("metadata filters apply before vector ranking, including explicit deprecated search", async () => {
  const index = setup();
  write("Dad", "Likes movies", { tags: ["relationship"], stale_after: "2020-01-01", verified: [{ by: "human:test", at: "2026-01-01" }] });
  write("Other", "Likes movies", { type: "Reference", tags: ["work"] });
  index.reconcile({ enroll: "all" }); await drain(index);
  const found = await index.search({ query: "cinema", type: "memory", tags: ["RELATIONSHIP"], minTrust: "human-reviewed", staleOnly: true, group: "People and contacts" });
  expect(found.results.map(r => r.conceptId)).toEqual(["Dad"]);
});

test("deletion and parse errors remove all searchable generations, failed mount preserves index", async () => {
  const index = setup(); write("Dad", "Likes movies"); index.reconcile({ enroll: "all" }); await drain(index);
  renameSync(root, `${root}-offline`);
  expect(() => index.reconcile()).toThrow();
  expect(index.status().ready).toBe(1);
  renameSync(`${root}-offline`, root);
  writeFileSync(join(root, "Dad.md"), "no frontmatter");
  expect(index.reconcile()).toMatchObject({ eligible: 0, problems: 1 });
  expect((await index.search({ query: "movies" })).results).toHaveLength(0);
  write("Dad", "Likes movies"); index.reconcile(); await drain(index);
  rmSync(join(root, "Dad.md"));
  expect((await index.search({ query: "cinema" })).results).toHaveLength(0);
  expect(db.$client.query("SELECT * FROM okf_search_chunks").all()).toHaveLength(0);
});

test("late response cannot resurrect a deleted or replaced chunk", async () => {
  let finish!: (v: number[]) => void;
  const index = setup(config, { embed: async () => new Promise(resolve => { finish = resolve; }) });
  write("Dad", "Likes movies"); index.reconcile({ enroll: "all" });
  const work = index.processOne();
  write("Dad", "A different fact");
  finish([1, 0, 0]);
  expect(await work).toBe("superseded");
  expect(index.status().ready).toBe(0);
});

test("crash leases recover with a new owner and obsolete worker cannot overwrite", async () => {
  let finish!: (v: number[]) => void;
  const index = setup(config, { embed: async () => new Promise(resolve => { finish = resolve; }) });
  write("Dad", "Likes movies"); index.reconcile({ enroll: "all" });
  const abandoned = index.processOne();
  now += 61_000;
  const recovery = new KnowledgeIndex(() => db, root, config, provider, () => now);
  expect(await recovery.processOne()).toBe("ready");
  finish([0, 1, 0]);
  expect(await abandoned).toBe("superseded");
  await drain(recovery); expect(recovery.status().ready).toBe(1);
});

test("daily budget is durable and shared with query requests; disabled never calls provider", async () => {
  const index = setup({ ...config, dailyTokens: 0 });
  write("Dad", "Likes movies"); index.reconcile({ enroll: "all" });
  expect(await index.processOne()).toBe("daily_budget_exhausted");
  expect(calls).toHaveLength(0);
  const off = new KnowledgeIndex(() => db, root, { ...config, enabled: false }, provider);
  expect(await off.processOne()).toBe("disabled");
  expect((await off.search({ query: "movies" })).mode).toBe("lexical");
  expect(calls).toHaveLength(0);
});

test("failures are sanitized and bounded; explicit retry is supported", async () => {
  const index = setup(config, { async embed() { throw new EmbeddingError("provider_403"); } });
  write("Dad", "Likes movies"); index.reconcile({ enroll: "all" });
  expect(await index.processOne()).toBe("provider_403");
  expect(index.status().failed).toBe(1);
  index.reconcile({ retryFailed: true });
  expect(index.status().failed).toBe(0);
});

test("partial generations are hidden and dimensions/model changes require enrollment", async () => {
  const index = setup(); write("Dad", "## Movies\nMoon\n## Walks\nRiverside");
  index.reconcile({ enroll: "all" }); await index.processOne();
  expect(index.status()).toMatchObject({ ready: 0, pending: 1 });
  await drain(index);
  const migrated = new KnowledgeIndex(() => db, root, { ...config, dimensions: 4 }, { async embed() { return [1, 0, 0, 0]; } });
  expect(migrated.reconcile()).toMatchObject({ ready: 0, unindexed: 1 });
  expect(await migrated.processOne()).toBe("idle");
  migrated.reconcile({ enroll: "all" }); await drain(migrated);
  expect(migrated.status().ready).toBe(1);
});

test("query result revalidates files changed while awaiting the query embedding", async () => {
  const index = setup(); write("Dad", "Likes movies"); index.reconcile({ enroll: "all" }); await drain(index);
  const racing = new KnowledgeIndex(() => db, root, config, { async embed() { rmSync(join(root, "Dad.md")); return [1, 0, 0]; } });
  expect((await racing.search({ query: "cinema" })).results).toHaveLength(0);
});

test("chunking preserves Unicode and entire long tails within input caps", () => {
  const body = Array.from({ length: 2500 }, (_, i) => `${i}宇宙🦦`).join("") + "LAST_SENTENCE";
  const chunks = chunksFor({ title: "Title", header: "Title", body }, config);
  expect(chunks.slice(1).map(c => c.excerpt).join("")).toBe(body);
  expect(chunks.every(c => Buffer.byteLength(c.input) <= 5000)).toBe(true);
});

test("neighbor seam is local, excludes self and requires current source revision", async () => {
  const index = setup(); write("Dad", "Likes movies"); write("Films", "Movie preferences");
  index.reconcile({ enroll: "all" }); await drain(index);
  const row = (await index.search({ query: "Dad" })).results[0]!;
  const before = calls.length;
  const neighbors = index.neighbors("Dad", row.sourceSha256);
  expect(neighbors.status).toBe("ready");
  expect(neighbors.candidates.map(c => c.id)).toEqual(["Films"]);
  expect(calls.length).toBe(before);
  expect(index.neighbors("Dad", "old").status).toBe("unavailable");
});
