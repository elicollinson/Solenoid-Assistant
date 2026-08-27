// The phone asks for the phone's words, and settles for the desktop's.
//
// Everything the phone draws goes through this seam: a `surface` on the way in,
// a sentence written for that surface on the way out, and the desktop's copy
// where nobody has written one. It is worth its own test because the failure is
// silent — a loader that forgot to pass the surface through would still answer
// 200, with the desktop's long sentences on a 390px screen.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, type Db } from "../index";
import { loadCalendar } from "./calendar";
import { loadHome } from "./home";
import { loadKnowledge } from "./knowledge";
import { loadReminders } from "./reminders";
import { loadWorkflow, loadWorkflows } from "./workflows";
import { seedDesignFixtures } from "../seed/design";
import { PHONE_CALENDAR_DAYS, PHONE_WORKFLOW_LEDE, PHONE_WORKFLOW_SHEET } from "../seed/phone";
import { zonedTime } from "../seed/time";

let dir: string;
let db: Db;

const MORNING = zonedTime(2026, 8, 25, 9, 20);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-surface-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  seedDesignFixtures(db, { now: MORNING });
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the workflow table", () => {
  test("says one thing to the desktop and a shorter thing to the phone", () => {
    const desktop = loadWorkflows(db, MORNING);
    const phone = loadWorkflows(db, MORNING, "phone");
    expect(desktop.lede).toStartWith("Everything I run for you, on a schedule or on demand.");
    expect(phone.lede).toStartWith("Everything I run for you. One is going now;");
    expect(phone.lede).not.toBe(desktop.lede);
  });

  test("both still end in the same count, because a count is not copy", () => {
    const tally = "One is going now; one stopped; one is waiting on you.";
    expect(loadWorkflows(db, MORNING).lede).toEndWith(tally);
    expect(loadWorkflows(db, MORNING, "phone").lede).toEndWith(tally);
  });

  test("a phone row carries a sentence the desktop row has no column for", () => {
    const phone = loadWorkflows(db, MORNING, "phone");
    const row = phone.rows.find((r) => r.slug === "vendor-reconciliation");
    expect(row?.lede).toBe(PHONE_WORKFLOW_LEDE["vendor-reconciliation"] ?? "");
    expect(loadWorkflows(db, MORNING).rows.every((r) => r.lede === null)).toBe(true);
  });

  test("what I have not done sits under the list, and only on the phone", () => {
    expect(loadWorkflows(db, MORNING, "phone").restraint).toContain("did not restart the digest");
    expect(loadWorkflows(db, MORNING).restraint).toBeNull();
  });
});

describe("one workflow", () => {
  test("the phone's sheet says it in a third of the words", () => {
    const phone = loadWorkflow(db, "weekly-digest", MORNING, "phone");
    expect(phone?.summary).toBe(PHONE_WORKFLOW_SHEET["weekly-digest"] ?? "");
  });

  test("the desktop keeps the long one — the phone did not overwrite it", () => {
    const desktop = loadWorkflow(db, "weekly-digest", MORNING);
    expect(desktop?.summary).not.toBe(PHONE_WORKFLOW_SHEET["weekly-digest"]);
    expect(desktop?.summary?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("the calendar", () => {
  const COUNTED = /(of my runs|run of mine|None of my runs) and (one commitment of yours|nothing of yours|\w+ of your commitments)\./;

  test("every day says what is on it, because the phone can only show one", () => {
    for (const day of loadCalendar(db, MORNING, "phone").days) expect(day.lede).toMatch(COUNTED);
  });

  test("the days I wrote a line about carry it in front of that count", () => {
    const phone = loadCalendar(db, MORNING, "phone");
    const written = phone.days.filter((day) => PHONE_CALENDAR_DAYS.some((fixture) => day.lede.startsWith(fixture.text)));
    // Five are written; an offset and a weekday can land on one date, so four
    // is the floor and the collision is the seed's documented trade.
    expect(written.length).toBeGreaterThanOrEqual(4);
    expect(phone.days.some((d) => d.lede.startsWith("The site walk takes the afternoon"))).toBe(true);
  });

  test("nothing the design counted was stored — the numbers are all read", () => {
    // The design writes "Two of my runs sit behind your morning" above day
    // zero. This database puts five runs on it, so a stored sentence would be
    // wrong the moment it was drawn.
    const phone = loadCalendar(db, MORNING, "phone");
    expect(phone.days[0]?.lede).not.toContain("Two of my runs sit behind your morning");
    expect(phone.days[0]?.lede).toStartWith("Five of my runs");
  });

  test("the desktop gets the same counts and none of the phone's sentences", () => {
    const desktop = loadCalendar(db, MORNING);
    expect(desktop.days[0]?.lede).toBe(desktop.lede);
    expect(desktop.days.some((d) => d.lede.includes("The site walk takes the afternoon"))).toBe(false);
  });

  test("the week's restraint is standing rather than dated, and phone-only", () => {
    expect(loadCalendar(db, MORNING, "phone").restraint).toContain("holding both boiler windows");
    expect(loadCalendar(db, MORNING).restraint).toBeNull();
  });

  test("today's own restraint is still there on both — it was never phone copy", () => {
    for (const surface of ["desktop", "phone"] as const) {
      const today = loadCalendar(db, MORNING, surface).days[0];
      expect(today?.restraint).toContain("I moved the Latham review onto today");
    }
  });
});

describe("things I know", () => {
  test("the phone opens with a sentence instead of two counts", () => {
    const phone = loadKnowledge(db, MORNING, "phone");
    expect(phone.lede).toStartWith("Everything I've written down.");
  });

  test("but what is unsettled is still counted, not claimed", () => {
    // The store is empty here — no OKF bundle was indexed — so there is nothing
    // to be unsettled about and the authored opening stands alone. What matters
    // is that the count is not baked into the sentence.
    const phone = loadKnowledge(db, MORNING, "phone");
    expect(phone.lede).not.toContain("One object is holding");
  });

  test("the desktop still counts the store in its own opening", () => {
    expect(loadKnowledge(db, MORNING).lede).toContain("discrete facts pulled out of them");
  });
});

describe("the fallback", () => {
  test("a screen with no phone copy is handed the desktop's rather than a blank", () => {
    // Reminders has no phone screen and so no phone line. Asking for one as the
    // phone still answers, because an empty lede reads as a bug and a long one
    // only reads as long.
    expect(loadReminders(db, MORNING).lede).toContain("Things I'm holding for you");
  });

  test("home has copy on both, and they differ", () => {
    expect(loadHome(db, MORNING).header.lede).toStartWith("I handled nine things overnight.");
    expect(loadHome(db, MORNING, "phone").header.lede).toStartWith("Nine things done overnight.");
  });

  test("the count after the line is the same sentence on both", () => {
    const clause = (lede: string) => lede.slice(lede.indexOf(".") + 1).trim();
    expect(clause(loadHome(db, MORNING, "phone").header.lede)).toBe(clause(loadHome(db, MORNING).header.lede));
  });
});
