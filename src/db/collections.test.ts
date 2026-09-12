import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { initDb } from "./index";
import { saveExtractedCollectionItem, editCollectionItem, type ExtractedCollectionInput } from "./mutations/collections";
import { loadCollections } from "./queries/collections";
import { createCollectionRoutes } from "../http/routes/collections";
import { importCollectionSnapshot } from "./mutations/importCollections";
const db = initDb(":memory:");
afterEach(() => { db.$client.exec("DELETE FROM collection_sources; DELETE FROM collection_imports; DELETE FROM collection_items;"); });
const input: ExtractedCollectionInput = {
  uuid: "shot1", filename: "source.png", path: "/tmp/source.png", date: "2026-09-12T10:00:00Z", collection: "book",
  classification: { classification: "Book", name: "DUNE" },
  contentCard: { name: "Dune", type: "Book", description: "A novel", url: "https://example.com/dune", coverImageUrl: "" },
};
test("idempotent receipts and many screenshots preserve extraction and user edits", () => {
  const first = saveExtractedCollectionItem(db, input);
  editCollectionItem(db, first.itemId, { name: "My Dune", notes: "read next", archived: true });
  expect(saveExtractedCollectionItem(db, input).itemId).toBe(first.itemId);
  expect(saveExtractedCollectionItem(db, { ...input, uuid: "shot2", contentCard: { ...input.contentCard, description: "New summary" } }).itemId).toBe(first.itemId);
  const item = loadCollections(db).items[0]!;
  expect(item.sources).toHaveLength(2);
  expect(item.name).toBe("My Dune"); expect(item.notes).toBe("read next"); expect(item.archived).toBe(true);
  expect(item.sources.map((source) => source.contentCard.description).sort()).toEqual(["A novel", "New summary"]);
  expect(item.sources[0]!.classification).toEqual(input.classification);
});
test("failed source insert rolls back the item and leaves it retryable", () => {
  db.$client.exec("CREATE TRIGGER fail_source BEFORE INSERT ON collection_sources BEGIN SELECT RAISE(ABORT, 'write failed'); END");
  try { expect(() => saveExtractedCollectionItem(db, input)).toThrow("write failed"); expect(loadCollections(db).total).toBe(0); }
  finally { db.$client.exec("DROP TRIGGER fail_source"); }
  expect(saveExtractedCollectionItem(db, input).status).toBe("created");
});
test("filtering is literal, paginated and includes notes; same URL in another collection stays separate", () => {
  saveExtractedCollectionItem(db, input);
  const movie = saveExtractedCollectionItem(db, { ...input, uuid: "movie", collection: "movie" });
  editCollectionItem(db, movie.itemId, { notes: "100% great", archived: true });
  expect(loadCollections(db, { q: "%" }).total).toBe(1);
  expect(loadCollections(db, { q: "great", collection: "book" }).total).toBe(0);
  expect(loadCollections(db, { archived: false }).total).toBe(1);
  expect(loadCollections(db, { limit: 1, offset: 1 }).items).toHaveLength(1);
});
test("HTTP edits validate input; export includes archived items and original extraction", async () => {
  const id = saveExtractedCollectionItem(db, input).itemId;
  const app = new Elysia().use(createCollectionRoutes(() => db));
  const patch = (id: string, body: unknown) => app.handle(new Request(`http://localhost/api/collections/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  expect((await patch(id, { name: " " })).status).toBe(422);
  expect((await patch("absent", { notes: "hi" })).status).toBe(404);
  expect((await patch(id, { notes: "mine", archived: true })).status).toBe(200);
  expect((await app.handle(new Request("http://localhost/api/collections?limit=101"))).status).toBe(422);
  const response = await app.handle(new Request("http://localhost/api/collections/export"));
  const data = await response.json() as import("../shared/collections").CollectionsPayload;
  expect(data.items[0]!.notes).toBe("mine"); expect(data.items[0]!.sources[0]!.contentCard).toEqual(input.contentCard);
  expect((await app.handle(new Request("http://localhost/api/collections/sources/no/image"))).status).toBe(404);
});
const snapshot = { version: 1, fetchedAt: "2026-09-12T10:00:00Z", records: [{ collection: "music", page: {
  id: "notion1", url: "https://notion.so/notion1", properties: { Name: { type: "title", title: [{ plain_text: "Album" }] }, Description: { rich_text: [{ plain_text: "Original description" }] }, Extra: { rich_text: [{ plain_text: "Keep this" }] } } }, blocks: [{ id: "block1", paragraph: { rich_text: [{ plain_text: "Notes" }] } }] }] };
test("historical import preserves full snapshots, is repeatable, and rolls back invalid batches", () => {
  expect(importCollectionSnapshot(db, snapshot)).toEqual({ records: 1, imported: 1, skipped: 0, verified: 1 });
  expect(importCollectionSnapshot(db, snapshot).skipped).toBe(1);
  const item = loadCollections(db).items[0]!;
  expect(item.name).toBe("Album"); expect(item.imports[0]!.payload).toEqual(snapshot.records[0]);
  const changed = structuredClone(snapshot); changed.records[0]!.page.properties.Name.title[0]!.plain_text = "Changed";
  expect(() => importCollectionSnapshot(db, changed)).toThrow("differs from this snapshot");
  const invalid = structuredClone(snapshot); invalid.records[0]!.page.id = "invalid"; invalid.records[0]!.page.properties.Name.title = [];
  expect(() => importCollectionSnapshot(db, invalid)).toThrow("no title"); expect(loadCollections(db).total).toBe(1);
});
