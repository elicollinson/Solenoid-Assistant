// The three things the detail pane can change, and what the surface reads back.
//
// Each test writes through the mutation and then asks the same query the screen
// asks, because the pair is the contract: a pause that the table still draws as
// running, or a rule that the pane still shows the old text for, is the bug
// worth catching here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
import { createDb, runMigrations, type Db } from "../index";
import * as s from "../schema";
import { loadWorkflow, loadWorkflows } from "../queries/workflows";
import { syncWorkflowCatalog } from "../../workflows/sync";
import { NoSuchWorkflowError, setWorkflowInstructions, setWorkflowPaused } from "./workflows";

let dir: string;
let db: Db;

const rules = () =>
  db
    .select()
    .from(s.workflowInstructions)
    .orderBy(desc(s.workflowInstructions.version))
    .all();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-mutations-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  syncWorkflowCatalog(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("pausing", () => {
  test("reads through the table and the detail, and names who did it", () => {
    setWorkflowPaused(db, "weather-briefing", true);

    const row = loadWorkflows(db).rows.find((r) => r.slug === "weather-briefing");
    expect(row?.paused).toBe(true);
    expect(row?.state).toBe("idle");
    expect(row?.last).toStartWith("Paused by you on");
    expect(loadWorkflow(db, "weather-briefing")?.paused).toBe(true);

    const [stored] = db.select().from(s.workflows).where(eq(s.workflows.slug, "weather-briefing")).all();
    expect(stored?.pausedBy).toBe("user");
  });

  test("resuming clears it rather than leaving who paused it behind", () => {
    setWorkflowPaused(db, "weather-briefing", true);
    setWorkflowPaused(db, "weather-briefing", false);

    const [stored] = db.select().from(s.workflows).where(eq(s.workflows.slug, "weather-briefing")).all();
    expect(stored?.pausedAt).toBeNull();
    expect(stored?.pausedBy).toBeNull();
    expect(loadWorkflow(db, "weather-briefing")?.paused).toBe(false);
  });

  test("pausing what is already paused does not move the timestamp", () => {
    setWorkflowPaused(db, "weather-briefing", true, new Date("2026-08-01T09:00:00Z"));
    setWorkflowPaused(db, "weather-briefing", true, new Date("2026-08-20T09:00:00Z"));

    const [stored] = db.select().from(s.workflows).where(eq(s.workflows.slug, "weather-briefing")).all();
    expect(stored?.pausedAt?.toISOString()).toBe("2026-08-01T09:00:00.000Z");
  });

  test("a slug this database has never heard of", () => {
    expect(() => setWorkflowPaused(db, "nonsense", true)).toThrow(NoSuchWorkflowError);
  });
});

describe("the standing instruction", () => {
  test("is what the detail pane reads back", () => {
    setWorkflowInstructions(db, "weather-briefing", "  Never wake me before seven.  ");
    expect(loadWorkflow(db, "weather-briefing")?.instructions).toBe("Never wake me before seven.");
  });

  test("replacing one keeps the rule it replaced, pointed at from the new one", () => {
    setWorkflowInstructions(db, "weather-briefing", "First rule.");
    setWorkflowInstructions(db, "weather-briefing", "Second rule.");

    const all = rules();
    expect(all.length).toBe(2);
    expect(all[0]?.text).toBe("Second rule.");
    expect(all[0]?.version).toBe(2);
    expect(all[0]?.supersedesId).toBe(all[1]?.id ?? null);
    expect(all[1]?.retiredAt).not.toBeNull();
    // Only the live one reaches the screen.
    expect(loadWorkflow(db, "weather-briefing")?.instructions).toBe("Second rule.");
  });

  test("clearing it retires the rule without writing an empty successor", () => {
    setWorkflowInstructions(db, "weather-briefing", "First rule.");
    setWorkflowInstructions(db, "weather-briefing", "   ");

    expect(rules().length).toBe(1);
    expect(rules()[0]?.retiredAt).not.toBeNull();
    expect(loadWorkflow(db, "weather-briefing")?.instructions).toBeNull();
  });

  test("saving the same words again writes no new version", () => {
    setWorkflowInstructions(db, "weather-briefing", "First rule.");
    setWorkflowInstructions(db, "weather-briefing", "First rule.");
    expect(rules().length).toBe(1);
  });

  test("a slug this database has never heard of", () => {
    expect(() => setWorkflowInstructions(db, "nonsense", "anything")).toThrow(NoSuchWorkflowError);
  });
});
