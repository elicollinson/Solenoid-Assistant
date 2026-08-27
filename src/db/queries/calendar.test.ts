// The Calendar surface, checked against the design it came from.
//
// The design stores the week as seven labelled columns, each item's day as a
// key, its state as a word and the line above the grid as a sentence with four
// numbers in it. Every one of those is a reading of the clock against rows that
// already exist, so what is worth guarding is that the reading lands where the
// design says — and that the two kinds nothing else in the database knows about
// are the only two that were written down.
import { Elysia } from "elysia";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, type Db } from "../index";
import * as s from "../schema";
import { createUiRoutes } from "../../http/routes/ui";
import { loadCalendar, loadCalendarItem, type CalendarDetailPayload, type CalendarPayload } from "./calendar";
import { seedDesignFixtures } from "../seed/design";
import { zonedTime } from "../seed/time";

let dir: string;
let db: Db;
let week: CalendarPayload;

// The same fixed morning every other surface's tests use. It is a Tuesday, so
// nothing here can be right by accident of the design's week starting Monday.
const MORNING = zonedTime(2026, 8, 25, 9, 20);

const item = (title: string) => week.items.find((i) => i.title === title);

const on = (day: string) => week.items.filter((i) => i.day === day);

const detail = (title: string): CalendarDetailPayload => {
  const found = item(title);
  if (!found) throw new Error(`nothing on the calendar called "${title}"`);
  const one = loadCalendarItem(db, found.id, MORNING);
  if (!one) throw new Error(`"${title}" did not load`);
  return one;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-calendar-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  seedDesignFixtures(db, { now: MORNING });
  week = loadCalendar(db, MORNING);
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the week", () => {
  test("is seven days from today, named and dated off the clock", () => {
    expect(week.days.map((d) => `${d.label} ${d.date}`)).toEqual([
      "Tue 25",
      "Wed 26",
      "Thu 27",
      "Fri 28",
      "Sat 29",
      "Sun 30",
      "Mon 31",
    ]);
    expect(week.days.filter((d) => d.today).map((d) => d.key)).toEqual(["d0"]);
    expect(week.range).toBe("Aug 25 – 31, 2026");
  });

  test("the now-line is where the clock is", () => {
    expect(week.now).toBe(9 * 60 + 20);
  });

  test("the line above the grid counts the day underneath it", () => {
    expect(week.lede).toBe(
      "Five of my runs and two of your commitments. One run is still going and one asked for you at 07:38.",
    );
  });

  test("what I held back from doing is written, and only about today", () => {
    expect(week.days[0]?.restraint).toBe(
      "I moved the Latham review onto today and told you at the time. I have not touched anything after six this evening.",
    );
    expect(week.days.slice(1).every((d) => d.restraint === null)).toBe(true);
  });

  test("each day tallies its own four kinds", () => {
    expect(week.days[0]?.counts).toEqual([
      { label: "Your events", value: "2" },
      { label: "My runs", value: "5" },
      { label: "Reminders", value: "2" },
      { label: "Held slots", value: "0" },
    ]);
    expect(week.days[2]?.counts.find((c) => c.label === "Held slots")?.value).toBe("1");
  });
});

describe("what I wrote down", () => {
  test("only the two kinds nothing else knows about are rows", () => {
    const kinds = new Set(db.select().from(s.calendarItems).all().map((row) => row.kind));
    expect([...kinds].sort()).toEqual(["event", "hold"]);
  });

  test("an event carries its own line and where it is", () => {
    expect(item("Latham quarter review")).toMatchObject({
      day: "d0",
      start: "10:00",
      end: "11:30",
      kind: "event",
      state: null,
      meta: "Room 2 · four people",
    });
  });

  test("a hold is anchored to the day I said it was on, not to an offset", () => {
    // "Thursday morning or Friday afternoon" is what the reminder says. Today
    // is a Tuesday, so a fixed offset from the design's Monday would put both
    // windows on the wrong days and make the agent contradict itself.
    expect(item("Boiler service — first slot")).toMatchObject({ day: "d2", start: "08:00", kind: "hold" });
    expect(item("Boiler service — second slot")).toMatchObject({ day: "d3", start: "13:00", kind: "hold" });
    expect(item("Standup")?.day).toBe("d2");
  });

  test("the standup sits inside the first window, which is the whole argument", () => {
    const hold = item("Boiler service — first slot");
    const standup = item("Standup");
    expect(hold?.day).toBe(standup?.day ?? "");
    expect((standup?.start ?? "") > (hold?.start ?? "")).toBe(true);
    expect((standup?.end ?? "") < (hold?.end ?? "")).toBe(true);
  });
});

describe("my runs, which belong to Workflows", () => {
  test("what has run today is read off the runs, not written here", () => {
    expect(on("d0").filter((i) => i.kind === "run").map((i) => `${i.title} ${i.meta}`)).toEqual([
      "inbox-triage run 212 · 41m 12s",
      "vendor-reconciliation run 14 · step 6/11",
      "contract-review run 3 · waiting at 4/7",
      "bill-watch run 1417 · 11.0s",
      "calendar-tidy daily · 22:00",
    ]);
  });

  test("a run still going ends at the clock, so the block grows through the morning", () => {
    expect(item("vendor-reconciliation")).toMatchObject({ start: "06:12", end: "09:20", state: "running" });
  });

  test("a run three hours before the canvas starts is left off rather than drawn above it", () => {
    // memory-compaction ran at 03:01. It is on Workflows, where there is room
    // for it; there is nowhere on a grid that starts at six to put it.
    expect(item("memory-compaction")).toBeUndefined();
  });
});

describe("runs that have not happened yet", () => {
  test("are expanded from the schedule rather than written as rows", () => {
    const triage = week.items.filter((i) => i.title === "inbox-triage" && i.state === null);
    expect(triage.map((i) => i.day)).toEqual(["d1", "d2", "d3", "d6"]);
    expect(triage[0]).toMatchObject({ start: "06:00", meta: "weekdays · 06:00" });
  });

  test("the weekend has no weekday read on it", () => {
    expect(on("d4").some((i) => i.title === "inbox-triage")).toBe(false);
    expect(on("d5").some((i) => i.title === "inbox-triage")).toBe(false);
  });

  test("the digest lands on the Sunday its rule names", () => {
    expect(week.items.find((i) => i.title === "weekly-digest")).toMatchObject({ day: "d5", start: "21:00" });
  });

  test("an hourly check is not drawn sixteen times a day", () => {
    // bill-watch runs every hour. It is on today as the run that actually
    // happened; drawing every future firing would bury everything you have to
    // be somewhere for.
    expect(week.items.filter((i) => i.title === "bill-watch").length).toBe(1);
  });

  test("nothing already past is offered as still to come", () => {
    const today = on("d0").filter((i) => i.state === null && i.kind === "run");
    expect(today.every((i) => i.start > "09:20")).toBe(true);
  });
});

describe("reminders, which belong to Reminders", () => {
  test("everything with a date inside the week is on it", () => {
    expect(week.items.filter((i) => i.kind === "reminder").map((i) => `${i.day} ${i.title}`)).toEqual([
      "d0 Pick a slot for the boiler service",
      "d0 Call Marta back",
      "d2 Send the review notes round",
      "d4 Renew the parking permit",
    ]);
  });

  test("only the one being asked about carries a mark", () => {
    expect(item("Pick a slot for the boiler service")?.state).toBe("attention");
    expect(item("Call Marta back")?.state).toBeNull();
  });

  test("something closed, and something with no date, is on neither", () => {
    expect(item("Send Priya the revised figures")).toBeUndefined();
    expect(item("Look again at the job listings sweep")).toBeUndefined();
  });
});

describe("one thing on the canvas", () => {
  test("an event reads what it was written with, and what is read off the row", () => {
    const one = detail("Latham quarter review");
    expect(one.when).toBe("Today, 10:00 – 11:30");
    expect(one.account[0]).toContain("Yours, not mine.");
    expect(one.pairs).toEqual([
      { label: "Kind", value: "event" },
      { label: "Where", value: "Room 2" },
      { label: "Set by", value: "you" },
      // Read off movedFromAt, so it names the day the dentist is actually on.
      { label: "Moved", value: "from Aug 26" },
      { label: "With", value: "four people" },
    ]);
    expect(one.actions.map((a) => a.label)).toEqual(["Show me the notes", "Move it back"]);
    expect(one.link).toBeNull();
  });

  test("a hold says who offered it and what it runs into", () => {
    const one = detail("Boiler service — first slot");
    expect(one.when).toBe("Thu 27, 08:00 – 11:00");
    expect(one.pairs).toEqual([
      { label: "Kind", value: "hold" },
      { label: "Set by", value: "me" },
      { label: "Who", value: "Fenwick Heating" },
      { label: "Clashes", value: "standup" },
      // Written as a pair, dated against the anchor rather than frozen.
      { label: "Offered", value: "Aug 22" },
    ]);
    expect(one.actions.map((a) => a.label)).toEqual(["Take this one", "Take Friday instead"]);
  });

  test("a run tells the account it wrote about itself, and offers the way back", () => {
    const one = detail("vendor-reconciliation");
    expect(one.when).toBe("Today, from 06:12");
    expect(one.account[0]).toContain("I started at 06:12");
    expect(one.pairs).toEqual([
      { label: "Kind", value: "workflow run" },
      { label: "Trigger", value: "manual" },
      { label: "Step", value: "6/11" },
      { label: "Median", value: "18m 40s" },
    ]);
    expect(one.link).toMatchObject({ label: "Workflow · Q3 vendor reconciliation", effectKind: "navigate" });
    expect(one.link?.effect).toEqual({ view: "Workflows", id: "vendor-reconciliation" });
  });

  test("a run that has not happened says what it says every time it runs", () => {
    const one = detail("calendar-tidy");
    expect(one.when).toBe("Today, 22:00");
    expect(one.account[0]).toContain("I moved two overlapping meetings");
    expect(one.pairs.map((p) => p.label)).toEqual(["Kind", "Trigger", "Cadence", "Median"]);
    expect(one.pairs[0]).toEqual({ label: "Kind", value: "scheduled run" });
    expect(one.link?.label).toBe("Workflow · Calendar tidy");
  });

  test("a reminder reads the account Reminders holds, and links back to it", () => {
    const one = detail("Call Marta back");
    expect(one.when).toBe("Today, 19:00");
    expect(one.account[0]).toContain("She called on Tuesday while you were out.");
    expect(one.pairs[0]).toEqual({ label: "Kind", value: "reminder" });
    expect(one.link?.label).toBe("Reminder · Call Marta back");
  });

  test("a schedule's id survives the round trip, having no row to be found by", () => {
    const scheduled = week.items.find((i) => i.id.startsWith("schedule:"));
    expect(scheduled?.id).toContain("schedule:calendar-tidy:");
    expect(loadCalendarItem(db, scheduled?.id ?? "", MORNING)?.title).toBe("calendar-tidy");
  });

  test("nothing answers for an id that is not there", () => {
    expect(loadCalendarItem(db, "nope", MORNING)).toBeNull();
    expect(loadCalendarItem(db, "schedule:not-a-workflow:0", MORNING)).toBeNull();
  });
});

describe("over HTTP", () => {
  test("GET /api/calendar answers with the week", async () => {
    const app = new Elysia().use(createUiRoutes(() => db));
    const response = await app.handle(new Request("http://localhost/api/calendar"));
    expect(response.status).toBe(200);
    expect((await response.json()) as CalendarPayload).toHaveProperty("days");
  });

  test("GET /api/calendar/:id answers 404 for something that is not on it", async () => {
    const app = new Elysia().use(createUiRoutes(() => db));
    const response = await app.handle(new Request("http://localhost/api/calendar/nope"));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("Nothing on the calendar with id nope");
  });
});
