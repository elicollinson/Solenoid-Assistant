// Annotating a feed entry: the one write this product allows on the activity
// feed, and the guards that keep it from becoming the other one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, ulid, type Db } from "../index";
import * as s from "../schema";
import { NoSuchActivityItemError, annotateActivityItem } from "./activity";

let dir: string;
let db: Db;
let itemId: string;

const trail = () =>
  db.select().from(s.subjectEvents).where(eq(s.subjectEvents.subjectId, itemId)).all();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "activity-notes-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);

  itemId = ulid();
  const now = new Date("2026-08-28T09:00:00Z");
  db.insert(s.entities)
    .values({ id: itemId, kind: "activity_item", createdAt: now, updatedAt: now })
    .run();
  db.insert(s.activityItems)
    .values({ id: itemId, occurredAt: now, title: "Q3 vendor reconciliation", state: "done" })
    .run();
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("annotateActivityItem", () => {
  test("appends a note to the entry's trail and answers with its id", () => {
    const noteId = annotateActivityItem(db, itemId, "The vendor replied an hour after this ran.");

    const notes = trail();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      id: noteId,
      subjectId: itemId,
      eventKind: "note",
      actor: "agent",
      text: "The vendor replied an hour after this ran.",
    });
  });

  test("keeps notes in the order they were made", () => {
    annotateActivityItem(db, itemId, "first", { at: new Date("2026-08-28T10:00:00Z") });
    annotateActivityItem(db, itemId, "second", { at: new Date("2026-08-28T11:00:00Z") });

    expect(trail().sort((a, b) => a.at.getTime() - b.at.getTime()).map((n) => n.text))
      .toEqual(["first", "second"]);
  });

  test("records who is speaking, and the run it came out of", () => {
    annotateActivityItem(db, itemId, "noted", { by: "user", runId: "run-7" });
    expect(trail()[0]).toMatchObject({ actor: "user", runId: "run-7" });
  });

  // The failure this prevents is a note about nothing becoming the only
  // evidence that a thing happened.
  test("refuses an entry that does not exist, and writes nothing", () => {
    expect(() => annotateActivityItem(db, "no-such-item", "hello")).toThrow(NoSuchActivityItemError);
    expect(db.select().from(s.subjectEvents).all()).toEqual([]);
  });

  test("refuses an empty note rather than writing a blank line into the record", () => {
    expect(() => annotateActivityItem(db, itemId, "   ")).toThrow(/needs something in it/);
    expect(trail()).toEqual([]);
  });

  test("trims what it is given", () => {
    annotateActivityItem(db, itemId, "  padded  ");
    expect(trail()[0]?.text).toBe("padded");
  });

  // Nothing here writes the entry itself. A note is a remark about a record, so
  // the record must read exactly as it did before.
  test("leaves the entry it annotates untouched", () => {
    const before = db.select().from(s.activityItems).where(eq(s.activityItems.id, itemId)).get();
    annotateActivityItem(db, itemId, "a note");
    expect(db.select().from(s.activityItems).where(eq(s.activityItems.id, itemId)).get())
      .toEqual(before!);
  });
});
