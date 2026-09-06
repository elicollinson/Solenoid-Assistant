// The four things that can happen to a reminder, and what the surface reads
// back afterwards.
//
// Each test writes through the mutation and then asks the same query the screen
// asks, because the pair is the contract: a reminder completed here that the
// list still draws as overdue, or one rescheduled that stays in yesterday's
// bucket, is the bug worth catching. The same bargain ./recommendations.test.ts
// strikes with the suggestions table.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, ulid, type Db } from "../index";
import * as s from "../schema";
import { loadReminder, loadReminders } from "../queries/reminders";
import {
  NoSuchReminderError,
  ReminderSettledError,
  completeReminder,
  createReminder,
  dismissReminder,
  reviseReminder,
  type ReminderDraft,
} from "./reminders";

let dir: string;
let db: Db;

/** 09:20 in the timezone the product runs in, so "today" means today. */
const NOW = new Date("2026-08-25T13:20:00Z");
const TOMORROW = new Date("2026-08-26T13:00:00Z");
const YESTERDAY = new Date("2026-08-24T13:00:00Z");

/** A whole one, so each test can close it without restating the draft. */
const create = (over: Partial<ReminderDraft> = {}) =>
  createReminder(
    db,
    {
      title: "Send Fenwick the meter reading",
      blurb: "Their terms give you until the 30th, and the reading has to be theirs, not yours.",
      prose: ["They will estimate if nothing arrives.", "I have not sent it because the photo is yours to take."],
      dueAt: TOMORROW,
      origin: { kind: "conversation", label: "from thread/9a44" },
      meta: [["Invoices", "two, £84 between them"]],
      ...over,
    },
    NOW,
  );

const one = (id: string) => loadReminder(db, id, NOW);
const rows = () => loadReminders(db, NOW).rows;
const row = (id: string) => rows().find((r) => r.id === id);
const stored = (id: string) => db.select().from(s.reminders).where(eq(s.reminders.id, id)).all()[0];
const trail = (id: string) =>
  db.select().from(s.subjectEvents).where(eq(s.subjectEvents.subjectId, id)).all();

/** A question open on a reminder, the way the seed writes one: the decision
 *  points at the reminder and the reminder points back. */
function askOn(id: string): string {
  const decisionId = ulid();
  db.insert(s.entities).values({ id: decisionId, kind: "decision", createdAt: NOW, updatedAt: NOW }).run();
  db.insert(s.decisions)
    .values({ id: decisionId, subjectId: id, title: "Which window?", state: "open", blocking: false, openedAt: NOW })
    .run();
  db.update(s.reminders).set({ decisionId }).where(eq(s.reminders.id, id)).run();
  return decisionId;
}

const decision = (decisionId: string) =>
  db.select().from(s.decisions).where(eq(s.decisions.id, decisionId)).all()[0];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-reminder-mutations-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("creating", () => {
  test("lands on the list with everything it was given, in the bucket its date puts it", () => {
    const id = create();
    const reminder = one(id);

    expect(reminder?.title).toBe("Send Fenwick the meter reading");
    expect(reminder?.group).toBe("This week");
    expect(reminder?.when).toBe("Tomorrow 09:00");
    expect(reminder?.state).toBe("idle");
    expect(reminder?.note).toStartWith("Their terms give you until the 30th");
    expect(reminder?.prose.length).toBe(2);
    expect(reminder?.source).toBe("from thread/9a44");
    expect(reminder?.meta).toContainEqual({ label: "Invoices", value: "two, £84 between them" });
    // Who set it and when it is due are read off the columns, not written.
    expect(reminder?.meta[0]).toEqual({ label: "Set by", value: "me · Today 09:20" });
    // The pair spells the date out; only the row's own "when" is relative.
    expect(reminder?.meta).toContainEqual({ label: "Due", value: "Aug 26, 09:00" });
  });

  test("no date is a real answer, and it is called Someday", () => {
    const id = create({ dueAt: null, origin: {} });
    expect(row(id)?.group).toBe("Someday");
    expect(row(id)?.when).toBe("No date");
    // Nothing prompted it, so the row says so rather than naming a source.
    expect(row(id)?.source).toBe("set by me");
  });

  test("a title is the least it can be, and nothing is invented around it", () => {
    const id = createReminder(db, { title: "Renew the resident permit" }, NOW);
    const reminder = one(id);
    expect(reminder?.title).toBe("Renew the resident permit");
    expect(reminder?.prose).toEqual([]);
    expect(reminder?.note).toBe("");
    expect(reminder?.gate).toBeNull();
    // The trail starts empty: setting it is not something done about it.
    expect(reminder?.history).toEqual([]);
  });

  test("a date in the past is overdue rather than refused — that is what the list is for", () => {
    const id = create({ dueAt: YESTERDAY });
    expect(row(id)?.group).toBe("Overdue");
    expect(loadReminders(db, NOW).lede).toContain("past when you asked to hear about it");
  });

  test("refuses a title that is only whitespace, and an origin pointing at nothing", () => {
    expect(() => createReminder(db, { title: "   " }, NOW)).toThrow(/needs a title/);
    expect(() => create({ origin: { id: "01NOTHING" } })).toThrow(/Nothing with id/);
    expect(rows()).toEqual([]);
  });
});

describe("revising", () => {
  test("changes what it is given and leaves the rest alone", () => {
    const id = create();
    reviseReminder(db, id, { blurb: "The 30th is theirs, not ours.", state: "attention" }, NOW);

    const reminder = one(id);
    expect(reminder?.note).toBe("The 30th is theirs, not ours.");
    expect(reminder?.state).toBe("attention");
    // Untouched.
    expect(reminder?.prose.length).toBe(2);
    expect(reminder?.when).toBe("Tomorrow 09:00");
  });

  test("a new date moves the bucket, which is the whole point of rescheduling in place", () => {
    const id = create({ dueAt: YESTERDAY });
    expect(row(id)?.group).toBe("Overdue");

    reviseReminder(db, id, { dueAt: new Date("2026-08-25T20:00:00Z") }, NOW);
    expect(row(id)?.group).toBe("Today");
    expect(row(id)?.when).toBe("Today 16:00");
  });

  test("clearing the date puts it on Someday rather than leaving it late forever", () => {
    const id = create({ dueAt: YESTERDAY });
    reviseReminder(db, id, { dueAt: null }, NOW);
    expect(row(id)?.group).toBe("Someday");
    expect(one(id)?.meta).toContainEqual({ label: "Due", value: "No date" });
  });

  test("a list given replaces the list that was there rather than adding to it", () => {
    const id = create();
    reviseReminder(db, id, { prose: ["One paragraph now."], meta: [["Amount", "£84"]] }, NOW);

    const reminder = one(id);
    expect(reminder?.prose).toEqual(["One paragraph now."]);
    expect(reminder?.meta.filter((p) => p.label === "Invoices")).toEqual([]);
    expect(reminder?.meta).toContainEqual({ label: "Amount", value: "£84" });
  });

  test("is refused once it has been closed, either way", () => {
    const done = create();
    completeReminder(db, done, {}, NOW);
    expect(() => reviseReminder(db, done, { title: "something else" }, NOW)).toThrow(ReminderSettledError);

    const called_off = create();
    dismissReminder(db, called_off, "They paid it on the 12th.", NOW);
    expect(() => reviseReminder(db, called_off, { title: "something else" }, NOW)).toThrow(ReminderSettledError);
  });

  test("says so when the id names nothing", () => {
    expect(() => reviseReminder(db, "01NOTHING", { title: "t" }, NOW)).toThrow(NoSuchReminderError);
  });
});

describe("completing", () => {
  test("moves it to Closed, marks it done and says when", () => {
    const id = create();
    completeReminder(db, id, { because: "Sent it with this morning's batch." }, NOW);

    const reminder = one(id);
    expect(reminder?.group).toBe("Closed");
    expect(reminder?.state).toBe("done");
    expect(reminder?.meta).toContainEqual({ label: "Closed", value: "Today 09:20" });
    // Something closed no longer draws a date it will not be acted on.
    expect(reminder?.meta.some((p) => p.label === "Due")).toBe(false);
  });

  test("the reason is written where somebody will actually read it", () => {
    const id = create();
    completeReminder(db, id, { because: "Sent it with this morning's batch.", by: "user" }, NOW);

    expect(one(id)?.history).toEqual([{ t: "Today 09:20", text: "Sent it with this morning's batch." }]);
    expect(stored(id)?.completedReason).toBe("Sent it with this morning's batch.");
    expect(stored(id)?.completedBy).toBe("user");
  });

  test("closing in silence writes no trail line rather than inventing one", () => {
    const id = create();
    completeReminder(db, id, {}, NOW);
    expect(trail(id)).toEqual([]);
    expect(stored(id)?.completedReason).toBeNull();
  });

  test("answers the question that was open on it", () => {
    const id = create();
    const decisionId = askOn(id);
    expect(row(id)?.gated).toBe(true);

    completeReminder(db, id, { by: "user" }, NOW);
    expect(decision(decisionId)?.state).toBe("resolved");
    expect(decision(decisionId)?.resolvedBy).toBe("user");
    expect(one(id)?.gate).toBeNull();
  });

  test("closes at the moment it actually happened, when that was not now", () => {
    const id = create();
    completeReminder(db, id, { at: YESTERDAY }, NOW);
    expect(one(id)?.meta).toContainEqual({ label: "Closed", value: "Yesterday 09:00" });
  });

  test("cannot be done twice, and cannot be done to something called off", () => {
    const id = create();
    completeReminder(db, id, {}, NOW);
    expect(() => completeReminder(db, id, {}, NOW)).toThrow(ReminderSettledError);

    const other = create();
    dismissReminder(db, other, "They paid it on the 12th.", NOW);
    expect(() => completeReminder(db, other, {}, NOW)).toThrow(/already cancelled/);
  });
});

describe("dismissing", () => {
  test("closes it without claiming it was done, and stays quiet about it", () => {
    const id = create();
    dismissReminder(db, id, "They paid it on the 12th, so there is nothing left to chase.", NOW);

    const reminder = one(id);
    expect(reminder?.group).toBe("Closed");
    // Five states, four marks: something called off is quiet, not failed.
    expect(reminder?.state).toBe("idle");
    expect(stored(id)?.state).toBe("cancelled");
    expect(reminder?.history[0]?.text).toStartWith("They paid it on the 12th");
  });

  test("dismisses the question rather than answering it — nobody answered it", () => {
    const id = create();
    const decisionId = askOn(id);
    dismissReminder(db, id, "The window shut.", NOW);
    expect(decision(decisionId)?.state).toBe("dismissed");
  });

  test("insists on a reason, because a row that vanishes reads as one you lost", () => {
    const id = create();
    expect(() => dismissReminder(db, id, "   ", NOW)).toThrow(/Say why/);
    expect(row(id)?.group).toBe("This week");
  });
});
