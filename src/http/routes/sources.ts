import { Elysia } from "elysia";
import { timingSafeEqual } from "node:crypto";
import { getDb, type Db } from "../../db";
import {
  batchSchema,
  inventorySchema,
  photoSchema,
} from "../../sources/schema";
import {
  changesSince,
  completeInventory,
  importBatch,
  putRecord,
  records,
  sourceStatus,
} from "../../sources/store";
import {
  assetPath,
  candidate,
  candidateStatus,
  stagePhoto,
} from "../../sources/assets";

function authorized(request: Request, kind: "INGEST" | "READ") {
  const token = process.env[`SOURCE_${kind}_TOKEN`];
  const supplied = request.headers.get("authorization") ?? "";
  if (!token || token.length < 32) return false;
  const expected = Buffer.from(`Bearer ${token}`),
    actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function createSourceRoutes(resolveDb: () => Db = getDb) {
  const run =
    (
      kind: "INGEST" | "READ",
      handler: (request: Request, db: Db) => Promise<unknown> | unknown,
    ) =>
    async ({ request }: { request: Request }) => {
      if (!authorized(request, kind))
        return new Response("Unauthorized", { status: 401 });
      try {
        return await handler(request, resolveDb());
      } catch {
        return new Response(
          "Invalid source request or unavailable source data",
          { status: 400 },
        );
      }
    };
  return new Elysia({ name: "routes.sources" })
    .post(
      "/api/sources/batch",
      run("INGEST", async (request, db) => {
        const body = batchSchema.parse(await request.json());
        return { received: importBatch(body.kind, body.records, db) };
      }),
      { parse: "none" },
    )
    .post(
      "/api/sources/inventory",
      run("INGEST", async (request, db) => {
        const body = inventorySchema.parse(await request.json());
        completeInventory(body.kind, body.ids, body.from, body.to, db);
        return { ok: true };
      }),
      { parse: "none" },
    )
    .post(
      "/api/sources/photos/register",
      run("INGEST", async (request, db) => {
        const photo = photoSchema.parse(await request.json());
        const status = await candidateStatus(photo.hash, db);
        if (status.status === "accepted") {
          const row = candidate(photo.hash, db)!;
          putRecord(
            "photos",
            photo.uuid,
            {
              ...photo,
              extension: row.extension,
              classification: JSON.parse(row.classification!),
            },
            photo.date,
            db,
          );
        } else if (
          ["pending", "processing", "failed"].includes(status.status)
        ) {
          db.$client
            .query(
              "INSERT OR REPLACE INTO source_photo_candidates(id,hash,payload) VALUES(?,?,?)",
            )
            .run(photo.uuid, photo.hash, JSON.stringify(photo));
        }
        return status;
      }),
      { parse: "none" },
    )
    .post(
      "/api/sources/photos",
      run("INGEST", async (request, db) => {
        const form = await request.formData();
        const photo = JSON.parse(String(form.get("metadata")));
        const file = form.get("image");
        if (!(file instanceof Blob) || file.size > 20 * 1024 * 1024)
          throw new Error("Invalid image");
        return stagePhoto(photo, new Uint8Array(await file.arrayBuffer()), db);
      }),
      { parse: "none" },
    )
    .get(
      "/api/sources/changes",
      run("READ", (request, db) => {
        const cursor = Number(
          new URL(request.url).searchParams.get("cursor") ?? 0,
        );
        if (!Number.isSafeInteger(cursor) || cursor < 0)
          throw new Error("Invalid cursor");
        return changesSince(cursor, db);
      }),
    )
    .get(
      "/api/sources/assets/:hash",
      run("READ", (request, db) => {
        const hash = new URL(request.url).pathname.split("/").at(-1)!;
        const record = records("photos", db).find(
          (r) => r.payload?.hash === hash,
        );
        if (!record) return new Response("Not found", { status: 404 });
        return new Response(
          Bun.file(assetPath(hash, String(record.payload!.extension))),
          { headers: { "cache-control": "private, no-store" } },
        );
      }),
    )
    .get("/api/source-status", () => ({
      sources: sourceStatus(resolveDb()),
      queue: resolveDb()
        .$client.query(
          "SELECT status,count(*) AS count FROM source_candidates GROUP BY status",
        )
        .all(),
    }));
}
