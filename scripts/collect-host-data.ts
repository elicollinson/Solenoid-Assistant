#!/usr/bin/env bun
// Runs only as the logged-in macOS account, never in the container worker.
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  rename,
  stat,
  readdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { fetchMessages, unixSecondsToAppleNs } from "../src/imessage/reader";
import { createTrustGate } from "../src/contacts/trustGate";
import { queryScreenshots, materialize } from "../src/utils/osxPhotos";
import { digest } from "../src/sources/store";
import { sourceRequest } from "../src/sources/client";

if (process.platform !== "darwin")
  throw new Error("Host collection requires macOS");
const root = path.resolve(
  process.env.SOURCE_COLLECTOR_STATE ??
    path.join(homedir(), ".solenoid-collector"),
);
await mkdir(root, { recursive: true, mode: 0o700 });
const lock = new Database(path.join(root, "collector-lock.db"));
lock.exec(
  "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lock(id INTEGER PRIMARY KEY)",
);
try {
  lock.exec("BEGIN EXCLUSIVE");
} catch {
  console.log("Collector already running");
  process.exit(0);
}
const token =
  process.env.SOURCE_INGEST_TOKEN ??
  (process.env.SOURCE_TOKEN_FILE
    ? await readFile(process.env.SOURCE_TOKEN_FILE, "utf8")
    : ""
  ).trim();
const statePath = path.join(root, "state.json");
let state: { from: string; lastSuccess?: string } | null = null;
try {
  state = JSON.parse(await readFile(statePath, "utf8"));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const days = Number(process.env.SOURCE_BACKFILL_DAYS ?? 30);
if (!Number.isFinite(days) || days < 0)
  throw new Error("Invalid SOURCE_BACKFILL_DAYS");
const configuredFrom =
  days === 0
    ? "2001-01-01T00:00:00.000Z"
    : new Date(Date.now() - days * 86400_000).toISOString();
const from = process.env.SOURCE_BACKFILL_FROM ?? state?.from ?? configuredFrom;
const to = new Date().toISOString();
if (!Number.isFinite(Date.parse(from)) || from > to)
  throw new Error("Invalid source coverage start");
const post = async (route: string, body: unknown) =>
  (
    await sourceRequest(route, token, JSON.stringify(body), {
      "content-type": "application/json",
    })
  ).json();
async function collectRecords(
  kind: "messages" | "contacts",
  rows: unknown[],
  ids: string[],
) {
  for (let offset = 0; offset < rows.length; offset += 500)
    await post("/api/sources/batch", {
      kind,
      records: rows.slice(offset, offset + 500),
    });
  await post("/api/sources/inventory", { kind, ids, from, to });
}
// The exclusive lock makes it safe to clean exports left by an interrupted run.
const spool = path.join(root, "exports");
await mkdir(spool, { recursive: true, mode: 0o700 });
for (const name of await readdir(spool))
  if (name.startsWith("run-"))
    await rm(path.join(spool, name), { recursive: true, force: true });
const work = await mkdtemp(path.join(spool, "run-"));
try {
  const gate = createTrustGate({
    addressBookDir: process.env.ADDRESS_BOOK_DIR,
  });
  const contacts = gate.exportContacts!();
  await collectRecords(
    "contacts",
    contacts,
    contacts.map((c) => c.handle),
  );
  const { messages } = fetchMessages(
    unixSecondsToAppleNs(Date.parse(from) / 1000) - 1n,
    {
      dbPath: process.env.IMESSAGE_DB_PATH,
      overlapSeconds: 0,
      untilAppleNs: unixSecondsToAppleNs(Date.parse(to) / 1000),
    },
  );
  await collectRecords(
    "messages",
    messages,
    messages.map((m) => m.sourceId),
  );
  const photos = await queryScreenshots({
    fromDate: from,
    toDate: to,
    libraryPath: process.env.PHOTOS_LIBRARY_PATH,
    binary: process.env.OSXPHOTOS_BINARY,
  });
  for (const photo of photos) {
    // Missing originals are exported only into this run's temporary directory.
    const paths = await materialize([photo], work, {
      libraryPath: process.env.PHOTOS_LIBRARY_PATH,
      binary: process.env.OSXPHOTOS_BINARY,
    });
    const file = paths.get(photo.uuid);
    if (!file)
      throw new Error(
        "Screenshot could not be downloaded from iCloud; collection will retry",
      );
    if ((await stat(file)).size > 20 * 1024 * 1024)
      throw new Error("Screenshot exceeds the 20 MiB upload limit");
    const bytes = await readFile(file);
    const metadata = {
      uuid: photo.uuid,
      filename: photo.original_filename || photo.filename,
      date: new Date(photo.date).toISOString(),
      width: photo.width,
      height: photo.height,
      hash: digest(bytes),
    };
    const reply = (await post("/api/sources/photos/register", metadata)) as {
      status: string;
    };
    if (["upload-needed", "expired"].includes(reply.status)) {
      const form = new FormData();
      form.set("metadata", JSON.stringify(metadata));
      form.set("image", new Blob([bytes]), "screenshot");
      await sourceRequest("/api/sources/photos", token, form);
    }
  }
  await post("/api/sources/inventory", {
    kind: "photos",
    ids: photos.map((p) => p.uuid),
    from,
    to,
  });
  const next = {
    from,
    lastSuccess: to,
    counts: {
      messages: messages.length,
      contacts: contacts.length,
      photos: photos.length,
    },
  };
  await writeFile(statePath + ".tmp", JSON.stringify(next), { mode: 0o600 });
  await rename(statePath + ".tmp", statePath);
  console.log(JSON.stringify({ event: "host-collection-complete", ...next }));
} finally {
  await rm(work, { recursive: true, force: true });
  lock.exec("ROLLBACK");
  lock.close();
}
