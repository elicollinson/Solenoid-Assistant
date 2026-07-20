import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrustGate, type TrustGate } from "../contacts/trustGate";
import { unixSecondsToAppleNs } from "./reader";
import { fetchTrustedMessages } from "./trusted";

const NS = 1_000_000_000n;
const T0_ISO = "2026-07-18T12:00:00Z";
const T0_MS = Date.parse(T0_ISO);
const T0 = unixSecondsToAppleNs(T0_MS / 1000);
const at = (seconds: number) => T0 + BigInt(seconds) * NS;
const atDate = (seconds: number) => new Date(T0_MS + seconds * 1000);

let dir: string;
let dbPath: string;
let gate: TrustGate;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "trusted-fetch-test-"));

  // Address book fixture: Ada is the only contact.
  const abDir = join(dir, "ab");
  mkdirSync(abDir, { recursive: true });
  const ab = new Database(join(abDir, "AddressBook-v22.abcddb"), { create: true });
  ab.run(`CREATE TABLE ZABCDRECORD (
    Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT,
    ZNICKNAME TEXT, ZORGANIZATION TEXT)`);
  ab.run(`CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZFULLNUMBER TEXT, ZOWNER INTEGER)`);
  ab.run(`CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZADDRESS TEXT, ZOWNER INTEGER)`);
  ab.run(`INSERT INTO ZABCDRECORD VALUES (1, 'Ada', 'Lovelace', NULL, NULL)`);
  ab.run(`INSERT INTO ZABCDPHONENUMBER VALUES (1, '(555) 123-4567', 1)`);
  ab.close();
  gate = createTrustGate({ addressBookDir: abDir });

  // chat.db fixture: Ada (trusted), a stranger, and own messages.
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
  db.run(`INSERT INTO handle VALUES (1, '+15551234567', 'iMessage'), (2, '+19990001111', 'SMS')`);
  db.run(`INSERT INTO chat VALUES (1, 'c-1', '+15551234567', '', 'iMessage')`);

  const insert = db.prepare(`INSERT INTO message VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run(1n, "g-ada-1", "hi", null, at(0), 0n, 1n, "iMessage", 0n, 0n, 0n, null);
  insert.run(2n, "g-me", "hey Ada", null, at(60), 1n, 0n, "iMessage", 0n, 0n, 0n, null);
  insert.run(3n, "g-stranger", "you won a prize", null, at(120), 0n, 2n, "SMS", 0n, 0n, 0n, null);
  insert.run(4n, "g-ada-2", "lunch?", null, at(180), 0n, 1n, "iMessage", 0n, 0n, 0n, null);
  db.run(`INSERT INTO chat_message_join VALUES (1,1), (1,2), (1,4)`);
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("fetchTrustedMessages", () => {
  test("drops unknown senders, keeps own, enriches senderName", () => {
    const { messages, totalInWindow, droppedUntrusted } = fetchTrustedMessages({
      start: atDate(0),
      end: atDate(300),
      gate,
      dbPath,
    });
    expect(messages.map((m) => m.sourceId)).toEqual(["g-ada-1", "g-me", "g-ada-2"]);
    expect(totalInWindow).toBe(4);
    expect(droppedUntrusted).toBe(1);
    expect(messages[0]!.senderName).toBe("Ada Lovelace");
    expect(messages[1]!.sender).toBe("me");
  });

  test("window bounds are inclusive on both ends", () => {
    const { messages } = fetchTrustedMessages({
      start: atDate(60),
      end: atDate(180),
      gate,
      dbPath,
    });
    expect(messages.map((m) => m.sourceId)).toEqual(["g-me", "g-ada-2"]);
  });

  test("includeOwn: false returns only incoming trusted messages", () => {
    const { messages, droppedUntrusted } = fetchTrustedMessages({
      start: atDate(0),
      end: atDate(300),
      includeOwn: false,
      gate,
      dbPath,
    });
    expect(messages.map((m) => m.sourceId)).toEqual(["g-ada-1", "g-ada-2"]);
    // Own messages are excluded, not "untrusted".
    expect(droppedUntrusted).toBe(1);
  });

  test("start defaults to 24h before end", () => {
    const { messages } = fetchTrustedMessages({ end: atDate(300), gate, dbPath });
    expect(messages).toHaveLength(3); // whole fixture is well within 24h of end
  });

  test("throws when start is after end", () => {
    expect(() =>
      fetchTrustedMessages({ start: atDate(300), end: atDate(0), gate, dbPath }),
    ).toThrow(/start .* after end/);
  });
});
