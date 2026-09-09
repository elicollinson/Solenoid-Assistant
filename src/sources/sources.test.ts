import { beforeEach, afterEach, describe, test, expect } from "bun:test";
import { mkdtemp, rm, stat, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initDb, type Db } from "../db";
import {
  importBatch,
  completeInventory,
  records,
  changesSince,
  applyReplica,
  digest,
} from "./store";
import {
  stagePhoto,
  assetPath,
  candidate,
  finishCandidate,
  candidateStatus,
  purgeStaging,
} from "./assets";
import { storedContacts, storedMessages } from "./readers";
import { createSourceRoutes } from "../http/routes/sources";
import { consumeScreenshot } from "./consumer";
import { syncWorkflowCatalog } from "../workflows/sync";

let root: string, db: Db, replica: Db;
let oldEnv: Record<string, string | undefined>;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2]);
const hash = digest(png);
const photo = {
  uuid: "photo-1",
  filename: "shot.png",
  date: "2026-09-01T00:00:00.000Z",
  width: 100,
  height: 100,
  hash,
};
const from = "2026-08-01T00:00:00.000Z",
  to = "2026-10-01T00:00:00.000Z";
const message = {
  sourceId: "message-1",
  body: "hello",
  sender: "+15551234567",
  senderName: null,
  conversationId: "chat-1",
  isFromMe: false,
  service: "iMessage",
  timestamp: photo.date,
  hasAttachments: false,
};
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "source-test-"));
  db = initDb(path.join(root, "server.db"));
  replica = initDb(path.join(root, "replica.db"));
  oldEnv = Object.fromEntries(
    [
      "SOURCE_ASSET_DIR",
      "SOURCE_STAGING_DIR",
      "SOURCE_INGEST_TOKEN",
      "SOURCE_READ_TOKEN",
    ].map((k) => [k, process.env[k]]),
  );
  process.env.SOURCE_ASSET_DIR = path.join(root, "assets");
  process.env.SOURCE_STAGING_DIR = path.join(root, "stage");
  process.env.SOURCE_INGEST_TOKEN = "i".repeat(40);
  process.env.SOURCE_READ_TOKEN = "r".repeat(40);
});
afterEach(async () => {
  db.$client.close();
  replica.$client.close();
  for (const [k, v] of Object.entries(oldEnv))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  await rm(root, { recursive: true, force: true });
});
describe("source replication", () => {
  test("retries deduplicate, updates and tombstones catch up without touching local workflow state", () => {
    syncWorkflowCatalog(replica, new Date(), { registerOnly: true });
    importBatch("messages", [message], db);
    importBatch("messages", [message], db);
    expect(changesSince(0, db).changes).toHaveLength(1);
    applyReplica(changesSince(0, db), replica);
    const cursor = changesSince(0, db).cursor;
    importBatch("messages", [{ ...message, body: "edited" }], db);
    applyReplica(changesSince(cursor, db), replica);
    expect(records("messages", replica)[0]!.payload!.body).toBe("edited");
    completeInventory("messages", [], from, to, db);
    applyReplica(changesSince(cursor, db), replica);
    expect(records("messages", replica)).toHaveLength(0);
    expect(
      replica.$client.query("SELECT count(*) AS n FROM workflows").get(),
    ).toEqual({ n: 5 });
    expect(
      replica.$client
        .query("SELECT count(*) AS n FROM workflow_schedules")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      replica.$client
        .query("SELECT count(*) AS n FROM workflow_permissions")
        .get(),
    ).toEqual({ n: 0 });
  });
  test("readers use imported records and preserve the contact filter", () => {
    expect(() => storedContacts(db)).toThrow("not been collected");
    importBatch(
      "contacts",
      [{ kind: "phone", handle: message.sender, name: "Known" }],
      db,
    );
    completeInventory("contacts", [message.sender], from, to, db);
    importBatch(
      "messages",
      [message, { ...message, sourceId: "stranger", sender: "+15559876543" }],
      db,
    );
    completeInventory("messages", ["message-1", "stranger"], from, to, db);
    const trusted = storedContacts(db).filter(
      storedMessages(new Date(from), new Date(to), db),
    );
    expect(trusted).toHaveLength(1);
    expect(trusted[0]!.senderName).toBe("Known");
  });
  test("a malformed batch makes no partial writes", () => {
    expect(() =>
      importBatch("messages", [message, { bad: true }], db),
    ).toThrow();
    expect(records("messages", db)).toHaveLength(0);
  });
});
describe("screenshot retention", () => {
  test("rejection deletes stage and retained bytes and leaves no image metadata", async () => {
    await stagePhoto(photo, png, db);
    const row = candidate(hash, db)!;
    await finishCandidate(
      row,
      { classification: "Rejected", name: "Unknown" },
      "rejected",
      db,
    );
    expect(
      await stat(assetPath(hash, ".png", true)).catch(() => null),
    ).toBeNull();
    expect(await stat(assetPath(hash, ".png")).catch(() => null)).toBeNull();
    expect(records("photos", db)).toHaveLength(0);
    expect(
      db.$client.query("SELECT * FROM source_photo_candidates").all(),
    ).toHaveLength(0);
    expect(await stagePhoto(photo, png, db)).toEqual({ status: "rejected" });
    expect(
      await stat(assetPath(hash, ".png", true)).catch(() => null),
    ).toBeNull();
  });
  test("accepted images are promoted once and rejected after reassessment", async () => {
    await stagePhoto(photo, png, db);
    await finishCandidate(
      candidate(hash, db)!,
      { classification: "Movie", name: "Arrival" },
      "rejected",
      db,
    );
    expect(await readFile(assetPath(hash, ".png"))).toEqual(png);
    expect(records("photos", db)).toHaveLength(1);
    expect(await candidateStatus(hash, db)).toEqual({ status: "accepted" });
    await finishCandidate(candidate(hash, db)!, null, "rejected", db);
    expect(records("photos", db)).toHaveLength(0);
    expect(changesSince(0, db).changes[0]!.deleted).toBe(1);
  });
  test("hash mismatch never enters the queue", async () => {
    await expect(
      stagePhoto({ ...photo, hash: "a".repeat(64) }, png, db),
    ).rejects.toThrow("hash mismatch");
    expect(candidate(hash, db)).toBeNull();
  });
  test("consumer discards after exactly five failures and collection cannot restart retries", async () => {
    await stagePhoto(photo, png, db);
    let calls = 0;
    const fail = async () => { calls++; throw new Error("outage"); };
    for (let attempt = 1; attempt <= 5; attempt++) {
      db.$client.query("UPDATE source_candidates SET retry_at=0 WHERE hash=?").run(hash);
      expect(await consumeScreenshot(db, fail)).toBe(true);
      expect(candidate(hash, db)!.attempts).toBe(attempt);
      expect(candidate(hash, db)!.status).toBe(attempt < 5 ? "failed" : "rejected");
    }
    expect(calls).toBe(5);
    expect(await stat(assetPath(hash, ".png", true)).catch(() => null)).toBeNull();
    expect(await stat(assetPath(hash, ".png")).catch(() => null)).toBeNull();
    expect(db.$client.query("SELECT * FROM source_photo_candidates").all()).toHaveLength(0);
    expect(await stagePhoto(photo, png, db)).toEqual({ status: "rejected" });
    expect(await consumeScreenshot(db, fail)).toBe(false);
    expect(calls).toBe(5);
  });
  test("a fifth attempt can still succeed", async () => {
    await stagePhoto(photo, png, db);
    db.$client.query("UPDATE source_candidates SET attempts=4 WHERE hash=?").run(hash);
    await consumeScreenshot(db, async () => ({ result: { classification: "Movie", name: "Arrival" }, status: "rejected" }));
    expect(candidate(hash, db)!.attempts).toBe(5);
    expect(candidate(hash, db)!.status).toBe("accepted");
    expect(await readFile(assetPath(hash, ".png"))).toEqual(png);
  });
  test("legacy exhausted candidates are discarded without another call, respecting active leases", async () => {
    await stagePhoto(photo, png, db);
    db.$client.query("UPDATE source_candidates SET status='processing',attempts=11,retry_at=?,lease_until=? WHERE hash=?")
      .run(Date.now() + 3600000, Date.now() + 3600000, hash);
    let calls = 0;
    const classify = async () => { calls++; throw new Error("must not run"); };
    expect(await consumeScreenshot(db, classify)).toBe(false);
    db.$client.query("UPDATE source_candidates SET lease_until=0 WHERE hash=?").run(hash);
    expect(await consumeScreenshot(db, classify)).toBe(true);
    expect(calls).toBe(0);
    expect(candidate(hash, db)!.attempts).toBe(11);
    expect(candidate(hash, db)!.status).toBe("rejected");
    expect(await stat(assetPath(hash, ".png", true)).catch(() => null)).toBeNull();
  });
  test("consumer retries transient errors without falsely rejecting", async () => {
    await stagePhoto(photo, png, db);
    await consumeScreenshot(db, async () => {
      throw new Error("outage");
    });
    expect(candidate(hash, db)!.status).toBe("failed");
    expect(await stat(assetPath(hash, ".png", true))).toBeTruthy();
  });
});
test("ingestion and read credentials cannot cross scopes", async () => {
  const app = createSourceRoutes(() => db);
  const batch = () =>
    new Request("http://localhost/api/sources/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.SOURCE_READ_TOKEN}`,
      },
      body: JSON.stringify({ kind: "messages", records: [message] }),
    });
  expect((await app.handle(batch())).status).toBe(401);
  expect(
    (
      await app.handle(
        new Request("http://localhost/api/sources/changes", {
          headers: {
            authorization: `Bearer ${process.env.SOURCE_INGEST_TOKEN}`,
          },
        }),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await app.handle(
        new Request("http://localhost/api/sources/changes", {
          headers: { authorization: `Bearer ${process.env.SOURCE_READ_TOKEN}` },
        }),
      )
    ).status,
  ).toBe(200);
});

test("expired staging is removed and an interrupted upload can be retried", async () => {
  await stagePhoto(photo, png, db);
  const file = assetPath(hash, ".png", true);
  const old = new Date(Date.now() - 25 * 3600_000);
  await utimes(file, old, old);
  await purgeStaging(db);
  expect(await stat(file).catch(() => null)).toBeNull();
  expect(candidate(hash, db)!.status).toBe("expired");
  await stagePhoto(photo, png, db);
  expect(await stat(file)).toBeTruthy();
  expect(candidate(hash, db)!.status).toBe("pending");
});
test("unknown classification categories are discarded", async () => {
  await stagePhoto(photo, png, db);
  await finishCandidate(
    candidate(hash, db)!,
    { classification: "Unrecognized", name: "Unknown" },
    "rejected",
    db,
  );
  expect(records("photos", db)).toHaveLength(0);
  expect(
    await stat(assetPath(hash, ".png", true)).catch(() => null),
  ).toBeNull();
});

test("an in-flight duplicate upload cannot resurrect a completed rejection", async () => {
  await stagePhoto(photo, png, db);
  const retry = stagePhoto(photo, png, db);
  // Simulate the other process committing its decision while upload I/O awaits.
  db.$client
    .query("UPDATE source_candidates SET status='rejected' WHERE hash=?")
    .run(hash);
  db.$client
    .query("DELETE FROM source_photo_candidates WHERE hash=?")
    .run(hash);
  expect(await retry).toEqual({ status: "rejected" });
  expect(
    await stat(assetPath(hash, ".png", true)).catch(() => null),
  ).toBeNull();
  expect(
    db.$client.query("SELECT * FROM source_photo_candidates").all(),
  ).toHaveLength(0);
});
