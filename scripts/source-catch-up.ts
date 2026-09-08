#!/usr/bin/env bun
import { initDb } from "../src/db";
import { changePageSchema } from "../src/sources/schema";
import { applyReplica, records } from "../src/sources/store";
import { resolveAsset, assetRoot } from "../src/sources/assets";
import { sourceRequest } from "../src/sources/client";
import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
if (args.some((a) => !["--reset", "--prefetch"].includes(a)))
  throw new Error("Usage: bun run source:catch-up [--reset] [--prefetch]");
if (
  process.env.SOURCE_CONSUMER_ENABLED === "true" ||
  process.env.SOURCE_INGEST_TOKEN
)
  throw new Error("Catch-up is for a local replica, not the ingestion server");
const token = process.env.SOURCE_READ_TOKEN ?? "";
const db = initDb();
try {
  if (args.includes("--reset"))
    db.$client.transaction(() => {
      db.$client.exec(
        "DELETE FROM source_records; DELETE FROM source_status; DELETE FROM source_meta WHERE key IN ('remote_epoch','remote_cursor')",
      );
    })();
  let cursor = Number(
    (
      db.$client
        .query("SELECT value FROM source_meta WHERE key='remote_cursor'")
        .get() as { value: string } | null
    )?.value ?? 0,
  );
  let received = 0;
  for (;;) {
    const page = changePageSchema.parse(
      await (
        await sourceRequest(`/api/sources/changes?cursor=${cursor}`, token)
      ).json(),
    );
    if (
      page.cursor < cursor ||
      page.changes.some(
        (r, i) => r.seq <= (i ? page.changes[i - 1]!.seq : cursor),
      )
    )
      throw new Error("Invalid source change ordering");
    applyReplica(page, db);
    received += page.changes.length;
    if (page.cursor === cursor) break;
    cursor = page.cursor;
  }
  // Remove cached images no longer referenced after deletes or reset. Never
  // touch Photos or experimental files outside the source-asset directory.
  const photos = records("photos", db);
  const retained = new Set(
    photos.map((r) => String(r.payload!.hash) + String(r.payload!.extension)),
  );
  for (const file of await readdir(assetRoot()).catch(() => []))
    if (/^[a-f0-9]{64}\.(png|jpg|webp|heic)$/.test(file) && !retained.has(file))
      await unlink(path.join(assetRoot(), file));
  if (args.includes("--prefetch"))
    for (const photo of photos)
      await resolveAsset(
        String(photo.payload!.hash),
        String(photo.payload!.extension),
      );
  console.log(
    JSON.stringify({
      event: "source-catch-up-complete",
      received,
      cursor,
      images: photos.length,
    }),
  );
} finally {
  db.$client.close();
}
