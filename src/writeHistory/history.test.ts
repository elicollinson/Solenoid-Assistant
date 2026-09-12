import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../db";
import { defineTool } from "../core/tools";
import { z } from "zod";
import { withConsent } from "../core/consent";
import { configureWriteExecution, newWriteCall, withWriteCall, recordWriteResponse } from "../core/writeExecution";
import { WriteHistory } from "./history";
import { FileHistory } from "./files";
import { OkfStore } from "../okf/store";

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { configureWriteExecution(); for (const fn of cleanup.splice(0)) await fn(); });
function fixture(key: Buffer | undefined = Buffer.alloc(32, 7)) {
  const db = initDb(":memory:"); cleanup.push(() => db.$client.close());
  return new WriteHistory(db, key);
}
async function bundle() {
  const root = await mkdtemp(join(tmpdir(), "history-test-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new OkfStore({ root, actor: "test", now: () => new Date("2026-09-12T12:00:00Z") }, true);
  await store.create({ id: "memories/dad", type: "Memory", body: "Original detail.", sources: [{ resource: "synthetic:S1" }] });
  return { root, store };
}
test("write tool boundary audits direct calls and keeps committed effect after blocked response", async () => {
  const h = fixture(); configureWriteExecution(h, true);
  let mutations = 0;
  const tool = defineTool({ name: "local_edit", kind: "write", description: "Edit fixture", schema: z.object({ secret: z.string() }), execute: () => ++mutations });
  const denied = await tool.execute({ secret: "never-store-this" });
  expect(String(denied)).toContain("authorized"); expect(mutations).toBe(0);
  const call = newWriteCall({ deferResponse: true });
  await withConsent(() => ({ allow: true }), async () => withWriteCall(call, () => tool.execute({ secret: "never-store-this" })));
  recordWriteResponse(call, "blocked");
  expect(h.get(call.id)?.execution).toBe("committed"); expect(h.get(call.id)?.response).toBe("blocked");
  expect(JSON.stringify(h.list())).not.toContain("never-store-this");
  expect(() => h.begin(call, "local_edit")).toThrow(); expect(mutations).toBe(1);
});
test("encryption and expiration fail closed without losing recovery data", () => {
  const h = fixture(); const call = newWriteCall(); h.begin(call, "test");
  h.capture(call.id, { secret: "private fixture" });
  const saved = h.db.$client.query("SELECT cipher FROM write_payloads").get() as { cipher: string };
  expect(saved.cipher).not.toContain("private"); expect(h.payload<{ secret: string }>(call.id)).toEqual({ secret: "private fixture" });
  const wrong = new WriteHistory(h.db, Buffer.alloc(32, 8)); expect(() => wrong.payload(call.id)).toThrow();
});
test("captured OKF write, exact undo and redo preserve original bytes and append history", async () => {
  const h = fixture(), { root } = await bundle(); const files = new FileHistory(h);
  const original = await Bun.file(join(root, "memories/dad.md")).text();
  await files.mutate(root, "test", "okf_patch", stage => new OkfStore({ root: stage, actor: "test" }, true).patch({ id: "memories/dad", bodyOps: [{ op: "replaceAll", content: "Changed detail." }] }));
  const id = h.list()[0]!.id, plan = await files.planInverse(id);
  const result = await files.applyInverse(plan.id, plan.digest);
  expect(await Bun.file(join(root, "memories/dad.md")).text()).toBe(original);
  expect(result.operationId).toBeTruthy();
  const redo = await files.planInverse(result.operationId!); await files.applyInverse(redo.id, redo.digest);
  expect(await Bun.file(join(root, "memories/dad.md")).text()).toContain("Changed detail.");
});
test("later edits refuse exact undo instead of overwriting them", async () => {
  const h = fixture(), { root } = await bundle(); const files = new FileHistory(h);
  await files.mutate(root, "test", "okf_patch", stage => new OkfStore({ root: stage, actor: "test" }, true).patch({ id: "memories/dad", bodyOps: [{ op: "replaceAll", content: "Changed." }] }));
  const id = h.list()[0]!.id;
  await Bun.write(join(root, "memories/dad.md"), (await Bun.file(join(root, "memories/dad.md")).text()) + "\nA later user addition.\n");
  await expect(files.planInverse(id)).rejects.toThrow("Later edits");
  expect(await Bun.file(join(root, "memories/dad.md")).text()).toContain("later user addition");
});
test("interrupted file group recovers durable after-images and does not replay the planner", async () => {
  const h = fixture(), { root } = await bundle(); let calls = 0;
  const broken = new FileHistory(h, async () => {}, (point, index) => { if (point === "applied" && index === 0) throw new Error("crash"); });
  await expect(broken.mutate(root, "test", "okf_patch", async stage => {
    calls++; return new OkfStore({ root: stage, actor: "test" }, true).patch({ id: "memories/dad", bodyOps: [{ op: "replaceAll", content: "Recovered detail." }] });
  })).rejects.toThrow("crash");
  const id = h.list()[0]!.id; expect(h.get(id)?.execution).toBe("partial");
  await new FileHistory(h).recover(id);
  expect(h.get(id)?.execution).toBe("committed"); expect(calls).toBe(1);
  expect(await Bun.file(join(root, "memories/dad.md")).text()).toContain("Recovered detail.");
});
test("missing snapshot key leaves original files untouched", async () => {
  const db = initDb(":memory:"); cleanup.push(() => db.$client.close());
  const h = new WriteHistory(db), { root } = await bundle();
  const original = await Bun.file(join(root, "memories/dad.md")).text();
  await expect(new FileHistory(h).mutate(root, "test", "okf_patch", stage => new OkfStore({ root: stage, actor: "test" }, true).patch({ id: "memories/dad", bodyOps: [{ op: "replaceAll", content: "Should not land." }] }))).rejects.toThrow("WRITE_HISTORY_KEY");
  expect(await Bun.file(join(root, "memories/dad.md")).text()).toBe(original);
});
