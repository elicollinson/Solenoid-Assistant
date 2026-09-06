// The workflows group, exercised the way an agent reaches it.
//
// Two things are being checked and they are different jobs. The first is the
// group itself: that it is well formed, that every tool is classified by what
// it actually does, and that `readOnly` leaves exactly the tools that change
// nothing — because that filter is the whole of what stands between an agent
// reading a stranger's text and a write tool.
//
// The second is the boundary. ../db/mutations/workflows.test.ts already checks
// what each write does to the table; here it only matters that a tool call
// reaches it and that what comes back is something the next call can use.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, ulid, type Db } from "../db";
import * as s from "../db/schema";
import { syncWorkflowCatalog } from "../workflows/sync";
import type { AgentTool } from "../core/tools";
import { loaderName, readOnly, renderBriefing, type ToolGroup } from "../core/toolGroups";
import { workflowsGroup } from "./workflows";

let dir: string;
let db: Db;
let group: ToolGroup;

/** Every read tool, in the order the group lists them. */
const READS = [
  "workflows_list",
  "workflows_read",
  "workflows_read_runs",
  "workflows_read_run_logs",
];

const WRITES = [
  "workflows_set_summary",
  "workflows_set_schedule",
  "workflows_set_paused",
  "workflows_set_instructions",
  "workflows_set_permissions",
];

const names = (g: ToolGroup) => g.tools.map((t) => t.definition.function.name);

function tool(name: string): AgentTool {
  const found = group.tools.find((t) => t.definition.function.name === name);
  if (!found) throw new Error(`No tool called ${name}`);
  return found;
}

/** Exercise a tool the way Agent.invokeTool does: validate at the boundary,
 *  then run. Async so a refusal thrown synchronously reaches the caller as the
 *  rejection an agent loop would actually see. */
async function call(name: string, args: unknown = {}): Promise<any> {
  const t = tool(name);
  return t.execute(t.schema.parse(args));
}

/** A finished run with a log and a `changed` list, since the catalog's
 *  workflows have none until something actually runs them. */
function writeRun(slug: string, state: (typeof s.RUN_STATE)[number] = "failed"): string {
  const [workflow] = db.select().from(s.workflows).where(eq(s.workflows.slug, slug)).limit(1).all();
  const at = new Date("2026-08-20T06:12:00Z");
  const runId = ulid(at.getTime());

  db.insert(s.entities).values({ id: runId, kind: "workflow_run", createdAt: at, updatedAt: at }).run();
  db.insert(s.workflowRuns)
    .values({
      id: runId,
      workflowId: workflow!.id,
      ordinal: 14,
      trigger: "schedule",
      triggeredBy: "system",
      state,
      stepIndex: 6,
      stepTotal: 11,
      startedAt: at,
      endedAt: new Date(at.getTime() + 60_000),
      durationMs: 60_000,
      error: state === "failed" ? "the forecast source returned 503" : null,
      traceId: "trace-abc",
    })
    .run();
  db.insert(s.runLogs)
    .values([
      { runId, at, seq: 0, level: "info", text: "Run 14 started by the schedule." },
      { runId, at, seq: 1, level: "error", text: "the forecast source returned 503" },
    ])
    .run();
  db.insert(s.runEffects)
    .values({ id: ulid(at.getTime()), runId, ordinal: 0, text: "Nothing was sent.", effectKind: "held" })
    .run();

  return runId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "workflow-tools-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  syncWorkflowCatalog(db);
  group = workflowsGroup({ db });
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the group", () => {
  test("is one the belt will take, and does not claim its own loader's name", () => {
    expect(group.name).toBe("workflows");
    expect(group.shape.singular).toBe("workflow");
    expect(group.summary.trim().length).toBeGreaterThan(0);
    expect(group.purpose.trim().length).toBeGreaterThan(0);
    expect(names(group)).not.toContain(loaderName(group.name));
    expect(new Set(names(group)).size).toBe(group.tools.length);
  });

  test("hands over the nine tools, reads first", () => {
    expect(names(group)).toEqual([...READS, ...WRITES]);
  });

  test("classifies every tool by whether a later read would see it", () => {
    for (const name of READS) expect(tool(name).kind).toBe("read");
    for (const name of WRITES) expect(tool(name).kind).toBe("write");
  });

  test("readOnly leaves exactly the tools that change nothing", () => {
    const restricted = readOnly(group);
    expect(names(restricted)).toEqual(READS);
    expect(restricted.tools.every((t) => t.kind === "read")).toBe(true);
    // The briefing renders from the tools, so the dropped ones are not even
    // mentioned to the agent that may not call them.
    const briefing = renderBriefing(restricted);
    for (const name of WRITES) expect(briefing).not.toContain(name);
  });

  test("every tool produces a JSON schema the model can be shown, and says what it is for", () => {
    for (const t of group.tools) {
      const params = t.definition.function.parameters as { type?: string; properties?: object };
      expect(params.type).toBe("object");
      expect(Object.keys(params.properties ?? {}).length).toBeGreaterThan(0);
      // A one-line description is not enough for a surface a model decides on.
      expect(t.definition.function.description.length).toBeGreaterThan(200);
      // Restating the name teaches nothing that is not already on the call.
      expect(t.definition.function.description).not.toStartWith(t.definition.function.name);
    }
  });

  test("says in the briefing that a workflow's existence is not this database's to change", () => {
    const briefing = renderBriefing(group);
    expect(briefing).toContain("catalog");
    expect(briefing).toContain("create-workflow");
    expect(briefing).toContain("delete-workflow");
    // The shape names the four tables an agent needs and leaves the rest out.
    expect(briefing).toContain("rrule");
    expect(briefing).toContain("capability");
    expect(briefing).toContain("ordinal");
    // Nothing describes the version blob, the trace tree or the log rows as
    // fields; those are reached through a tool or not at all.
    expect(briefing).not.toContain("fracUs");
    expect(briefing).not.toContain("toolArgs");
  });

  test("the briefing is a pure function of the code, so two builds of it agree", () => {
    expect(renderBriefing(workflowsGroup({ db }))).toBe(renderBriefing(group));
  });
});

describe("reading", () => {
  test("the list is where the slugs come from, and filters on what a caller can act on", async () => {
    const all = await call("workflows_list", {});
    expect(all.count).toBeGreaterThan(0);
    expect(all.rows.map((r: { slug: string }) => r.slug)).toContain("weather-briefing");

    const scheduled = await call("workflows_list", { scheduled: true });
    expect(scheduled.rows.every((r: { scheduled: boolean }) => r.scheduled)).toBe(true);
    expect(scheduled.rows.length).toBeLessThan(all.rows.length);
  });

  test("reading one carries its schedule, its permissions and its rule, and not its runs", async () => {
    writeRun("weather-briefing");
    await call("workflows_set_instructions", { slug: "weather-briefing", instructions: "Skip the wind." });
    await call("workflows_set_permissions", { slug: "weather-briefing", capability: "spend", mode: "ask" });

    const detail = await call("workflows_read", { slug: "weather-briefing" });
    expect(detail.slug).toBe("weather-briefing");
    expect(detail.schedule.rrule).toContain("FREQ=DAILY");
    expect(detail.instruction.text).toBe("Skip the wind.");
    expect(detail.permissions).toEqual([
      expect.objectContaining({ capability: "spend", mode: "ask" }),
    ]);
    // The runs are counted rather than returned; a truncated list of them would
    // read as the whole list.
    expect(detail.executions).toBeUndefined();
    expect(detail.runCount).toBe(1);
  });

  test("a slug nothing knows answers rather than throwing into the loop", async () => {
    for (const name of ["workflows_read", "workflows_read_runs"]) {
      expect((await call(name, { slug: "nonsense" })).error).toContain("nonsense");
    }
    expect((await call("workflows_read_run_logs", { runId: "nonsense" })).error).toContain("nonsense");
  });

  test("the runs carry how each ended and what it changed, and an id the log tool takes", async () => {
    const runId = writeRun("weather-briefing");

    const runs = await call("workflows_read_runs", { slug: "weather-briefing" });
    expect(runs.count).toBe(1);
    expect(runs.runs[0]).toMatchObject({
      id: runId,
      label: "Run 14",
      state: "failed",
      step: "6/11",
      durationMs: 60_000,
      error: "the forecast source returned 503",
    });
    expect(runs.runs[0].changed).toEqual([{ text: "Nothing was sent.", kind: "held", reverted: false }]);

    const filtered = await call("workflows_read_runs", { slug: "weather-briefing", state: "done" });
    expect(filtered.count).toBe(0);
  });

  test("the log reads back in order, and one level at a time when asked", async () => {
    const runId = writeRun("weather-briefing");

    const whole = await call("workflows_read_run_logs", { runId });
    expect(whole.label).toBe("Run 14");
    expect(whole.source).toBe("database");
    expect(whole.lines.map((l: { text: string }) => l.text)).toEqual([
      "Run 14 started by the schedule.",
      "the forecast source returned 503",
    ]);

    const errors = await call("workflows_read_run_logs", { runId, level: "error" });
    expect(errors.count).toBe(1);
    expect(errors.lines[0].text).toBe("the forecast source returned 503");
  });

  test("a long log says it was cut rather than passing the first page off as the whole thing", async () => {
    const runId = writeRun("weather-briefing");
    const cut = await call("workflows_read_run_logs", { runId, limit: 1 });
    expect(cut.truncated).toBe(true);
    expect(cut.lines.length).toBe(1);
  });
});

describe("writing", () => {
  test("the summary is the agent's account, not what the workflow is for", async () => {
    await call("workflows_set_summary", { slug: "weather-briefing", summary: "It has run clean all week." });

    const detail = await call("workflows_read", { slug: "weather-briefing" });
    expect(detail.summary).toBe("It has run clean all week.");
    // The description comes from the code behind it and no tool moved it.
    expect(detail.description).toContain("weather");
    expect(detail.description).not.toContain("run clean all week");
  });

  test("a schedule takes the rule and the words, and both reach the table", async () => {
    await call("workflows_set_schedule", {
      slug: "weather-briefing",
      rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6;BYMINUTE=0",
      cadence: "Weekdays, 06:00",
    });

    const row = (await call("workflows_list", {})).rows.find(
      (r: { slug: string }) => r.slug === "weather-briefing",
    );
    expect(row.cadence).toBe("Weekdays, 06:00");
    expect((await call("workflows_read", { slug: "weather-briefing" })).schedule.rrule).toContain("BYDAY");
  });

  test("pausing records that the agent decided it, and why", async () => {
    await call("workflows_set_paused", {
      slug: "weather-briefing",
      paused: true,
      by: "agent",
      reason: "the source has failed four mornings running",
    });

    const detail = await call("workflows_read", { slug: "weather-briefing" });
    expect(detail.paused).toBe(true);
    expect(detail.pausedBy).toBe("agent");
    expect(detail.pauseReason).toBe("the source has failed four mornings running");

    await call("workflows_set_paused", { slug: "weather-briefing", paused: false });
    expect((await call("workflows_read", { slug: "weather-briefing" })).paused).toBe(false);
  });

  test("a rewritten rule keeps the one it replaced, and only the live one is read back", async () => {
    await call("workflows_set_instructions", { slug: "weather-briefing", instructions: "First rule." });
    await call("workflows_set_instructions", { slug: "weather-briefing", instructions: "Second rule." });

    const detail = await call("workflows_read", { slug: "weather-briefing" });
    expect(detail.instruction).toMatchObject({ text: "Second rule.", version: 2, authoredBy: "user" });
    expect(db.select().from(s.workflowInstructions).all().length).toBe(2);
  });

  test("clearing the rule leaves none rather than an empty one", async () => {
    await call("workflows_set_instructions", { slug: "weather-briefing", instructions: "A rule." });
    await call("workflows_set_instructions", { slug: "weather-briefing", instructions: "" });
    expect((await call("workflows_read", { slug: "weather-briefing" })).instruction).toBeNull();
  });

  test("unset removes this workflow's answer, which is not the same as denying it", async () => {
    await call("workflows_set_permissions", { slug: "weather-briefing", capability: "spend", mode: "deny" });
    expect((await call("workflows_read", { slug: "weather-briefing" })).permissions.length).toBe(1);

    await call("workflows_set_permissions", { slug: "weather-briefing", capability: "spend", mode: "unset" });
    expect((await call("workflows_read", { slug: "weather-briefing" })).permissions).toEqual([]);
    // Retired rather than deleted: a run has to stay readable against the rule
    // it actually ran under.
    expect(db.select().from(s.workflowPermissions).all().length).toBe(1);
  });

  test("a limit crosses in cents, and a capability with nothing in it never reaches the database", async () => {
    await call("workflows_set_permissions", {
      slug: "weather-briefing",
      capability: "spend",
      mode: "ask",
      limitAmountCents: 5000,
    });
    const [permission] = (await call("workflows_read", { slug: "weather-briefing" })).permissions;
    expect(permission.limitAmountCents).toBe(5000);

    expect(() =>
      tool("workflows_set_permissions").schema.parse({ slug: "weather-briefing", capability: "", mode: "allow" }),
    ).toThrow();
  });

  test("writing to a slug nothing knows answers rather than throwing into the loop", async () => {
    expect((await call("workflows_set_paused", { slug: "nonsense", paused: true })).error).toContain("nonsense");
    expect((await call("workflows_set_summary", { slug: "nonsense", summary: "x" })).error).toContain("nonsense");
  });
});
