import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../db";
import { reindexOkf } from "../db/okf/reindex";
import { configureFileMutation } from "../writeHistory/files";
import { withConsent } from "../core/consent";
import { createOkfUndoTool } from "../tools/okfUndo";
import { hash } from "../writeHistory/history";
import { KnowledgeIndex } from "../knowledgeSearch";
import { EmbeddingError, type EmbeddingConfig } from "../knowledgeSearch/embedding";
import { OkfStore } from "../okf/store";
import { FileHistory, snapshot } from "../writeHistory/files";
import { createHistoryRuntime } from "../writeHistory/runtime";
import { DreamWorkflow } from "./dream";
import { validateSynthesis, type DreamSynthesizer } from "./dreamSynthesis";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { configureFileMutation(); for (const fn of cleanup.splice(0)) await fn(); });
const config: EmbeddingConfig = { enabled: true, project: "synthetic", location: "global", model: "gemini-embedding-2", dimensions: 3, dailyTokens: 100_000 };
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "memory-lifecycle-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "okf"), db = initDb(join(dir, "fixture.db")); cleanup.push(() => db.$client.close());
  let calls = 0, fail = false;
  const provider = { embed: async (input: string) => {
    calls++; if (fail) throw new EmbeddingError("provider_503", true);
    return /Dad|film|movies/i.test(input) ? [1, 0, 0] : [0, 1, 0];
  } };
  const index = new KnowledgeIndex(() => db, root, config, provider);
  const refresh = async () => { await reindexOkf(db, { root }); index.reconcile({ enroll: "all" }); };
  const runtime = createHistoryRuntime(db, root, refresh);
  runtime.neighbors = async (id, sha, limit) => {
    const result = index.neighbors(id, sha, limit);
    return { ...result, status: result.status === "ready" ? "ready" : "unavailable" };
  };
  configureFileMutation((root, actor, tool, stage) => runtime.files.mutate(root, actor, tool, stage));
  const store = new OkfStore({ root, actor: "human:synthetic", index });
  const drain = async () => { for (let i = 0; i < 100; i++) if (await index.processOne() === "idle") return; throw new Error("queue did not settle"); };
  return { root, db, index, runtime, store, drain, provider, calls: () => calls, outage: () => { fail = true; } };
}

test("save → shared embeddings → neighbors → workflow update → unregistered undo tool → refreshed search", async () => {
  const f = await setup();
  await f.store.create({ id: "memories/preferences", type: "Memory", title: "Dad's movies", body: "In March Dad preferred short movies.", sources: [{ resource: "synthetic:March" }] });
  await f.store.create({ id: "memories/experience", type: "Memory", title: "Dad and Film A", body: "In April Dad enjoyed the long Film A, especially its ending.", sources: [{ resource: "synthetic:April" }] });
  expect(f.db.$client.query("SELECT * FROM okf_writes").all()).toHaveLength(2);
  expect(f.index.status().pending).toBe(2);
  await f.drain(); expect(f.index.status().ready).toBe(2);
  const original = await snapshot(f.root), beforeCalls = f.calls();
  let synthesisCalls = 0;
  const synthesize: DreamSynthesizer = async sources => {
    synthesisCalls++;
    return { identity: "same", identityReason: "Synthetic fixture identifies the same father.", claims: [{ kind: "difference",
      text: "Dad's March preference for short movies coexists with his April enjoyment of a longer film; that experience does not establish a general preference for long films.",
      evidence: sources.map(s => ({ sourceId: s.id, quote: s.body })),
    }] };
  };
  const dream = new DreamWorkflow(f.runtime, undefined, synthesize);
  const neighbors = f.index.neighbors("memories/preferences", hash(original.get("memories/preferences.md")!));
  expect(neighbors.candidates[0]?.id).toBe("memories/experience"); expect(f.calls()).toBe(beforeCalls);
  const pass = await withConsent(() => ({ allow: true }), () => dream.run());
  expect(pass.updates).toHaveLength(1); expect(synthesisCalls).toBe(1);
  const applied = pass.updates[0]!;
  expect(await Bun.file(join(f.root, `${applied.id}.md`)).text()).toContain("coexists");
  await f.drain();
  expect((await f.index.search({ query: "coexists" })).results.some(r => r.conceptId === applied.id)).toBe(true);
  expect((f.db.$client.query("SELECT count(*) AS n FROM links WHERE id LIKE 'okfl_%'").get() as { n: number }).n).toBeGreaterThan(0);
  const undo = createOkfUndoTool(f.runtime);
  const undone = await undo.execute({ operationId: applied.operationId }) as { operationId: string };
  expect(undone.operationId).toBeTruthy();
  for (const id of ["memories/preferences.md", "memories/experience.md"]) expect((await snapshot(f.root)).get(id)).toBe(original.get(id));
  expect(await Bun.file(join(f.root, `${applied.id}.md`)).exists()).toBe(false);
  await f.drain();
  expect((await f.index.search({ query: "coexists" })).results.some(r => r.conceptId === applied.id)).toBe(false);
  expect(f.db.$client.query("SELECT * FROM links WHERE id LIKE 'okfl_%'").all()).toHaveLength(0);
  expect(f.db.$client.query("SELECT * FROM okf_writes WHERE inverse_of=?").all(applied.operationId)).toHaveLength(1);
  f.outage();
  expect(await f.index.search({ query: "short movies" })).toMatchObject({ mode: "lexical", reason: "provider_503", matched: 1 });
});

test("partial group blocks indexing; durable recovery and projection retry refresh edited/deleted content", async () => {
  const f = await setup();
  await f.store.create({ id: "dad", type: "Memory", body: "Dad likes movies." }); await f.drain();
  const broken = new FileHistory(f.runtime.history, async () => { throw new Error("projection offline"); }, point => { if (point === "applied") throw new Error("synthetic crash"); });
  await expect(broken.mutate(f.root, "synthetic", "okf_patch", root => new OkfStore({ root, actor: "human:synthetic" }, true).patch({ id: "dad", bodyOps: [{ op: "replaceAll", content: "Dad likes gardening." }] }))).rejects.toThrow("synthetic crash");
  const partial = f.db.$client.query("SELECT id FROM okf_writes WHERE execution='partial'").get() as { id: string };
  const calls = f.calls(); expect(await f.index.processOne()).toBe("write_in_progress"); expect(f.calls()).toBe(calls);
  await expect(reindexOkf(f.db, { root: f.root })).rejects.toThrow("incomplete");
  await new FileHistory(f.runtime.history, async () => { throw new Error("offline"); }).recover(partial.id);
  expect(f.runtime.history.get(partial.id)?.execution).toBe("committed");
  expect(f.db.$client.query("SELECT * FROM okf_writes WHERE refresh_pending=1").all()).toHaveLength(1);
  await f.runtime.files.refreshPending(); await f.drain();
  expect((await f.index.search({ query: "gardening" })).results[0]?.conceptId).toBe("dad");
  await rm(join(f.root, "dad.md")); f.index.reconcile();
  expect((await f.index.search({ query: "gardening" })).matched).toBe(0);
  const reopened = new KnowledgeIndex(() => f.db, f.root, config, f.provider);
  expect(reopened.reconcile().eligible).toBe(0);
});

test("synthesis rejects invented quotations, omitted sources, unrelated identities and uncited connections", () => {
  const sources = [{ id: "a", title: "Dad", body: "Likes short films." }, { id: "b", title: "Dad", body: "Liked Film A." }];
  const base = { identity: "same", identityReason: "Same person", claims: [{ kind: "fact", text: "Likes films", evidence: [{ sourceId: "a", quote: sources[0]!.body }] }] };
  expect(() => validateSynthesis(base, sources)).toThrow("omitted");
  expect(() => validateSynthesis({ ...base, identity: "different" }, sources)).toThrow("different");
  expect(() => validateSynthesis({ ...base, claims: [{ ...base.claims[0], evidence: [{ sourceId: "a", quote: "Favorite genre is science fiction" }] }] }, sources)).toThrow("unsupported");
  expect(() => validateSynthesis({ ...base, claims: [{ ...base.claims[0], kind: "connection" }] }, sources)).toThrow("multiple");
});

test("workflow obeys permission denial, skips uncertain identity, and does not rewrite unchanged evidence", async () => {
  const f = await setup();
  await f.store.create({ id: "a", type: "Memory", title: "Dad", body: "Dad likes films." });
  await f.store.create({ id: "b", type: "Memory", title: "Dad", body: "Dad liked Film A." }); await f.drain();
  const before = await snapshot(f.root);
  let same = false, calls = 0;
  const synthesize: DreamSynthesizer = async sources => { calls++; return { identity: same ? "same" : "uncertain", identityReason: "Synthetic identity assessment", claims: sources.map(s => ({ kind: "fact", text: s.body, evidence: [{ sourceId: s.id, quote: s.body }] })) }; };
  const dream = new DreamWorkflow(f.runtime, undefined, synthesize);
  await expect(dream.run()).rejects.toThrow("permission");
  expect((await withConsent(() => ({ allow: true }), () => dream.run())).uncertain).toBe(1);
  expect(await snapshot(f.root)).toEqual(before);
  same = true;
  expect((await withConsent(() => ({ allow: false, tell: "Denied" }), () => dream.run())).deferred).toBe(1);
  expect(await snapshot(f.root)).toEqual(before);
  const saved = await withConsent(() => ({ allow: true }), () => dream.run()); expect(saved.updates).toHaveLength(1);
  await f.drain(); const count = calls;
  expect((await withConsent(() => ({ allow: true }), () => dream.run())).updates).toHaveLength(0); expect(calls).toBe(count);
});

test("unregistered undo tool refuses later edits, rejects corrupt captures and supports redo", async () => {
  const f = await setup();
  await f.store.create({ id: "dad", type: "Memory", body: "Original movies." });
  const before = await Bun.file(join(f.root, "dad.md")).text();
  const saved = await f.runtime.files.mutate(f.root, "synthetic", "okf_patch", root => new OkfStore({ root, actor: "human:synthetic" }, true).patch({ id: "dad", bodyOps: [{ op: "replaceAll", content: "Changed films." }] }));
  const undo = createOkfUndoTool(f.runtime);
  const inverted = await undo.execute({ operationId: saved.operationId }) as { operationId: string };
  expect(await Bun.file(join(f.root, "dad.md")).text()).toBe(before);
  await undo.execute({ operationId: inverted.operationId });
  expect(await Bun.file(join(f.root, "dad.md")).text()).toContain("Changed films");
  await Bun.write(join(f.root, "dad.md"), (await Bun.file(join(f.root, "dad.md")).text()) + "\nLater user edit.\n");
  const latest = f.db.$client.query("SELECT id FROM okf_writes WHERE inverse_of=?").get(inverted.operationId) as { id: string };
  await expect(undo.execute({ operationId: latest.id })).rejects.toThrow("Later edits");
  f.db.$client.query("UPDATE okf_writes SET digest='corrupt' WHERE id=?").run(saved.operationId);
  expect(() => f.runtime.history.payload(saved.operationId)).toThrow("integrity");
  const { createOkfTools } = await import("../tools/okf");
  expect(createOkfTools({ root: f.root, actor: "synthetic" }).all.some(tool => tool.definition.function.name === "okf_undo")).toBe(false);
});
