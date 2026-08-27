// Taking the demonstrations out, and leaving everything that stands on its own.
//
// The seed writes one connected body of fiction: workflows, the runs behind
// them, the feed entries about those runs, and the copy that counts them. What
// is worth guarding here is where the cut falls — that the whole strand goes,
// that nothing is left pointing at a workflow that no longer exists, and that
// a reminder or a suggestion survives the workflow it happened to mention.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, type Db } from "../index";
import * as s from "../schema";
import { loadCalendar } from "../queries/calendar";
import { loadHome } from "../queries/home";
import { loadRecommendations } from "../queries/recommendations";
import { loadReminders } from "../queries/reminders";
import { loadWorkflows } from "../queries/workflows";
import { seedDesignFixtures } from "../seed/design";
import { zonedTime } from "../seed/time";
import { CATALOGUED_SLUGS, syncWorkflowCatalog } from "../../workflows/sync";
import { pruneUncataloguedWorkflows, removeWorkflow, uncataloguedWorkflows } from "./pruneWorkflows";

const MORNING = zonedTime(2026, 8, 25, 9, 20);

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-prune-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  seedDesignFixtures(db, { now: MORNING });
  syncWorkflowCatalog(db, MORNING);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("what goes", () => {
  test("every workflow with no code behind it, and nothing that has any", () => {
    const before = loadWorkflows(db, MORNING).rows;
    expect(before.length).toBe(13);
    expect(before.filter((row) => row.runnable).length).toBe(5);

    const result = pruneUncataloguedWorkflows(db);
    expect(result.removed.length).toBe(8);
    expect(result.removed).toContain("vendor-reconciliation");

    const after = loadWorkflows(db, MORNING).rows;
    expect(after.map((row) => row.slug).sort()).toEqual([...CATALOGUED_SLUGS].sort());
    expect(after.every((row) => row.runnable)).toBe(true);
  });

  test("their runs, and everything written down about those runs", () => {
    pruneUncataloguedWorkflows(db);

    expect(db.select().from(s.workflowRuns).all().length).toBe(0);
    expect(db.select().from(s.runSteps).all().length).toBe(0);
    expect(db.select().from(s.runLogs).all().length).toBe(0);
    expect(db.select().from(s.runEffects).all().length).toBe(0);
  });

  test("the feed entries that were accounts of those runs", () => {
    expect(loadHome(db, MORNING).sections.flatMap((section) => section.items).length).toBe(6);

    const result = pruneUncataloguedWorkflows(db);
    expect(result.activity).toBe(6);
    expect(loadHome(db, MORNING).sections.flatMap((section) => section.items).length).toBe(0);
  });

  test("the line that counted the night those entries made up", () => {
    expect(loadHome(db, MORNING).header.lede).toStartWith("I handled nine things overnight.");
    pruneUncataloguedWorkflows(db);
    // What is left is derived from what is actually open, and stays true.
    expect(loadHome(db, MORNING).header.lede).toBe("One needs a word from you before I go further.");
  });

  test("no entity row is left behind by the rows that cascaded off one", () => {
    pruneUncataloguedWorkflows(db);

    const kinds = new Set(db.select({ kind: s.entities.kind }).from(s.entities).all().map((e) => e.kind));
    for (const orphaned of ["workflow_run", "run_step"]) expect(kinds.has(orphaned as never)).toBe(false);
    // Every entity still there is the supertype of a row that still exists.
    const workflows = db.select({ id: s.workflows.id }).from(s.workflows).all().map((w) => w.id);
    const entityIds = db.select({ id: s.entities.id }).from(s.entities).all().map((e) => e.id);
    for (const id of workflows) expect(entityIds).toContain(id);
  });
});

describe("what stays", () => {
  test("reminders, suggestions and the week you did not ask about", () => {
    const remindersBefore = loadReminders(db).rows.length;
    const suggestionsBefore = loadRecommendations(db).rows.length;

    pruneUncataloguedWorkflows(db);

    expect(loadReminders(db).rows.length).toBe(remindersBefore);
    expect(loadRecommendations(db).rows.length).toBe(suggestionsBefore);
    // The commitments in your week are yours; only the runs on it were mine.
    expect(loadCalendar(db, MORNING).items.filter((item) => item.kind === "event").length).toBeGreaterThan(0);
  });

  test("a reminder that named one of them still opens", () => {
    pruneUncataloguedWorkflows(db);
    const row = loadReminders(db).rows.find((r) => r.title.startsWith("Tell Ferris"));
    expect(row).toBeDefined();
  });
});

describe("what is left pointing nowhere", () => {
  test("nothing on the feed offers to open a workflow that is gone", () => {
    pruneUncataloguedWorkflows(db);
    const surviving = new Set(loadWorkflows(db, MORNING).rows.map((row) => row.slug));

    for (const section of loadHome(db, MORNING).sections) {
      for (const item of section.items) {
        for (const action of item.actions) {
          const effect = action.effect as { view?: string; id?: string };
          if (effect?.view === "Workflows" && effect.id) expect(surviving.has(effect.id)).toBe(true);
        }
      }
    }
  });

  test("the calendar draws runs of surviving workflows only", () => {
    pruneUncataloguedWorkflows(db);
    const surviving = new Set(loadWorkflows(db, MORNING).rows.map((row) => row.slug));
    // Run blocks are projected from the rows at read time rather than stored,
    // so they correct themselves — this is the assertion that says so.
    for (const item of loadCalendar(db, MORNING).items.filter((i) => i.kind === "run")) {
      expect(surviving.has(item.title)).toBe(true);
    }
  });
});

describe("running it twice", () => {
  test("is a no-op the second time", () => {
    const first = pruneUncataloguedWorkflows(db);
    expect(first.removed.length).toBeGreaterThan(0);

    const again = pruneUncataloguedWorkflows(db);
    expect(again).toEqual({ removed: [], runs: 0, activity: 0, calendar: 0, unscopedSuggestions: 0 });
  });

  test("and on a database that only ever had real workflows", () => {
    pruneUncataloguedWorkflows(db);
    expect(uncataloguedWorkflows(db)).toEqual([]);
  });
});

describe("one at a time", () => {
  test("removes just that workflow, and says whether it was there", () => {
    expect(removeWorkflow(db, "calendar-tidy")).toBe(true);
    expect(loadWorkflows(db, MORNING).rows.find((row) => row.slug === "calendar-tidy")).toBeUndefined();
    expect(loadWorkflows(db, MORNING).rows.length).toBe(12);

    expect(removeWorkflow(db, "calendar-tidy")).toBe(false);
    expect(removeWorkflow(db, "never-existed")).toBe(false);
  });
});
