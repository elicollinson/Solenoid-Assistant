// Everything the record can be told about a workflow, and what the surface
// reads back.
//
// Each test writes through the mutation and then asks the same query the screen
// asks, because the pair is the contract: a pause that the table still draws as
// running, or a rule that the pane still shows the old text for, is the bug
// worth catching here. The versioned writes — the standing instruction and the
// permissions — are also checked for what they KEPT, since a run in June has to
// stay readable against June's rules.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, isNull } from "drizzle-orm";
import { createDb, runMigrations, type Db } from "../index";
import * as s from "../schema";
import { loadWorkflow, loadWorkflows } from "../queries/workflows";
import { syncWorkflowCatalog } from "../../workflows/sync";
import {
  NoSuchWorkflowError,
  NoSuchWorkflowPermissionError,
  grantWorkflowPermission,
  revokeWorkflowPermission,
  setWorkflowInstructions,
  setWorkflowPaused,
  setWorkflowSchedule,
  setWorkflowSummary,
} from "./workflows";

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

describe("who made the change", () => {
  test("a pause the agent decided on is recorded as the agent's, with its reason", () => {
    setWorkflowPaused(db, "weather-briefing", true, new Date(), {
      by: "agent",
      reason: "  the forecast source has failed four mornings running  ",
    });

    const [stored] = db.select().from(s.workflows).where(eq(s.workflows.slug, "weather-briefing")).all();
    expect(stored?.pausedBy).toBe("agent");
    expect(stored?.pauseReason).toBe("the forecast source has failed four mornings running");
  });

  test("resuming clears the reason as well as the date", () => {
    setWorkflowPaused(db, "weather-briefing", true, new Date(), { by: "agent", reason: "the source is down" });
    setWorkflowPaused(db, "weather-briefing", false);

    const [stored] = db.select().from(s.workflows).where(eq(s.workflows.slug, "weather-briefing")).all();
    expect(stored?.pauseReason).toBeNull();
  });

  test("a rule the agent wrote for itself is not signed as the user's", () => {
    setWorkflowInstructions(db, "weather-briefing", "Skip the wind when it is under 5mph.", new Date(), {
      by: "agent",
    });
    expect(rules()[0]?.authoredBy).toBe("agent");
  });
});

describe("the summary", () => {
  test("is what the detail pane reads back", () => {
    setWorkflowSummary(db, "weather-briefing", "  It has run clean every morning this week.  ");
    expect(loadWorkflow(db, "weather-briefing")?.summary).toBe("It has run clean every morning this week.");
  });

  test("replaces rather than accumulating, so there is only ever one", () => {
    setWorkflowSummary(db, "weather-briefing", "First account.");
    setWorkflowSummary(db, "weather-briefing", "Second account.");

    const written = db.select().from(s.narratives).where(eq(s.narratives.slot, "summary")).all();
    expect(written.length).toBe(1);
    expect(loadWorkflow(db, "weather-briefing")?.summary).toBe("Second account.");
  });

  test("empty text removes it rather than writing a blank line", () => {
    setWorkflowSummary(db, "weather-briefing", "Something.");
    setWorkflowSummary(db, "weather-briefing", "   ");

    expect(db.select().from(s.narratives).where(eq(s.narratives.slot, "summary")).all().length).toBe(0);
    expect(loadWorkflow(db, "weather-briefing")?.summary).toBeNull();
  });

  test("a slug this database has never heard of", () => {
    expect(() => setWorkflowSummary(db, "nonsense", "anything")).toThrow(NoSuchWorkflowError);
  });
});

describe("the schedule", () => {
  const schedule = (slug: string) =>
    db
      .select({ row: s.workflowSchedules })
      .from(s.workflowSchedules)
      .innerJoin(s.workflows, eq(s.workflows.id, s.workflowSchedules.workflowId))
      .where(eq(s.workflows.slug, slug))
      .all()
      .map((r) => r.row);

  test("the cadence is what the table shows, not the rule", () => {
    setWorkflowSchedule(db, "weather-briefing", {
      rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6;BYMINUTE=0",
      cadence: "Weekdays, 06:00",
    });

    expect(loadWorkflows(db).rows.find((r) => r.slug === "weather-briefing")?.cadence).toBe("Weekdays, 06:00");
    expect(schedule("weather-briefing")[0]?.rrule).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6;BYMINUTE=0");
  });

  test("a workflow that waited to be asked gets a schedule row it did not have", () => {
    expect(schedule("message-extraction").length).toBe(0);

    setWorkflowSchedule(db, "message-extraction", { rrule: "FREQ=DAILY;BYHOUR=21", cadence: "Daily, 21:00" });

    expect(schedule("message-extraction").length).toBe(1);
    expect(loadWorkflows(db).rows.find((r) => r.slug === "message-extraction")?.scheduled).toBe(true);
  });

  test("moving the rule drops the next fire, which was computed from the old one", () => {
    const [existing] = schedule("weather-briefing");
    db.update(s.workflowSchedules)
      .set({ nextRunAt: new Date("2026-09-01T07:00:00Z") })
      .where(eq(s.workflowSchedules.id, existing!.id))
      .run();

    setWorkflowSchedule(db, "weather-briefing", { rrule: "FREQ=DAILY;BYHOUR=9", cadence: "Daily, 09:00" });
    expect(schedule("weather-briefing")[0]?.nextRunAt).toBeNull();
  });

  test("renaming the cadence alone leaves the next fire alone", () => {
    const [existing] = schedule("weather-briefing");
    const due = new Date("2026-09-01T07:00:00Z");
    db.update(s.workflowSchedules).set({ nextRunAt: due }).where(eq(s.workflowSchedules.id, existing!.id)).run();

    setWorkflowSchedule(db, "weather-briefing", { rrule: existing!.rrule, cadence: "Every morning at seven" });
    expect(schedule("weather-briefing")[0]?.nextRunAt?.toISOString()).toBe(due.toISOString());
  });

  test("there is no unschedule: an empty rule is refused rather than dropping the row", () => {
    expect(() => setWorkflowSchedule(db, "weather-briefing", { rrule: "   ", cadence: "Daily" })).toThrow(
      /pause the workflow/,
    );
    expect(() => setWorkflowSchedule(db, "weather-briefing", { rrule: "FREQ=DAILY", cadence: " " })).toThrow(
      /cadence/,
    );
  });

  test("a slug this database has never heard of", () => {
    expect(() => setWorkflowSchedule(db, "nonsense", { rrule: "FREQ=DAILY", cadence: "Daily" })).toThrow(
      NoSuchWorkflowError,
    );
  });
});

describe("permissions", () => {
  const live = () =>
    db.select().from(s.workflowPermissions).where(isNull(s.workflowPermissions.retiredAt)).all();
  const all = () => db.select().from(s.workflowPermissions).all();

  test("a grant is the one live rule for its capability", () => {
    grantWorkflowPermission(db, "weather-briefing", { capability: "spend", mode: "ask", limitAmountCents: 5000 });

    expect(live().length).toBe(1);
    expect(live()[0]?.mode).toBe("ask");
    expect(live()[0]?.limitAmountCents).toBe(5000);
    expect(live()[0]?.createdBy).toBe("user");
  });

  test("replacing one retires the rule it replaced rather than overwriting it", () => {
    grantWorkflowPermission(db, "weather-briefing", { capability: "spend", mode: "ask" });
    grantWorkflowPermission(db, "weather-briefing", { capability: "spend", mode: "allow", by: "agent" });

    expect(all().length).toBe(2);
    expect(live().length).toBe(1);
    expect(live()[0]?.mode).toBe("allow");
    expect(live()[0]?.createdBy).toBe("agent");
    expect(all().filter((p) => p.retiredAt != null).length).toBe(1);
  });

  test("two capabilities on one workflow do not collide", () => {
    grantWorkflowPermission(db, "weather-briefing", { capability: "spend", mode: "ask" });
    grantWorkflowPermission(db, "weather-briefing", { capability: "calendar.write", mode: "deny" });
    expect(live().length).toBe(2);
  });

  test("revoking retires the rule and keeps it", () => {
    grantWorkflowPermission(db, "weather-briefing", { capability: "spend", mode: "allow" });
    revokeWorkflowPermission(db, "weather-briefing", "spend");

    expect(live().length).toBe(0);
    expect(all().length).toBe(1);
  });

  test("revoking what nothing grants says so rather than passing quietly", () => {
    expect(() => revokeWorkflowPermission(db, "weather-briefing", "spend")).toThrow(
      NoSuchWorkflowPermissionError,
    );
  });

  test("a capability with nothing in it is refused", () => {
    expect(() => grantWorkflowPermission(db, "weather-briefing", { capability: "  ", mode: "allow" })).toThrow(
      /capability/,
    );
  });

  test("a slug this database has never heard of", () => {
    expect(() => grantWorkflowPermission(db, "nonsense", { capability: "spend", mode: "allow" })).toThrow(
      NoSuchWorkflowError,
    );
  });
});
