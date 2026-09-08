import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  stat,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import { digest, putRecord, records } from "./store";
import { photoSchema } from "./schema";
import { sourceRequest } from "./client";

export const assetRoot = () =>
  path.resolve(process.env.SOURCE_ASSET_DIR ?? ".screenshots/source-assets");
export const stageRoot = () =>
  path.resolve(process.env.SOURCE_STAGING_DIR ?? "/tmp/solenoid-source-stage");
const HASH = /^[a-f0-9]{64}$/;
export type Candidate = {
  hash: string;
  extension: string;
  status: string;
  created_at: number;
  attempts: number;
  retry_at: number;
  lease_until: number;
  classification: string | null;
};
export function assetPath(
  hash: string,
  extension: string,
  staging = false,
): string {
  if (!HASH.test(hash) || !/^\.(png|jpg|webp|heic)$/.test(extension))
    throw new Error("Invalid asset identity");
  return path.join(staging ? stageRoot() : assetRoot(), hash + extension);
}
export function imageExtension(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return ".png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return ".jpg";
  if (
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  )
    return ".webp";
  if (
    b.toString("ascii", 4, 8) === "ftyp" &&
    /heic|heix|mif1/.test(b.toString("ascii", 8, 32))
  )
    return ".heic";
  throw new Error("Only PNG, JPEG, WebP, and HEIC screenshots are accepted");
}
async function atomicFile(file: string, bytes: Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export function candidate(hash: string, db = getDb()): Candidate | null {
  if (!HASH.test(hash)) throw new Error("Invalid hash");
  return db.$client
    .query("SELECT * FROM source_candidates WHERE hash=?")
    .get(hash) as Candidate | null;
}
export async function candidateStatus(hash: string, db = getDb()) {
  const row = candidate(hash, db);
  if (!row) return { status: "upload-needed" };
  if (
    row.status === "accepted" &&
    !(await stat(assetPath(hash, row.extension)).catch(() => null))
  )
    return { status: "upload-needed" };
  if (
    ["pending", "processing", "failed"].includes(row.status) &&
    !(await stat(assetPath(hash, row.extension, true)).catch(() => null))
  )
    return { status: "upload-needed" };
  return { status: row.status };
}
export async function stagePhoto(
  raw: unknown,
  bytes: Uint8Array,
  db = getDb(),
) {
  const photo = photoSchema.parse(raw);
  if (bytes.length > 20 * 1024 * 1024 || bytes.length === 0)
    throw new Error("Image must be between 1 byte and 20 MiB");
  if (digest(bytes) !== photo.hash) throw new Error("Image hash mismatch");
  const extension = imageExtension(bytes);
  const old = candidate(photo.hash, db);
  if (old?.status === "rejected" || old?.status === "quarantined")
    return { status: old.status };
  await atomicFile(
    assetPath(photo.hash, extension, old?.status !== "accepted"),
    bytes,
  );
  const status = db.$client.transaction(() => {
    // The consumer can finish while an upload is writing its temporary file.
    // A completed rejection must never be resurrected by that in-flight retry.
    const latest = candidate(photo.hash, db);
    if (latest?.status === "rejected" || latest?.status === "quarantined")
      return latest.status;
    db.$client
      .query(
        "INSERT INTO source_candidates(hash,extension,created_at) VALUES(?,?,?) ON CONFLICT(hash) DO UPDATE SET status=CASE WHEN source_candidates.status='accepted' THEN 'accepted' ELSE 'pending' END",
      )
      .run(photo.hash, extension, Date.now());
    db.$client
      .query(
        "INSERT OR REPLACE INTO source_photo_candidates(id,hash,payload) VALUES(?,?,?)",
      )
      .run(photo.uuid, photo.hash, JSON.stringify(photo));
    if (latest?.status === "accepted")
      putRecord(
        "photos",
        photo.uuid,
        {
          ...photo,
          extension,
          classification: latest.classification
            ? JSON.parse(latest.classification)
            : null,
        },
        photo.date,
        db,
      );
    return latest?.status ?? "pending";
  })();
  if (status === "rejected" || status === "quarantined") {
    await unlink(
      assetPath(photo.hash, extension, old?.status !== "accepted"),
    ).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  return { status };
}
export async function finishCandidate(
  row: Candidate,
  result: { classification: string; name: string } | null,
  rejectedStatus = "rejected",
  db = getDb(),
) {
  const accepted =
    result &&
    ["Book", "Movie", "TV Show", "Game", "Music"].includes(
      result.classification,
    );
  if (accepted) {
    const bytes = await readFile(assetPath(row.hash, row.extension, true));
    if (digest(bytes) !== row.hash)
      throw new Error("Staged image integrity failure");
    await atomicFile(assetPath(row.hash, row.extension), bytes);
  } else {
    // Never delete source Photos files; these paths are confined to app storage.
    await unlink(assetPath(row.hash, row.extension)).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  db.$client.transaction(() => {
    if (!accepted)
      for (const existing of records("photos", db).filter(
        (r) => r.payload?.hash === row.hash,
      ))
        putRecord("photos", existing.id, null, existing.occurred, db);
    const refs = db.$client
      .query("SELECT id,payload FROM source_photo_candidates WHERE hash=?")
      .all(row.hash) as { id: string; payload: string }[];
    for (const ref of refs) {
      if (accepted) {
        const photo = photoSchema.parse(JSON.parse(ref.payload));
        putRecord(
          "photos",
          ref.id,
          { ...photo, extension: row.extension, classification: result },
          photo.date,
          db,
        );
      } else {
        const existing = records("photos", db).find((r) => r.id === ref.id);
        if (existing) putRecord("photos", ref.id, null, existing.occurred, db);
      }
    }
    db.$client
      .query(
        "UPDATE source_candidates SET status=?,classification=?,lease_until=0 WHERE hash=?",
      )
      .run(
        accepted ? "accepted" : rejectedStatus,
        accepted ? JSON.stringify(result) : null,
        row.hash,
      );
    // Rejection receipts contain no screenshot filename, description, OCR, or thumbnail.
    db.$client
      .query("DELETE FROM source_photo_candidates WHERE hash=?")
      .run(row.hash);
  })();
  await unlink(assetPath(row.hash, row.extension, true)).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
}
export async function purgeStaging(db = getDb()) {
  await mkdir(stageRoot(), { recursive: true, mode: 0o700 });
  for (const name of await readdir(stageRoot())) {
    if (!/^[a-f0-9]{64}\.(png|jpg|webp|heic)(\.[a-f0-9-]+\.tmp)?$/.test(name))
      continue;
    const file = path.join(stageRoot(), name);
    const info = await stat(file);
    const row = candidate(name.slice(0, 64), db);
    if (row && row.lease_until > Date.now()) continue;
    if (
      (row && ["accepted", "rejected", "quarantined"].includes(row.status)) ||
      info.mtimeMs < Date.now() - 24 * 3600_000
    ) {
      await unlink(file).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      if (
        row &&
        !["accepted", "rejected", "quarantined"].includes(row.status)
      ) {
        db.$client
          .query("UPDATE source_candidates SET status='expired' WHERE hash=?")
          .run(row.hash);
        db.$client
          .query("DELETE FROM source_photo_candidates WHERE hash=?")
          .run(row.hash);
      }
    }
  }
}
export async function resolveAsset(
  hash: string,
  extension: string,
): Promise<string> {
  const file = assetPath(hash, extension);
  if (await stat(file).catch(() => null)) return file;
  const base = process.env.SOURCE_REMOTE_URL,
    token = process.env.SOURCE_READ_TOKEN;
  if (!base || !token)
    throw new Error(
      "Image is not cached locally; configure source catch-up and retry online",
    );
  const response = await sourceRequest(`/api/sources/assets/${hash}`, token);
  if (!response.ok)
    throw new Error(`Image download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (digest(bytes) !== hash || imageExtension(bytes) !== extension)
    throw new Error("Downloaded image integrity failure");
  await pruneReplicaCache(bytes.length);
  await atomicFile(file, bytes);
  return file;
}

export async function rejectCollectedPhoto(id: string, db = getDb()) {
  const photo = records("photos", db).find((r) => r.id === id);
  if (!photo) return;
  const row = candidate(String(photo.payload!.hash), db);
  if (row) await finishCandidate(row, null, "rejected", db);
}

/** A replica cache is disposable; canonical retained assets are never evicted. */
async function pruneReplicaCache(incoming: number) {
  const maxMiB = Number(process.env.SOURCE_CACHE_MAX_MB ?? 512);
  if (!Number.isFinite(maxMiB) || maxMiB <= 0)
    throw new Error("Invalid SOURCE_CACHE_MAX_MB");
  const budget = maxMiB * 1024 * 1024;
  if (incoming > budget)
    throw new Error("Image exceeds the configured local cache budget");
  const files = [];
  for (const name of await readdir(assetRoot()).catch(() => [])) {
    if (!/^[a-f0-9]{64}\.(png|jpg|webp|heic)$/.test(name)) continue;
    const file = path.join(assetRoot(), name);
    const info = await stat(file);
    files.push({ file, size: info.size, mtime: info.mtimeMs });
  }
  let total = files.reduce((sum, f) => sum + f.size, 0) + incoming;
  for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= budget) break;
    await unlink(f.file);
    total -= f.size;
  }
}
