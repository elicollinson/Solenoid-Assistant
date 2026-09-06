// The translation, and the reading that decides what actually fires.
//
// The bug this replaces was not a wrong answer — it was no answer: a schedule
// sat in `workflow_schedules` saying "Daily, 03:00", three surfaces drew it,
// and nothing anywhere read it. So the tests that matter here are the ones
// about visibility: a rule that cannot run has to come back as a reason, never
// as an absence.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, ulid, type Db } from "../db";
import * as s from "../db/schema";
import { readSchedules, rruleToCron, scheduleFingerprint } from "./schedule";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "schedule-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A workflow with a schedule, as the catalog and the agent between them make one. */
function scheduled(
  slug: string,
  rrule: string,
  options: { enabled?: boolean; paused?: boolean; args?: Record<string, unknown> } = {},
): string {
  const now = new Date();
  const id = ulid();
  db.insert(s.entities).values({ id, kind: "workflow", createdAt: now, updatedAt: now }).run();
  db.insert(s.workflows)
    .values({
      id,
      slug,
      name: slug,
      triggerKind: "schedule",
      createdAt: now,
      ...(options.paused ? { pausedAt: now } : {}),
    })
    .run();
  db.insert(s.workflowSchedules)
    .values({
      id: ulid(),
      workflowId: id,
      rrule,
      label: rrule,
      enabled: options.enabled ?? true,
      ...(options.args ? { args: options.args } : {}),
    })
    .run();
  return id;
}

describe("rruleToCron", () => {
  test("translates the shapes this product actually stores", () => {
    expect(rruleToCron("FREQ=DAILY;BYHOUR=3;BYMINUTE=0")).toBe("0 3 * * *");
    expect(rruleToCron("FREQ=DAILY;BYHOUR=22;BYMINUTE=0")).toBe("0 22 * * *");
    expect(rruleToCron("FREQ=HOURLY")).toBe("0 * * * *");
    expect(rruleToCron("FREQ=WEEKLY;BYDAY=SU;BYHOUR=21;BYMINUTE=0")).toBe("0 21 * * 0");
    expect(rruleToCron("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6;BYMINUTE=0")).toBe("0 6 * * 1,2,3,4,5");
  });

  test("is not case- or order-sensitive, because a rule is written by hand", () => {
    expect(rruleToCron("byhour=3;freq=daily;byminute=15")).toBe("15 3 * * *");
  });

  // Each of these would otherwise become a job firing at a time nobody asked
  // for, which is worse than one that visibly does not exist.
  test("refuses what it cannot translate exactly", () => {
    // Two hours, one cron field.
    expect(rruleToCron("FREQ=DAILY;BYHOUR=3,15;BYMINUTE=0")).toBeNull();
    // `*/2` counts from midnight; RRULE counts from the rule's start.
    expect(rruleToCron("FREQ=DAILY;INTERVAL=2;BYHOUR=3;BYMINUTE=0")).toBeNull();
    // Cron cannot say "and then stop".
    expect(rruleToCron("FREQ=DAILY;BYHOUR=3;COUNT=5")).toBeNull();
    expect(rruleToCron("FREQ=DAILY;BYHOUR=3;UNTIL=20261231T000000Z")).toBeNull();
    // Monthly and yearly are expressible in cron but are not stored anywhere in
    // this product; covering them untested would be worse than refusing them.
    expect(rruleToCron("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9")).toBeNull();
    expect(rruleToCron("FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0")).toBeNull();
    expect(rruleToCron("FREQ=DAILY")).toBeNull();
    expect(rruleToCron("")).toBeNull();
  });
});

describe("readSchedules", () => {
  test("hands back what can run, with the arguments to run it with", () => {
    scheduled("weather-briefing", "FREQ=DAILY;BYHOUR=7;BYMINUTE=0", { args: { city: "San Francisco" } });
    const { due, unusable } = readSchedules(db);

    expect(unusable).toEqual([]);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      slug: "weather-briefing",
      cron: "0 7 * * *",
      args: { city: "San Francisco" },
    });
  });

  test("a rule it cannot read is reported, not dropped", () => {
    scheduled("weather-briefing", "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9");
    const { due, unusable } = readSchedules(db);

    expect(due).toEqual([]);
    expect(unusable).toHaveLength(1);
    expect(unusable[0]).toMatchObject({
      slug: "weather-briefing",
      reason: "this rule does not translate to cron: FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9",
    });
    // Carried so the worker can clear its nextRunAt.
    expect(unusable[0]?.scheduleId).toBeTruthy();
  });

  test("a schedule with no code behind it is reported too", () => {
    scheduled("not-a-real-workflow", "FREQ=DAILY;BYHOUR=3;BYMINUTE=0");
    const { due, unusable } = readSchedules(db);

    expect(due).toEqual([]);
    expect(unusable[0]).toMatchObject({ slug: "not-a-real-workflow", reason: "there is no code behind it" });
  });

  // Disabled and paused are the two ways to mean "not now", and neither is a
  // fault, so neither is reported as one.
  test("a disabled rule and a paused workflow are simply absent", () => {
    scheduled("weather-briefing", "FREQ=DAILY;BYHOUR=7;BYMINUTE=0", { enabled: false });
    scheduled("message-extraction", "FREQ=DAILY;BYHOUR=3;BYMINUTE=0", { paused: true });
    expect(readSchedules(db)).toEqual({ due: [], unusable: [] });
  });

  test("defaults to no arguments rather than to null", () => {
    scheduled("message-extraction", "FREQ=DAILY;BYHOUR=3;BYMINUTE=0");
    expect(readSchedules(db).due[0]?.args).toEqual({});
  });
});

describe("scheduleFingerprint", () => {
  test("moves when a rule changes and holds still when nothing does", () => {
    scheduled("message-extraction", "FREQ=DAILY;BYHOUR=3;BYMINUTE=0");
    const before = scheduleFingerprint(readSchedules(db));
    expect(scheduleFingerprint(readSchedules(db))).toBe(before);

    db.update(s.workflowSchedules).set({ rrule: "FREQ=DAILY;BYHOUR=4;BYMINUTE=0" }).run();
    expect(scheduleFingerprint(readSchedules(db))).not.toBe(before);
  });

  // The reason it exists: the worker rebuilds its jobs when this moves, so a
  // fingerprint that changed on every read would tear down and rebuild every
  // job twice a minute.
  test("does not depend on the order rows come back in", () => {
    scheduled("message-extraction", "FREQ=DAILY;BYHOUR=3;BYMINUTE=0");
    scheduled("weather-briefing", "FREQ=DAILY;BYHOUR=7;BYMINUTE=0");
    const reading = readSchedules(db);
    const reversed = { ...reading, due: [...reading.due].reverse() };
    expect(scheduleFingerprint(reversed)).toBe(scheduleFingerprint(reading));
  });
});
