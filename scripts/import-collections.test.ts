import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../src/db";
const dir = mkdtempSync(join(tmpdir(), "collections-offline-"));
const snapshot = join(dir, "snapshot.json");
const dbPath = join(dir, "import.db");
const implicitDb = join(dir, "must-not-open.db");
writeFileSync(snapshot, JSON.stringify({ version: 1, fetchedAt: "2026-09-12T10:00:00Z", records: [
  { collection: "book", page: { id: "historical-page", url: "https://notion.so/historical-page", properties: { Name: { type: "title", title: [{ plain_text: "Saved book" }] } } }, blocks: [] },
] }));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
async function run(args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("NOTION_")));
  const child = Bun.spawn([process.execPath, "run", "scripts/import-collections.ts", ...args], {
    env: { ...env, DATABASE_URL: implicitDb }, stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, stdout, stderr };
}
test("snapshot preview opens no database and application is explicit and repeatable without credentials", async () => {
  const preview = await run(["--snapshot", snapshot]);
  expect(preview.exit).toBe(0); expect(JSON.parse(preview.stdout)).toMatchObject({ mode: "preview", records: 1 });
  expect(existsSync(implicitDb)).toBe(false);
  const missing = await run(["--snapshot", snapshot, "--apply"]);
  expect(missing.exit).not.toBe(0); expect(existsSync(implicitDb)).toBe(false);
  const applied = await run(["--snapshot", snapshot, "--apply", "--database", dbPath]);
  expect(applied.exit).toBe(0); expect(JSON.parse(applied.stdout)).toEqual({ records: 1, imported: 1, skipped: 0, verified: 1 });
  const repeated = await run(["--snapshot", snapshot, "--apply", "--database", dbPath]);
  expect(JSON.parse(repeated.stdout)).toEqual({ records: 1, imported: 0, skipped: 1, verified: 1 });
  const db = initDb(dbPath);
  try { expect(db.$client.query("SELECT name FROM collection_items").get()).toEqual({ name: "Saved book" }); }
  finally { db.$client.close(); }
}, 30000);
test("the retired live-fetch flag is rejected", async () => {
  const result = await run(["--fetch", "--snapshot", snapshot]);
  expect(result.exit).not.toBe(0); expect(result.stderr).toContain("Unknown option");
});
