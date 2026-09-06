// The catalog seeds; it does not synchronise.
//
// This file exists because of one incident and guards against its return. The
// agent was asked to run iMessage extraction daily at 3am. It wrote
// `FREQ=DAILY;BYHOUR=3;BYMINUTE=0` into `workflow_schedules`, the Workflows
// screen drew it, the calendar laid it out, and the next server boot DELETED
// the row — because the catalog entry says `rrule: null` and boot called a
// function that read null as "there must be no schedule".
//
// Nothing was logged. The only trace was that 3am came and went.
//
// So the property under test is not "sync works". It is: A RESTART CHANGES
// NOTHING. Everything below is a way of saying that.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, type Db } from "../db";
import * as s from "../db/schema";
import { describeDrift, syncWorkflowCatalog } from "./sync";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "workflow-sync-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const scheduleFor = (slug: string) =>
  db
    .select({ rrule: s.workflowSchedules.rrule, label: s.workflowSchedules.label })
    .from(s.workflowSchedules)
    .innerJoin(s.workflows, eq(s.workflows.id, s.workflowSchedules.workflowId))
    .where(eq(s.workflows.slug, slug))
    .get();

const idOf = (slug: string) =>
  db.select({ id: s.workflows.id }).from(s.workflows).where(eq(s.workflows.slug, slug)).get()!.id;

describe("seeding", () => {
  test("puts the catalog in, and says nothing changed the second time", () => {
    const first = syncWorkflowCatalog(db);
    expect(first.added).toBeGreaterThan(0);
    expect(syncWorkflowCatalog(db)).toEqual({ added: 0, updated: 0 });
  });

  test("gives a workflow the catalog's schedule when it has none", () => {
    syncWorkflowCatalog(db);
    // The catalog ships this one at 07:00.
    expect(scheduleFor("weather-briefing")?.rrule).toBe("FREQ=DAILY;BYHOUR=7;BYMINUTE=0");
  });

  test("ships message-extraction unscheduled, and does not invent one", () => {
    syncWorkflowCatalog(db);
    expect(scheduleFor("message-extraction")).toBeUndefined();
  });
});

describe("what a restart must not do", () => {
  // The incident, exactly.
  test("a schedule the agent added to an unscheduled workflow survives", () => {
    syncWorkflowCatalog(db);
    db.insert(s.workflowSchedules)
      .values({
        id: "sched-agent-1",
        workflowId: idOf("message-extraction"),
        rrule: "FREQ=DAILY;BYHOUR=3;BYMINUTE=0",
        label: "Daily, 03:00",
        enabled: true,
      })
      .run();

    syncWorkflowCatalog(db);

    expect(scheduleFor("message-extraction")).toEqual({
      rrule: "FREQ=DAILY;BYHOUR=3;BYMINUTE=0",
      label: "Daily, 03:00",
    });
  });

  // The other half of the same mistake: where the catalog HAS an opinion, it
  // used to win. A schedule moved through the screen is a decision, and the
  // catalog is a default — defaults do not overrule decisions.
  test("a schedule moved away from the catalog's time stays moved", () => {
    syncWorkflowCatalog(db);
    db.update(s.workflowSchedules)
      .set({ rrule: "FREQ=DAILY;BYHOUR=5;BYMINUTE=30", label: "Daily, 05:30" })
      .where(eq(s.workflowSchedules.workflowId, idOf("weather-briefing")))
      .run();

    syncWorkflowCatalog(db);

    expect(scheduleFor("weather-briefing")).toEqual({
      rrule: "FREQ=DAILY;BYHOUR=5;BYMINUTE=30",
      label: "Daily, 05:30",
    });
  });

  test("nor does it un-pause, re-enable, or forget the arguments", () => {
    syncWorkflowCatalog(db);
    const id = idOf("weather-briefing");
    db.update(s.workflows).set({ pausedAt: new Date() }).where(eq(s.workflows.id, id)).run();
    db.update(s.workflowSchedules)
      .set({ enabled: false, args: { city: "Lisbon" } })
      .where(eq(s.workflowSchedules.workflowId, id))
      .run();

    syncWorkflowCatalog(db);

    const after = db.select().from(s.workflowSchedules).where(eq(s.workflowSchedules.workflowId, id)).get();
    expect(after?.enabled).toBe(false);
    expect(after?.args).toEqual({ city: "Lisbon" });
    expect(db.select().from(s.workflows).where(eq(s.workflows.id, id)).get()?.pausedAt).not.toBeNull();
  });
});

describe("describeDrift", () => {
  test("names what has never been seeded, so boot can say so", () => {
    const drift = describeDrift(db, () => true);
    expect(drift.unseeded).toContain("message-extraction");
    expect(drift.unrunnable).toEqual([]);
  });

  test("names a live schedule with no code behind it — the silent kind of broken", () => {
    syncWorkflowCatalog(db);
    expect(describeDrift(db, () => false).unrunnable).toContain("weather-briefing");
    expect(describeDrift(db, () => true).unrunnable).toEqual([]);
  });

  test("looks and does not touch", () => {
    syncWorkflowCatalog(db);
    const before = db.select().from(s.workflowSchedules).all();
    describeDrift(db, () => false);
    expect(db.select().from(s.workflowSchedules).all()).toEqual(before);
  });
});
