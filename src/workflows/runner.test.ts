// Triggering a workflow, end to end, minus the model.
//
// The catalog goes into the database, a run is started against it, and the same
// queries the Workflows surface uses are asked what happened. The workflow's own
// body is substituted, because what is worth guarding here is the bookkeeping —
// the ordinal, the state as it moves, the effects, the write-up and the output
// the pane reads back — and not whether an agent can describe a screenshot.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createDb, runMigrations, type Db } from "../db";
import * as s from "../db/schema";
import { loadWorkflow, loadWorkflows } from "../db/queries/workflows";
import { eq } from "drizzle-orm";
import { WORKFLOW_CATALOG } from "./catalog";
import { WorkflowArgsError, type RunnableWorkflow, type WorkflowOutcome } from "./registry";
import { NotRunningError, NotRunnableError, UnknownWorkflowError, startWorkflowRun, stopCurrentRun } from "./runner";
import { syncWorkflowCatalog } from "./sync";

let dir: string;
let db: Db;

/**
 * A stand-in for `weather-briefing`, with the same argument shape.
 *
 * `RunnableWorkflow` erases its own schema to `z.ZodType`, so its `execute`
 * takes `unknown` — that is what makes one map able to hold five workflows with
 * five different argument shapes. The runner parses before it calls, so the
 * cast here is doing what the schema already guaranteed.
 */
const fake = (execute: (args: { city: string }) => Promise<WorkflowOutcome>) => {
  const workflow: RunnableWorkflow = {
    slug: "weather-briefing",
    schema: z.object({ city: z.string().min(1) }),
    execute: execute as RunnableWorkflow["execute"],
  };
  return (slug: string) => (slug === workflow.slug ? workflow : undefined);
};

const ok = fake(async ({ city }) => ({
  output: { city, sky: "clear", degrees: 64 },
  effects: [`Looked up the weather in ${city}.`],
  prose: [`It is clear and 64 in ${city}.`],
}));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-runner-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("putting the catalog on the surface", () => {
  test("adds every catalogued workflow once, however often it runs", () => {
    const first = syncWorkflowCatalog(db);
    expect(first.added).toBe(WORKFLOW_CATALOG.length);

    const again = syncWorkflowCatalog(db);
    expect(again.added).toBe(0);
    expect(again.updated).toBe(0);

    const rows = db.select().from(s.workflows).all();
    expect(rows.length).toBe(WORKFLOW_CATALOG.length);
  });

  test("gives the table a cadence to draw and marks the rows runnable", () => {
    syncWorkflowCatalog(db);
    const list = loadWorkflows(db);

    expect(list.rows.every((row) => row.runnable)).toBe(true);
    expect(list.rows.find((row) => row.slug === "weather-briefing")?.cadence).toBe("Daily, 07:00");
    expect(list.rows.find((row) => row.slug === "message-extraction")?.cadence).toBe("On demand");
    expect(list.rows.find((row) => row.slug === "message-extraction")?.last).toBe("Never run");
  });

  test("says what it is doing in a word, before it has ever run", () => {
    syncWorkflowCatalog(db);
    expect(loadWorkflow(db, "weather-briefing")?.badge).toBe("never run");
  });

  test("hands the detail pane what the workflow is and what it takes", () => {
    syncWorkflowCatalog(db);
    const detail = loadWorkflow(db, "safety-classification");

    expect(detail?.runnable).toBe(true);
    expect(detail?.description).toContain("injected instructions");
    expect(detail?.inputs.map((input) => input.name)).toEqual(["input", "maxLength"]);
    expect(detail?.inputs[0]?.required).toBe(true);
  });
});

describe("a run that works", () => {
  test("is running while it runs and done with a result afterwards", async () => {
    syncWorkflowCatalog(db);

    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = startWorkflowRun(db, "weather-briefing", { city: "Lisbon" }, {
      lookup: fake(async ({ city }) => {
        await held;
        return { output: { city }, effects: ["Looked it up."], prose: ["Warm."] };
      }),
    });

    expect(started.ordinal).toBe(1);
    expect(loadWorkflow(db, "weather-briefing")?.state).toBe("running");
    expect(loadWorkflows(db).rows.find((row) => row.slug === "weather-briefing")?.last).toStartWith("Running since");

    release?.();
    await started.settled;

    const detail = loadWorkflow(db, "weather-briefing");
    expect(detail?.state).toBe("done");
    expect(detail?.executions[0]?.label).toBe("Run 1");
    expect(detail?.executions[0]?.error).toBeNull();
  });

  test("writes what changed, the write-up, and the result the pane prints", async () => {
    syncWorkflowCatalog(db);
    await startWorkflowRun(db, "weather-briefing", { city: "Lisbon" }, { lookup: ok }).settled;

    const detail = loadWorkflow(db, "weather-briefing");
    expect(detail?.changed).toEqual(["Looked up the weather in Lisbon."]);

    const run = detail?.executions[0];
    expect(run?.detail?.prose).toEqual(["It is clear and 64 in Lisbon."]);
    expect(JSON.parse(run?.detail?.output ?? "null")).toEqual({ city: "Lisbon", sky: "clear", degrees: 64 });
    // The arguments are on the trace as a tool call, which is how the Trace tab
    // and the collapsed tool list end up telling the same story.
    expect(run?.detail?.calls[0]).toMatchObject({ name: "workflow.weather_briefing", arg: "city=Lisbon" });
    expect(run?.detail?.logs.map((line) => line.level)).toEqual(["info", "debug", "ok"]);
  });

  test("numbers each run after the last one, and counts them", async () => {
    syncWorkflowCatalog(db);
    await startWorkflowRun(db, "weather-briefing", { city: "Lisbon" }, { lookup: ok }).settled;
    const second = startWorkflowRun(db, "weather-briefing", { city: "Porto" }, { lookup: ok });
    await second.settled;

    expect(second.ordinal).toBe(2);
    const detail = loadWorkflow(db, "weather-briefing");
    expect(detail?.executions.map((run) => run.label)).toEqual(["Run 2", "Run 1"]);
    expect(detail?.stats.find((stat) => stat.label === "Runs")?.value).toBe("2");
    expect(detail?.stats.find((stat) => stat.label === "Clean runs")?.value).toBe("2");
  });
});

describe("a run that doesn't", () => {
  test("halts rather than rejecting, and says why on the run", async () => {
    syncWorkflowCatalog(db);
    const started = startWorkflowRun(db, "weather-briefing", { city: "Lisbon" }, {
      lookup: fake(async () => {
        throw new Error("the model never answered");
      }),
    });

    // The promise the route drops on the floor must never reject.
    await expect(started.settled).resolves.toBeUndefined();

    const detail = loadWorkflow(db, "weather-briefing");
    expect(detail?.state).toBe("failed");
    expect(detail?.executions[0]?.error).toBe("the model never answered");
    expect(detail?.executions[0]?.detail?.logs.at(-1)?.text).toContain("the model never answered");
    expect(detail?.stats.find((stat) => stat.label === "Clean runs")?.value).toBe("0");
  });
});

describe("stopping one", () => {
  test("writes it down as stopped and drops whatever lands afterwards", async () => {
    syncWorkflowCatalog(db);

    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = startWorkflowRun(db, "weather-briefing", { city: "Lisbon" }, {
      lookup: fake(async ({ city }) => {
        await held;
        return { output: { city }, effects: ["Looked it up."], prose: ["Warm."] };
      }),
    });

    stopCurrentRun(db, "weather-briefing");
    expect(loadWorkflow(db, "weather-briefing")?.executions[0]?.detail?.logs.at(-1)?.level).toBe("warn");

    // The work finishes anyway — there is no reaching into a model call that
    // has already left — and what it returns must not reopen the run.
    release?.();
    await started.settled;

    const detail = loadWorkflow(db, "weather-briefing");
    expect(detail?.executions[0]?.state).toBe("idle");
    expect(detail?.changed).toEqual([]);
    expect(detail?.executions[0]?.detail?.prose).toEqual([]);
    expect(detail?.stats.find((stat) => stat.label === "Clean runs")?.value).toBe("0");
  });

  test("the workflow's own signal is raised, for anything that can hear it", async () => {
    syncWorkflowCatalog(db);
    let seen: AbortSignal | undefined;
    const started = startWorkflowRun(db, "weather-briefing", { city: "Lisbon" }, {
      lookup: (slug) =>
        slug === "weather-briefing"
          ? {
              slug,
              schema: z.object({ city: z.string().min(1) }),
              execute: (async (_args: unknown, context: { signal: AbortSignal }) => {
                seen = context.signal;
                await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve()));
                throw new Error("aborted");
              }) as RunnableWorkflow["execute"],
            }
          : undefined,
    });

    stopCurrentRun(db, "weather-briefing");
    await started.settled;

    expect(seen?.aborted).toBe(true);
    // The throw landed after the stop, so it is not what the run says happened.
    expect(loadWorkflow(db, "weather-briefing")?.executions[0]?.error).toBeNull();
  });

  test("reads as stopped rather than as paused, which it is not", () => {
    syncWorkflowCatalog(db);
    startWorkflowRun(db, "weather-briefing", { city: "Lisbon" }, {
      lookup: fake(() => new Promise(() => ({ output: null, effects: [], prose: [] }))),
    });
    stopCurrentRun(db, "weather-briefing");

    const detail = loadWorkflow(db, "weather-briefing");
    // The status mark has five values and both of these are "idle" to it. The
    // badge is where the two have to stay apart.
    expect(detail?.state).toBe("idle");
    expect(detail?.badge).toBe("stopped");
    expect(detail?.paused).toBe(false);
    expect(detail?.last).toStartWith("Stopped");
  });

  test("refuses when there is nothing going", () => {
    syncWorkflowCatalog(db);
    expect(() => stopCurrentRun(db, "weather-briefing")).toThrow(NotRunningError);
    expect(() => stopCurrentRun(db, "nonsense")).toThrow(UnknownWorkflowError);
  });
});

describe("what will not start", () => {
  test("a slug this database has never heard of", () => {
    syncWorkflowCatalog(db);
    expect(() => startWorkflowRun(db, "nonsense", {})).toThrow(UnknownWorkflowError);
  });

  test("a workflow with no code behind it", () => {
    syncWorkflowCatalog(db);
    expect(() => startWorkflowRun(db, "weather-briefing", { city: "Lisbon" }, { lookup: () => undefined })).toThrow(
      NotRunnableError,
    );
  });

  test("one you paused", () => {
    syncWorkflowCatalog(db);
    db.update(s.workflows)
      .set({ pausedAt: new Date(), pausedBy: "user" })
      .where(eq(s.workflows.slug, "weather-briefing"))
      .run();

    expect(() => startWorkflowRun(db, "weather-briefing", { city: "Lisbon" }, { lookup: ok })).toThrow(
      /you paused it/,
    );
  });

  test("arguments the workflow won't take — and no run row is left behind", () => {
    syncWorkflowCatalog(db);
    expect(() => startWorkflowRun(db, "weather-briefing", { city: "" }, { lookup: ok })).toThrow(WorkflowArgsError);
    expect(db.select().from(s.workflowRuns).all().length).toBe(0);
  });
});
