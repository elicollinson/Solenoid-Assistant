// The Workflows surface, checked against the design it came from.
//
// The design stores each workflow's state, step and last-run line as a display
// string. All three fall out of the newest run here, so the thing worth
// guarding is that the derivation still lands on what the design says — and
// that it moves when the run underneath it moves.
import { Elysia } from "elysia";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, type Db } from "../index";
import * as s from "../schema";
import { createUiRoutes } from "../../http/routes/ui";
import { loadWorkflow, loadWorkflows, type WorkflowsPayload } from "./workflows";
import { seedDesignFixtures } from "../seed/design";
import { zonedTime } from "../seed/time";

let dir: string;
let db: Db;
let list: WorkflowsPayload;

// The same fixed morning the home tests use: 2026-08-25, 09:20 in New York.
const MORNING = zonedTime(2026, 8, 25, 9, 20);

const row = (slug: string) => list.rows.find((r) => r.slug === slug);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-workflows-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  seedDesignFixtures(db, { now: MORNING });
  list = loadWorkflows(db, MORNING);
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the table", () => {
  test("has every workflow the design draws, urgent first", () => {
    expect(list.rows.length).toBe(8);
    expect(list.rows.map((r) => r.slug)).toEqual([
      "contract-review",
      "vendor-reconciliation",
      "weekly-digest",
      "bill-watch",
      "inbox-triage",
      "memory-compaction",
      "calendar-tidy",
      "job-listings-sweep",
    ]);
  });

  test("the lede counts the table rather than repeating a fixture", () => {
    expect(list.lede).toBe(
      "Everything I run for you, on a schedule or on demand. One is going now; one stopped; one is waiting on you.",
    );
  });

  test("state, step and the last-run line come off the newest run", () => {
    expect(row("vendor-reconciliation")).toMatchObject({
      state: "running",
      step: "6/11",
      last: "Running since 06:12",
      cadence: "On demand",
      scheduled: false,
    });
    expect(row("weekly-digest")).toMatchObject({ state: "failed", step: "4/9", last: "Halted yesterday, 21:04" });
    expect(row("contract-review")).toMatchObject({ state: "attention", last: "Waiting on you since 07:41" });
    expect(row("memory-compaction")).toMatchObject({ state: "done", last: "Finished 03:06", cadence: "Mondays, 03:00" });
  });

  test("a run inside the hour reads as an interval, not a clock", () => {
    expect(row("bill-watch")?.last).toBe("Finished 12 min ago");
  });

  test("a paused workflow is idle, has no step, and says who paused it", () => {
    expect(row("job-listings-sweep")).toMatchObject({ state: "idle", step: null, paused: true, last: "Paused by you on Aug 9" });
  });

  test("the state is derived: end the run and the row changes with it", () => {
    db.$client.exec(`UPDATE workflow_runs SET state = 'done', ended_at = started_at + 600000, duration_ms = 600000
                     WHERE ordinal = 14`);
    const after = loadWorkflows(db, MORNING);
    expect(after.rows.find((r) => r.slug === "vendor-reconciliation")).toMatchObject({ state: "done", last: "Finished 06:22" });
    expect(after.lede).toContain("One stopped; one is waiting on you.");
    db.$client.exec(`UPDATE workflow_runs SET state = 'running', ended_at = NULL, duration_ms = NULL WHERE ordinal = 14`);
  });
});

describe("one workflow", () => {
  test("carries the agent's summary, what changed, and the standing rule", () => {
    const wf = loadWorkflow(db, "vendor-reconciliation", MORNING);
    expect(wf?.summary).toContain("I'm matching 43 vendor invoices against the Q3 ledger.");
    expect(wf?.changed).toEqual([
      "Matched 32 of 43 invoices to ledger lines.",
      "Flagged 2 invoices with no matching line at all (2291, 2318).",
      "Left the Ferris credit note alone — I need your call on it.",
    ]);
    expect(wf?.instructions).toBe(
      "Don't touch anything Ferris until the credit note is decided. Group quarter-boundary differences rather than asking per invoice.",
    );
    expect(wf?.progress).toEqual({ value: 6, total: 11 });
  });

  test("the stats are two tallies read as written and two facts counted here", () => {
    const wf = loadWorkflow(db, "vendor-reconciliation", MORNING);
    expect(wf?.stats).toEqual([
      { label: "Runs", value: "14" },
      { label: "Clean runs", value: "11" },
      // Over the four runs the seed keeps, not the fourteen it counts.
      { label: "Median", value: "18m 40s" },
      { label: "Started", value: "06:12" },
    ]);
  });

  test("the executions are the design's four, newest first", () => {
    const wf = loadWorkflow(db, "vendor-reconciliation", MORNING);
    expect(wf?.executions.map((e) => [e.label, e.when, e.state, e.duration])).toEqual([
      ["Run 14", "Today 06:12", "running", "running"],
      ["Run 13", "Aug 17, 06:12", "done", "18m 40s"],
      ["Run 12", "Aug 10, 06:12", "attention", "22m 03s"],
      ["Run 11", "Aug 3, 06:12", "failed", "4m 51s"],
    ]);
    // Only the newest keeps a write-up; the rest are on the record, not narrated.
    expect(wf?.executions.map((e) => e.detail != null)).toEqual([true, false, false, false]);
  });

  test("the trace is a tree, and the tool list is its leaves in document order", () => {
    const detail = loadWorkflow(db, "vendor-reconciliation", MORNING)?.executions[0]?.detail;
    expect(detail?.trace.map((n) => n.name)).toEqual([
      "reconcile.load_ledger",
      "reconcile.load_invoices",
      "reconcile.match_invoices",
      "reconcile.write_summary",
      "notify.digest",
    ]);
    expect(detail?.trace[0]?.children.map((n) => n.name)).toEqual(["sheets.read", "memory.read"]);
    // A held step is amber and says why; a skipped one is grey and says what for.
    const held = detail?.trace[2]?.children[2];
    expect(held).toMatchObject({ name: "match.unresolved", state: "waiting" });
    expect(held?.children[1]).toMatchObject({ state: "waiting", note: "Ferris — held per instruction" });
    expect(detail?.trace[3]).toMatchObject({ state: "skipped", detail: "waits for matching to finish" });

    expect(detail?.calls.map((c) => c.name)).toEqual(["sheets.read", "memory.read", "invoices.list", "reconcile.match_invoices"]);
  });

  test("the log keeps its millisecond, and the transcript keeps its two voices", () => {
    const detail = loadWorkflow(db, "vendor-reconciliation", MORNING)?.executions[0]?.detail;
    expect(detail?.logs[0]).toEqual({
      t: "06:12:04.221",
      level: "info",
      text: "run started · workflow=vendor-reconciliation · trigger=manual",
    });
    expect(detail?.logs.filter((l) => l.level === "error").length).toBe(1);
    expect(detail?.transcript.map((t) => t.who)).toEqual(["you", "agent", "you", "agent"]);
    expect(detail?.transcript[0]?.text).toContain("don't touch anything Ferris");
  });

  test("the gate is the open decision the feed already authored buttons for", () => {
    const wf = loadWorkflow(db, "contract-review", MORNING);
    expect(wf?.gate?.title).toBe("Approve the Ferris contract reply");
    expect(wf?.gate?.actions.map((a) => a.label)).toEqual(["Send it", "Read the draft", "Not this one"]);
    // Nothing else is sitting on you, so nothing else draws the alert plane.
    expect(loadWorkflow(db, "vendor-reconciliation", MORNING)?.gate).toBeNull();
  });

  test("a workflow that has never run says so instead of drawing empty tabs", () => {
    const wf = loadWorkflow(db, "job-listings-sweep", MORNING);
    expect(wf?.executions).toEqual([]);
    expect(wf?.changed).toEqual([]);
    expect(wf?.instructions).toBeNull();
    expect(wf?.stats.at(-1)).toEqual({ label: "Paused", value: "Aug 9" });
  });

  test("an unknown slug is not a workflow with no runs", () => {
    expect(loadWorkflow(db, "nope", MORNING)).toBeNull();
  });
});

describe("over HTTP", () => {
  test("the table and one workflow each answer in one call", async () => {
    const app = new Elysia().use(createUiRoutes(() => db));
    const table = await app.handle(new Request("http://localhost/api/workflows"));
    expect(table.status).toBe(200);
    expect(((await table.json()) as WorkflowsPayload).rows.length).toBe(8);

    const one = await app.handle(new Request("http://localhost/api/workflows/weekly-digest"));
    expect(one.status).toBe(200);
    expect(((await one.json()) as { name: string }).name).toBe("Weekly digest");
  });

  test("an unknown slug is a 404 that says which one", async () => {
    const app = new Elysia().use(createUiRoutes(() => db));
    const missing = await app.handle(new Request("http://localhost/api/workflows/nope"));
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe("No workflow called nope");
  });

  /**
   * Starting one, and the four ways it is refused.
   *
   * Only the refusals are exercised here: every workflow with code behind it
   * reaches a model, and the seeded rows have none — which is exactly what
   * makes them the right subject for "this cannot be started". The accepted
   * path is in src/workflows/runner.test.ts, against a substituted body.
   */
  const start = (slug: string, body: unknown = {}) =>
    new Elysia().use(createUiRoutes(() => db)).handle(
      new Request(`http://localhost/api/workflows/${slug}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  test("a workflow with no code behind it is refused, and says so", async () => {
    const response = await start("vendor-reconciliation");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("no code behind it");
  });

  test("starting something that does not exist is the same 404", async () => {
    expect((await start("nope")).status).toBe(404);
  });

  const write = (path: string, method: "POST" | "PUT", body: unknown = {}) =>
    new Elysia().use(createUiRoutes(() => db)).handle(
      new Request(`http://localhost/api/workflows/${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  test("pausing and resuming is written, and reads back on the next call", async () => {
    expect((await write("calendar-tidy/pause", "POST", { paused: true })).status).toBe(200);

    const app = new Elysia().use(createUiRoutes(() => db));
    const paused = await app.handle(new Request("http://localhost/api/workflows/calendar-tidy"));
    expect(((await paused.json()) as { paused: boolean }).paused).toBe(true);

    await write("calendar-tidy/pause", "POST", { paused: false });
    const resumed = await new Elysia()
      .use(createUiRoutes(() => db))
      .handle(new Request("http://localhost/api/workflows/calendar-tidy"));
    expect(((await resumed.json()) as { paused: boolean }).paused).toBe(false);
  });

  test("the standing rule can be rewritten and cleared", async () => {
    expect((await write("calendar-tidy/instructions", "PUT", { text: "Leave externals alone." })).status).toBe(200);
    const app = new Elysia().use(createUiRoutes(() => db));
    const one = await app.handle(new Request("http://localhost/api/workflows/calendar-tidy"));
    expect(((await one.json()) as { instructions: string | null }).instructions).toBe("Leave externals alone.");

    await write("calendar-tidy/instructions", "PUT", { text: "" });
    const cleared = await new Elysia()
      .use(createUiRoutes(() => db))
      .handle(new Request("http://localhost/api/workflows/calendar-tidy"));
    expect(((await cleared.json()) as { instructions: string | null }).instructions).toBeNull();
  });

  test("stopping a workflow that is not running is a 409, not a lie", async () => {
    const response = await write("calendar-tidy/stop", "POST");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain("isn't running");
  });

  test("writing to a slug this database has never heard of is a 404", async () => {
    expect((await write("nope/pause", "POST", { paused: true })).status).toBe(404);
    expect((await write("nope/instructions", "PUT", { text: "x" })).status).toBe(404);
    expect((await write("nope/stop", "POST")).status).toBe(404);
  });

  test("a refused trigger writes no run", async () => {
    const before = db.select().from(s.workflowRuns).all().length;
    await start("vendor-reconciliation");
    expect(db.select().from(s.workflowRuns).all().length).toBe(before);
  });
});
