import { Elysia, t } from "elysia";
import { getDb, type Db } from "../../db";
import { loadCollections } from "../../db/queries/collections";
import { editCollectionItem } from "../../db/mutations/collections";
import { COLLECTIONS } from "../../shared/collections";
import { assetPath, candidate } from "../../sources/assets";
import { eq } from "drizzle-orm";
import { collectionSources } from "../../db/schema";

export function createCollectionRoutes(resolveDb: () => Db = getDb) {
  return new Elysia({ name: "routes.collections" })
    .get("/api/collections", ({ query }) => loadCollections(resolveDb(), query), {
      query: t.Object({
        collection: t.Optional(t.Union(COLLECTIONS.map((value) => t.Literal(value)))),
        q: t.Optional(t.String({ maxLength: 500 })), archived: t.Optional(t.Boolean()),
        limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
        offset: t.Optional(t.Integer({ minimum: 0 })),
      }),
    })
    .get("/api/collections/export", () => {
      const db = resolveDb();
      // A single synchronous SQLite read transaction gives a consistent export.
      const data = db.transaction(() => {
        const first = loadCollections(db);
        return loadCollections(db, { limit: Math.max(1, first.total) });
      });
      return new Response(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...data }, null, 2), {
        headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="solenoid-collections.json"' },
      });
    })
    .patch("/api/collections/:id", ({ params, body, set }) => {
      if (body.name !== undefined && !body.name.trim()) { set.status = 422; return { error: "An item needs a name" }; }
      if (!editCollectionItem(resolveDb(), params.id, body)) { set.status = 404; return { error: "Collection item not found" }; }
      return { ok: true };
    }, { body: t.Object({
      name: t.Optional(t.String({ minLength: 1, maxLength: 1000 })),
      description: t.Optional(t.String({ maxLength: 20000 })), notes: t.Optional(t.String({ maxLength: 20000 })), archived: t.Optional(t.Boolean()),
    }) })
    .get("/api/collections/sources/:id/image", async ({ params }) => {
      const db = resolveDb();
      const source = db.select().from(collectionSources).where(eq(collectionSources.id, params.id)).get();
      if (!source?.assetHash || !/^[a-f0-9]{64}$/.test(source.assetHash)) return new Response("Screenshot unavailable", { status: 404 });
      const row = candidate(source.assetHash, db);
      if (!row || row.status !== "accepted") return new Response("Screenshot unavailable", { status: 404 });
      const file = Bun.file(assetPath(row.hash, row.extension));
      if (!await file.exists()) return new Response("Screenshot unavailable", { status: 404 });
      return new Response(file, { headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
    });
}
