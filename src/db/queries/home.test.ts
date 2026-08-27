// What the home surface draws, checked against the design it came from.
//
// The point of these is the derivations: the design's fixtures store display
// strings ("Activity 12", "Two need a word from you", "11:00 Marta, 30 min")
// and the product computes them, so the thing worth guarding is that the
// computation still lands on what the design says.
import { Elysia } from "elysia";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, type Db } from "../index";
import { createUiRoutes } from "../../http/routes/ui";
import { loadHome, type HomePayload } from "./home";
import { seedDesignFixtures } from "../seed/design";
import { localTime, zonedTime } from "../seed/time";

let dir: string;
let db: Db;
let home: HomePayload;

// A fixed morning, so "this morning" and "good morning" are not a coin flip.
// 2026-08-25 is a Tuesday; 09:20 in New York is EDT, four hours behind UTC.
const MORNING = zonedTime(2026, 8, 25, 9, 20);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-home-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  seedDesignFixtures(db, { now: MORNING });
  home = loadHome(db, MORNING);
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the header", () => {
  test("greets by name and counts what is open", () => {
    expect(home.header.greeting).toBe("Good morning, Eli");
    expect(home.header.lede).toBe(
      "I handled nine things overnight. Two need a word from you before I go further.",
    );
  });

  test("the count is derived, not stored", () => {
    // Close both gates and the sentence has to change on its own.
    db.$client.exec(`UPDATE decisions SET state = 'resolved' WHERE state = 'open'`);
    const after = loadHome(db, MORNING);
    expect(after.header.lede).toBe("I handled nine things overnight. Nothing needs you right now.");
    expect(after.aside.waiting).toEqual([]);
    db.$client.exec(`UPDATE decisions SET state = 'open' WHERE state = 'resolved'`);
  });
});

describe("the feed", () => {
  test("groups by day, newest first, in the design's words", () => {
    expect(home.sections.map((s) => s.label)).toEqual(["This morning", "Yesterday"]);
    expect(home.sections[0]?.items.map((i) => i.title)).toEqual([
      "Reply to the Ferris contract amendment",
      "Q3 vendor reconciliation",
      "Filed six things into memory",
      "Merged fourteen duplicate facts",
    ]);
    expect(home.sections[1]?.items.map((i) => i.title)).toEqual([
      "Tidied two overlapping meetings",
      "Weekly digest stopped halfway",
    ]);
  });

  test("the approval carries its gate, its buttons and its tool calls", () => {
    const item = home.sections[0]?.items[0];
    expect(item?.state).toBe("attention");
    expect(item?.framed).toBe(true);
    expect(item?.time).toBe("07:41");
    expect(item?.decisionId).not.toBeNull();
    expect(item?.actions.map((a) => a.label)).toEqual(["Send it", "Read the draft", "Not this one"]);
    expect(item?.actions[0]?.stance).toBe("affirm");
    expect(item?.toolSummary).toBe("4 tool calls · gmail.draft, memory.read ×2, calendar.check");
    expect(item?.toolCalls).toEqual([
      { name: "memory.read", arg: "okf:contact/ferris", duration: "0.4s" },
      { name: "memory.read", arg: "okf:vendor/ferris-terms", duration: "0.3s" },
      { name: "calendar.check", arg: "mar-01..mar-07", duration: "0.2s" },
      { name: "gmail.draft", arg: "→ thread/1f8ac2", duration: "1.9s" },
    ]);
  });

  test("a running entry is dated from when it started and carries its meter", () => {
    const item = home.sections[0]?.items[1];
    expect(item?.state).toBe("running");
    expect(item?.time).toBe("since 06:12");
    expect(item?.badge).toBe("running · step 6/11");
    expect(item?.progress).toEqual({ value: 6, total: 11 });
    // Plain affordances, not a gate: these render as mono links, not buttons.
    expect(item?.decisionId).toBeNull();
    expect(item?.actions.map((a) => a.label)).toEqual(["Open workflow", "Pause", "Trace"]);
  });

  test("every entry carries the agent's own account of it", () => {
    for (const section of home.sections) {
      for (const item of section.items) expect(item.account).toBeTruthy();
    }
  });

  test("the failed entry offers the retry as destructive", () => {
    const item = home.sections[1]?.items[1];
    expect(item?.state).toBe("failed");
    expect(item?.framed).toBe(false);
    expect(item?.actions[0]).toMatchObject({ label: "Retry that step", stance: "danger" });
  });
});

describe("the rail", () => {
  test("counts what is actually there", () => {
    const byLabel = new Map(home.rail.groups.flatMap((g) => g.items).map((i) => [i.label, i]));
    expect(home.rail.groups.map((g) => g.label)).toEqual(["Today", "Memory", "Automation"]);
    expect(byLabel.get("Activity")?.count).toBe(6);
    // Six reminders are seeded; three are overdue or due today and still open.
    expect(byLabel.get("Reminders")?.count).toBe(3);
    expect(byLabel.get("Workflows")).toMatchObject({ count: 8, dot: "green" });
    expect(byLabel.get("Calendar")?.count).toBeNull();
  });

  test("the agent's state is one running thing, spelled out", () => {
    expect(home.rail.agent).toEqual({ running: 1, line: "Working on one thing" });
  });
});

describe("the aside", () => {
  test("waiting on you lists open decisions but not the standing suggestion", () => {
    expect(home.aside.waiting.map((w) => w.title)).toEqual([
      "Approve the Ferris contract reply",
      "Pick a slot for the boiler service",
    ]);
  });

  // Not a list of its own: it is the first three things on the calendar, and
  // the calendar is now the week the Calendar surface draws. The design gave
  // the aside two commitments its own calendar screen never has again.
  test("next up merges commitments with the next scheduled run", () => {
    expect(home.aside.nextUp).toEqual([
      { time: "10:00", what: "Latham quarter review, Room 2 · four people" },
      { time: "12:45", what: "Lunch with Dana Okonjo, Ferrier Row" },
      { time: "22:00", what: "Calendar tidy runs" },
    ]);
  });

  test("worth a look is the recommendation, with its two words", () => {
    expect(home.aside.worthALook?.body).toBe(
      "You've moved the Thursday standup three weeks running. Want me to shift it to Friday for good?",
    );
    expect(home.aside.worthALook?.actions.map((a) => a.label)).toEqual(["Do it", "Dismiss"]);
  });
});

describe("seeding", () => {
  test("re-running rebuilds rather than doubling", () => {
    seedDesignFixtures(db, { now: MORNING });
    const again = loadHome(db, MORNING);
    expect(again.sections.flatMap((s) => s.items).length).toBe(6);
    expect(again.aside.waiting.length).toBe(2);
  });

  test("wall-clock times land in the app's timezone, not UTC", () => {
    // 07:41 in New York on an August morning is 11:41Z.
    expect(localTime(MORNING, 0, 7, 41).toISOString()).toBe("2026-08-25T11:41:00.000Z");
    // And in January, when the zone is an hour further from UTC.
    expect(zonedTime(2026, 1, 15, 7, 41).toISOString()).toBe("2026-01-15T12:41:00.000Z");
  });
});

describe("the route", () => {
  test("GET /api/home answers with the payload", async () => {
    const app = new Elysia().use(createUiRoutes(() => db));
    const response = await app.handle(new Request("http://localhost/api/home"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as HomePayload;
    expect(body.header.greeting).toStartWith("Good ");
    expect(body.sections.flatMap((s) => s.items).length).toBe(6);
  });
});
