import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { initDb, type Db } from "../index";
import { createUiRoutes } from "../../http/routes/ui";
import { writeOkfFixture } from "../seed/okfBundle";
import { createKnowledgeRefresh } from "./refresh";
import type { KnowledgePayload } from "../../shared/knowledge";
import { loadKnowledgeObject } from "../queries/knowledge";

let dir: string;
let db: Db;
afterEach(() => { db?.$client.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  dir = mkdtempSync(join(tmpdir(), "knowledge-refresh-"));
  db = initDb(join(dir, "db.sqlite"));
  const root = writeOkfFixture(join(dir, "okf"));
  const refresh = createKnowledgeRefresh(root);
  const app = new Elysia().use(createUiRoutes(() => db, refresh));
  return { root, refresh, app };
}

test("list bootstraps an empty projection and detail re-reads subsequent file edits", async () => {
  const { root, app } = setup();
  const response = await app.handle(new Request("http://localhost/api/knowledge"));
  expect(response.status).toBe(200);
  const list = await response.json() as KnowledgePayload;
  expect(list.rows).toHaveLength(5);
  const row = list.rows[0]!;
  const record = loadKnowledgeObject(db, row.id)!;
  const path = join(root, record.path.replace(/^okf\//, ""));
  writeFileSync(path, readFileSync(path, "utf8") + "\n## A later update\nNewly written detail.\n");
  const detail = await app.handle(new Request(`http://localhost/api/knowledge/${row.id}`));
  expect(detail.status).toBe(200);
  expect(await detail.text()).toContain("Newly written detail.");
});

test("concurrent refreshes share a pass; later reads run a fresh pass", async () => {
  const { refresh } = setup();
  const first = refresh(db);
  expect(refresh(db)).toBe(first);
  await first;
  expect(refresh(db)).not.toBe(first);
  await refresh(db);
});

test("unavailable store fails the request rather than returning an empty success", async () => {
  setup();
  const app = new Elysia().use(createUiRoutes(() => db, createKnowledgeRefresh(join(dir, "missing"))));
  expect((await app.handle(new Request("http://localhost/api/knowledge"))).status).toBe(500);
});
