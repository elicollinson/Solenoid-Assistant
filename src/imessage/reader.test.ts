import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appleNsToDate, fetchMessages, unixSecondsToAppleNs } from "./reader";
import { buildTypedstreamBlob } from "./typedstreamFixture";

const NS = 1_000_000_000n;
const T0 = unixSecondsToAppleNs(Date.parse("2026-07-18T12:00:00Z") / 1000);
const at = (seconds: number) => T0 + BigInt(seconds) * NS;

const DECODED_BODY = "decoded from attributedBody 👍";

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "imessage-reader-test-"));
  dbPath = join(dir, "chat.db");
  const db = new Database(dbPath, { create: true, safeIntegers: true });
  db.run(`CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB,
    date INTEGER, is_from_me INTEGER, handle_id INTEGER, service TEXT,
    associated_message_type INTEGER, item_type INTEGER,
    cache_has_attachments INTEGER, balloon_bundle_id TEXT)`);
  db.run(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT)`);
  db.run(`CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, service_name TEXT)`);
  db.run(`CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)`);

  db.run(`INSERT INTO handle VALUES (1, '+15551234567', 'iMessage'), (2, 'Friend@Example.COM', 'iMessage')`);
  db.run(`INSERT INTO chat VALUES
    (1, 'c-1', '+15551234567', '', 'iMessage'),
    (2, 'c-2', 'chat831264732619', '', 'iMessage')`);

  const insert = db.prepare(`INSERT INTO message VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  // plain incoming text message
  insert.run(1n, "g-1", "hello there", null, at(0), 0n, 1n, "iMessage", 0n, 0n, 0n, null);
  // NULL text, body only in attributedBody (the Ventura+ case)
  insert.run(2n, "g-2", null, buildTypedstreamBlob(DECODED_BODY), at(60), 0n, 1n, "iMessage", 0n, 0n, 0n, null);
  // tapback — must be filtered
  insert.run(3n, "g-3", 'Loved "hello there"', null, at(120), 0n, 1n, "iMessage", 2000n, 0n, 0n, null);
  // system event (group rename etc.) — must be filtered
  insert.run(4n, "g-4", null, null, at(180), 0n, 1n, "iMessage", 0n, 2n, 0n, null);
  // outgoing message: handle_id 0, sender is "me"
  insert.run(5n, "g-5", "on my way", null, at(240), 1n, 0n, "iMessage", 0n, 0n, 0n, null);
  // group-chat message from an email handle (must be lowercased)
  insert.run(6n, "g-6", "group hello", null, at(300), 0n, 2n, "SMS", 0n, 0n, 0n, null);
  // iMessage-app payload — must be filtered
  insert.run(7n, "g-7", "app payload", null, at(360), 0n, 1n, "iMessage", 0n, 0n, 0n, "com.apple.msg.balloon");
  // attachment-only, no body — skipped but must still advance the cursor
  insert.run(8n, "g-8", null, null, at(420), 0n, 1n, "iMessage", 0n, 0n, 1n, null);

  // g-1 joins to TWO chats — output must dedupe on guid
  db.run(`INSERT INTO chat_message_join VALUES (1,1), (2,1), (1,2), (1,5), (2,6)`);
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("fetchMessages", () => {
  test("returns only real messages, normalized and in order", () => {
    const { messages } = fetchMessages(0n, { dbPath, overlapSeconds: 0 });
    expect(messages.map((m) => m.sourceId)).toEqual(["g-1", "g-2", "g-5", "g-6"]);

    const [plain, decoded, mine, group] = messages;
    expect(plain!.body).toBe("hello there");
    expect(plain!.sender).toBe("+15551234567");
    expect(plain!.timestamp.toISOString()).toBe("2026-07-18T12:00:00.000Z");
    expect(plain!.isFromMe).toBe(false);

    // NULL-text message round-trips through the attributedBody decoder
    expect(decoded!.body).toBe(DECODED_BODY);

    expect(mine!.sender).toBe("me");
    expect(mine!.isFromMe).toBe(true);

    expect(group!.sender).toBe("friend@example.com");
    expect(group!.conversationId).toBe("chat831264732619");
    expect(group!.service).toBe("SMS");
  });

  test("newCursor advances past filtered/skipped rows and refetch returns nothing", () => {
    const first = fetchMessages(0n, { dbPath, overlapSeconds: 0 });
    // g-8 has no body (attachment-only) but is the newest row — the cursor
    // must still move past it or every future fetch re-reads it.
    expect(first.newCursor).toBe(at(420));

    const second = fetchMessages(first.newCursor, { dbPath, overlapSeconds: 0 });
    expect(second.messages).toEqual([]);
    expect(second.newCursor).toBe(first.newCursor); // unchanged when no rows
  });

  test("cursor comparison is strictly greater-than", () => {
    const { messages } = fetchMessages(at(0), { dbPath, overlapSeconds: 0 });
    expect(messages.map((m) => m.sourceId)).toEqual(["g-2", "g-5", "g-6"]);
  });

  test("overlap window re-reads late-arriving rows without moving the cursor back", () => {
    const { messages, newCursor } = fetchMessages(at(300), { dbPath, overlapSeconds: 60 });
    expect(messages.map((m) => m.sourceId)).toEqual(["g-6"]); // at(300) itself, caught by overlap
    expect(newCursor).toBe(at(420));
  });
});

describe("timestamp conversion", () => {
  test("apple ns ↔ unix round trip", () => {
    const unixSeconds = Date.parse("2026-07-18T12:00:00Z") / 1000;
    expect(appleNsToDate(unixSecondsToAppleNs(unixSeconds)).toISOString()).toBe(
      "2026-07-18T12:00:00.000Z",
    );
  });

  test("legacy pre-10.13 second-resolution values are detected by magnitude", () => {
    expect(appleNsToDate(1n).toISOString()).toBe("2001-01-01T00:00:01.000Z");
  });
});
