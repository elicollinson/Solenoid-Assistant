import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../db";
import { OkfStore } from "../okf/store";
import { createHistoryRuntime } from "../writeHistory/runtime";
import { DreamWorkflow } from "./dream";
import { hash } from "../writeHistory/history";
import { snapshot } from "../writeHistory/files";
import { createWriteHistoryRoutes } from "../http/routes/writeHistory";
import { createReminder, reviseReminder } from "../db/mutations/reminders";
import { configureRowMutation } from "../core/writeExecution";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { configureRowMutation(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "dream-fixture-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const db = initDb(":memory:"); cleanups.push(() => db.$client.close());
  const runtime = createHistoryRuntime(db, root, Buffer.alloc(32, 3));
  const store = new OkfStore({ root, actor: "synthetic", now: () => new Date("2026-09-12T12:00:00Z") }, true);
  await store.create({ id: "memories/dad-preferences", type: "Memory", title: "Dad's stated preferences", body: "In March, Dad generally preferred shorter movies.", sources: [{ resource: "synthetic:S1", author: "human:user" }] });
  await store.create({ id: "memories/dad-film", type: "Memory", title: "Film A with Dad", body: "Dad liked Film A, especially the ending. We watched it together.", sources: [{ resource: "synthetic:S2", author: "human:user" }] });
  const dream = new DreamWorkflow(runtime);
  const input = { sourceIds: ["memories/dad-preferences", "memories/dad-film"], canonicalId: "people/dad", entityId: "user:father", title: "Dad" };
  return { root, db, runtime, dream, store, input };
}
test("dream proposal is read-only, exact reviewed apply groups sources, undo restores them", async () => {
  const { root, runtime, dream, input } = await setup();
  const before = await snapshot(root);
  const plan = await dream.propose(input);
  expect(await snapshot(root)).toEqual(before);
  expect(plan.value.identity).toBe("needs-confirmation");
  expect(plan.value.preview.length).toBe(3);
  await expect(dream.apply(plan.id, plan.digest, false)).rejects.toThrow("confirm");
  const result = await dream.apply(plan.id, plan.digest, true);
  const overview = await Bun.file(join(root, "people/dad.md")).text();
  expect(overview).toContain("especially the ending"); expect(overview).toContain("generally preferred shorter");
  expect(overview).not.toContain("favorite movie");
  for (const change of plan.value.preview) expect(await Bun.file(join(root, change.path)).text()).toBe(change.after!);
  await expect(dream.propose(input)).rejects.toThrow("already reflects");
  const inverse = await runtime.files.planInverse(result.operationId!);
  await runtime.files.applyInverse(inverse.id, inverse.digest);
  expect(await Bun.file(join(root, "people/dad.md")).exists()).toBe(false);
  for (const id of input.sourceIds) expect(await Bun.file(join(root, `${id}.md`)).text()).toBe(before.get(`${id}.md`)!);
  const edges = runtime.history.db.$client.query("SELECT * FROM links WHERE id LIKE 'okfl_%'").all(); expect(edges).toHaveLength(0);
});
test("different identity and intervening source edits block application", async () => {
  const { root, dream, store, input } = await setup();
  const plan = await dream.propose(input);
  await store.patch({ id: input.sourceIds[0]!, bodyOps: [{ op: "replaceAll", content: "Later correction: keep this." }] });
  await expect(dream.apply(plan.id, plan.digest, true)).rejects.toThrow("Source changed");
  expect(await Bun.file(join(root, "people/dad.md")).exists()).toBe(false);
  await store.patch({ id: input.sourceIds[0]!, extra: { entity_id: "another-speaker:father" } });
  await expect(dream.propose(input)).rejects.toThrow("different entity");
});
test("semantic neighbors are local, freshness checked, and similarity does not confirm identity", async () => {
  const { root, runtime, input } = await setup(); let calls = 0;
  const dream = new DreamWorkflow(runtime, async () => {
    calls++; return { status: "ready", candidates: [
      { id: input.sourceIds[1]!, sourceSha256: hash(await Bun.file(join(root, `${input.sourceIds[1]}.md`)).text()), score: .99 },
      { id: input.sourceIds[0]!, sourceSha256: "stale", score: 1 },
    ] };
  });
  expect((await dream.candidates(input.sourceIds[0]!)).candidates).toHaveLength(1);
  const result = await dream.run(); expect(result.proposals).toHaveLength(0); expect(result.uncertain).toBeGreaterThan(0); expect(calls).toBeGreaterThan(0);
});
test("local field inverse preserves a later edit to another field", async () => {
  const { db, runtime } = await setup();
  const id = createReminder(db, { title: "Synthetic reminder", dueAt: new Date("2026-10-01") });
  configureRowMutation((table, id, fields, fn) => runtime.rows.mutate(table, id, fields, fn));
  reviseReminder(db, id, { dueAt: new Date("2026-10-02") });
  const original = runtime.history.list()[0]!.id;
  db.$client.query("UPDATE reminders SET title='Later user title' WHERE id=?").run(id);
  const plan = runtime.rows.planInverse(original); runtime.rows.applyInverse(plan.id, plan.digest);
  const row = db.$client.query("SELECT title,due_at FROM reminders WHERE id=?").get(id) as { title: string; due_at: number };
  expect(row.title).toBe("Later user title"); expect(row.due_at).toBe(new Date("2026-10-01").getTime());
});
test("review API authenticates, checks origin and explicit identity approval", async () => {
  const { runtime, input } = await setup(); const token = "synthetic-token-".repeat(3);
  const app = createWriteHistoryRoutes(() => runtime, () => token, undefined, () => true);
  const request = (path: string, body?: unknown, extra?: Record<string, string>) => app.handle(new Request(`http://localhost${path}`, {
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  expect((await app.handle(new Request("http://localhost/api/write-history"))).status).toBe(401);
  expect((await request("/api/dream/proposals", input, { origin: "https://untrusted.example" })).status).toBe(401);
  const response = await request("/api/dream/proposals", input); expect(response.status).toBe(200);
  const plan = await response.json();
  expect((await request(`/api/write-plans/${plan.id}/apply`, { digest: plan.digest, approved: true })).status).toBe(409);
  expect((await request(`/api/write-plans/${plan.id}/apply`, { digest: plan.digest, approved: true, confirmIdentity: true })).status).toBe(200);
}, 20_000);
