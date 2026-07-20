import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../imessage/reader";
import { createTrustGate, discoverAddressBookDbs } from "./trustGate";

let dir: string;

function createAbcddb(path: string, seed: (db: Database) => void): void {
  const db = new Database(path, { create: true });
  db.run(`CREATE TABLE ZABCDRECORD (
    Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT,
    ZNICKNAME TEXT, ZORGANIZATION TEXT)`);
  db.run(`CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZFULLNUMBER TEXT, ZOWNER INTEGER)`);
  db.run(`CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZADDRESS TEXT, ZOWNER INTEGER)`);
  seed(db);
  db.close();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "trust-gate-test-"));

  // Root db: local "On My Mac" contacts.
  createAbcddb(join(dir, "AddressBook-v22.abcddb"), (db) => {
    db.run(`INSERT INTO ZABCDRECORD VALUES (1, 'Ada', 'Lovelace', NULL, NULL)`);
    db.run(`INSERT INTO ZABCDPHONENUMBER VALUES (1, '(937) 974-9491', 1)`);
    // Contact saved WITHOUT country code — exercises the last-10 secondary key.
    db.run(`INSERT INTO ZABCDRECORD VALUES (2, 'Grace', 'Hopper', NULL, NULL)`);
    db.run(`INSERT INTO ZABCDPHONENUMBER VALUES (2, '555-867-5309', 2)`);
    // No first/last name — falls back to organization.
    db.run(`INSERT INTO ZABCDRECORD VALUES (3, NULL, NULL, NULL, 'Acme Corp')`);
    db.run(`INSERT INTO ZABCDEMAILADDRESS VALUES (1, 'Sales@ACME.example', 3)`);
    // Short code — must never become a trust key.
    db.run(`INSERT INTO ZABCDRECORD VALUES (4, 'Short', 'Code', NULL, NULL)`);
    db.run(`INSERT INTO ZABCDPHONENUMBER VALUES (3, '86753', 4)`);
  });

  // iCloud source db: the union requirement (§4.1) — root-only reads miss these.
  const sourceDir = join(dir, "Sources", "ABCD-EF01");
  mkdirSync(sourceDir, { recursive: true });
  createAbcddb(join(sourceDir, "AddressBook-v22.abcddb"), (db) => {
    db.run(`INSERT INTO ZABCDRECORD VALUES (1, 'Alan', 'Turing', NULL, NULL)`);
    db.run(`INSERT INTO ZABCDEMAILADDRESS VALUES (1, 'alan@bletchley.example', 1)`);
    // Same key as a root contact but nameless — first non-empty name wins.
    db.run(`INSERT INTO ZABCDRECORD VALUES (2, NULL, NULL, NULL, NULL)`);
    db.run(`INSERT INTO ZABCDPHONENUMBER VALUES (1, '+1 937 974 9491', 2)`);
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("discoverAddressBookDbs", () => {
  test("finds root db and every Sources/<UUID>/ db", () => {
    const paths = discoverAddressBookDbs(dir);
    expect(paths).toHaveLength(2);
    expect(paths.some((p) => p.includes("Sources"))).toBe(true);
  });

  test("returns empty for a missing directory", () => {
    expect(discoverAddressBookDbs(join(dir, "nope"))).toEqual([]);
  });
});

describe("createTrustGate", () => {
  test("unions all sources and reports size", () => {
    const gate = createTrustGate({ addressBookDir: dir });
    // Ada + Grace (short code excluded), Acme + Alan.
    expect(gate.size()).toEqual({ phones: 2, emails: 2 });
  });

  test("isTrusted matches E.164 handles regardless of stored formatting", () => {
    const gate = createTrustGate({ addressBookDir: dir });
    expect(gate.isTrusted("+19379749491")).toBe(true);
    expect(gate.isTrusted("alan@bletchley.example")).toBe(true);
    expect(gate.isTrusted("sales@acme.example")).toBe(true);
    expect(gate.isTrusted("+15550001111")).toBe(false);
  });

  test("'me' always passes the gate", () => {
    const gate = createTrustGate({ addressBookDir: dir });
    expect(gate.isTrusted("me")).toBe(true);
  });

  test("last-10 secondary lookup catches country-code mismatches", () => {
    const gate = createTrustGate({ addressBookDir: dir });
    // Handle has +1, contact was saved as 555-867-5309 (10 digits).
    expect(gate.isTrusted("+15558675309")).toBe(true);
    expect(gate.resolveName("+15558675309")).toBe("Grace Hopper");
  });

  test("short codes are never trusted", () => {
    const gate = createTrustGate({ addressBookDir: dir });
    expect(gate.isTrusted("86753")).toBe(false);
  });

  test("resolveName falls back through nickname/org and prefers non-empty names across sources", () => {
    const gate = createTrustGate({ addressBookDir: dir });
    expect(gate.resolveName("+19379749491")).toBe("Ada Lovelace"); // nameless iCloud dupe ignored
    expect(gate.resolveName("Sales@ACME.example")).toBe("Acme Corp");
    expect(gate.resolveName("+15550001111")).toBe(null);
  });

  test("filter keeps own + trusted messages and enriches senderName", () => {
    const gate = createTrustGate({ addressBookDir: dir });
    const msg = (sender: string, isFromMe = false): Message => ({
      sourceId: sender,
      body: "hi",
      sender,
      senderName: null,
      conversationId: "c",
      isFromMe,
      service: "iMessage",
      timestamp: new Date(),
      hasAttachments: false,
    });
    const kept = gate.filter([
      msg("+19379749491"),
      msg("+15550001111"), // unknown — dropped
      msg("me", true),
    ]);
    expect(kept.map((m) => m.sender)).toEqual(["+19379749491", "me"]);
    expect(kept[0]!.senderName).toBe("Ada Lovelace");
  });

  test("throws on zero contacts (closed failure) unless allowEmpty", () => {
    const emptyDir = join(dir, "empty-ab");
    mkdirSync(emptyDir, { recursive: true });
    createAbcddb(join(emptyDir, "AddressBook-v22.abcddb"), () => {});
    expect(() => createTrustGate({ addressBookDir: emptyDir })).toThrow(/zero contacts/);
    const gate = createTrustGate({ addressBookDir: emptyDir, allowEmpty: true });
    expect(gate.size()).toEqual({ phones: 0, emails: 0 });
  });

  test("schema mismatch produces a clear diagnostic, not a raw SQLite error", () => {
    const badDir = join(dir, "bad-schema");
    mkdirSync(badDir, { recursive: true });
    const db = new Database(join(badDir, "AddressBook-v22.abcddb"), { create: true });
    db.run(`CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY)`); // missing the rest
    db.close();
    expect(() => createTrustGate({ addressBookDir: badDir })).toThrow(/schema mismatch|§4.3/);
  });
});
