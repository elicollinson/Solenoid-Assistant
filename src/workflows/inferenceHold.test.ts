// Lending the inference host out: holds, the queue they fill, and the routes
// another machine's scripts call. The workflow body is substituted, as in
// runner.test.ts; what is under test is when work waits and in what order it
// comes back.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb, runMigrations, type Db } from "../db";
import * as s from "../db/schema";
import { createInferenceRoutes } from "../http/routes/inference";
import { holdInference, inferenceHeld, inferenceStatus, releaseInference, type InferenceHoldStatus } from "./inferenceHold";
import type { RunnableWorkflow } from "./registry";
import { cancelWorkflowRun, nextQueuedRun, queueWorkflowRun, startQueuedRun } from "./runner";
import { syncWorkflowCatalog } from "./sync";

let dir: string;
let db: Db;
const ran: string[] = [];

const lookup = (slug: string): RunnableWorkflow | undefined =>
  slug === "weather-briefing"
    ? {
        slug,
        schema: z.object({ city: z.string().min(1) }),
        execute: (async ({ city }: { city: string }) => {
          ran.push(city);
          return { output: { city }, effects: [], prose: [] };
        }) as RunnableWorkflow["execute"],
      }
    : undefined;

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 24, 3, minutes));
const runState = (runId: string) =>
  db.select({ state: s.workflowRuns.state }).from(s.workflowRuns).where(eq(s.workflowRuns.id, runId)).all()[0]?.state;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-hold-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  syncWorkflowCatalog(db);
  ran.length = 0;
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("holds", () => {
  test("are named, so one holder releasing leaves another's hold in place", () => {
    holdInference(db, { holder: "evals:a" }, at(0));
    holdInference(db, { holder: "evals:b", reason: "sweep" }, at(1));
    expect(releaseInference(db, "evals:a", at(2)).holds.map((hold) => hold.holder)).toEqual(["evals:b"]);
    expect(inferenceHeld(db, at(2))).toBe(true);
    expect(releaseInference(db, "evals:b", at(3)).held).toBe(false);
  });

  test("renew rather than stack when the same holder asks again", () => {
    holdInference(db, { holder: "evals", minutes: 10 }, at(0));
    const renewed = holdInference(db, { holder: "evals", minutes: 60 }, at(5));
    expect(renewed.holds).toHaveLength(1);
    expect(renewed.holds[0]!.expiresAt).toBe(at(65).toISOString());
  });

  test("expire, so a script that dies before releasing cannot pause forever", () => {
    holdInference(db, { holder: "evals", minutes: 10 }, at(0));
    expect(inferenceHeld(db, at(9))).toBe(true);
    expect(inferenceHeld(db, at(10))).toBe(false);
    // And the lapsed one does not block the same holder from holding again.
    expect(holdInference(db, { holder: "evals", minutes: 10 }, at(20)).held).toBe(true);
  });

  test("refuse a holder name that could not be released safely", () => {
    expect(() => holdInference(db, { holder: "evals; drop" })).toThrow();
  });
});

describe("the queue", () => {
  test("keeps each firing, folds identical ones, and drains oldest first", async () => {
    const lisbon = queueWorkflowRun(db, "weather-briefing", { city: "Lisbon" }, { now: at(0), lookup });
    const again = queueWorkflowRun(db, "weather-briefing", { city: "Lisbon" }, { now: at(1), lookup });
    const porto = queueWorkflowRun(db, "weather-briefing", { city: "Porto" }, { now: at(2), lookup });
    expect(again).toEqual({ ...lisbon, coalesced: true });
    expect(porto.coalesced).toBe(false);
    expect(runState(lisbon.runId)).toBe("queued");
    expect(inferenceStatus(db).queued).toBe(2);

    for (let runId = nextQueuedRun(db); runId; runId = nextQueuedRun(db)) {
      await startQueuedRun(db, runId, { now: at(30), lookup })?.settled;
    }
    expect(ran).toEqual(["Lisbon", "Porto"]);
    expect(runState(lisbon.runId)).toBe("done");
    expect(inferenceStatus(db).queued).toBe(0);
  });

  test("re-checks a run as it leaves, and writes down why one cannot start", () => {
    const queued = queueWorkflowRun(db, "weather-briefing", { city: "Lisbon" }, { now: at(0), lookup });
    db.update(s.workflows).set({ pausedAt: at(1) }).where(eq(s.workflows.slug, "weather-briefing")).run();
    expect(startQueuedRun(db, queued.runId, { now: at(2), lookup })).toBeUndefined();
    const [run] = db.select().from(s.workflowRuns).where(eq(s.workflowRuns.id, queued.runId)).all();
    expect(run?.state).toBe("cancelled");
    expect(run?.error).toContain("you paused it");
    expect(nextQueuedRun(db)).toBeUndefined();
  });

  test("lets a person take a run off the queue before it starts", () => {
    const queued = queueWorkflowRun(db, "weather-briefing", { city: "Lisbon" }, { now: at(0), lookup });
    cancelWorkflowRun(db, queued.runId, at(1));
    expect(runState(queued.runId)).toBe("cancelled");
    expect(nextQueuedRun(db)).toBeUndefined();
    expect(ran).toEqual([]);
  });
});

describe("routes", () => {
  const token = "t".repeat(40);
  const routes = () => createInferenceRoutes(() => db);
  const call = (path: string, init: RequestInit = {}, bearer: string | null = token) =>
    routes().handle(new Request(`http://localhost${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    }));
  const status = async (response: Response) => (await response.json()) as InferenceHoldStatus;

  beforeEach(() => { process.env.INFERENCE_HOLD_TOKEN = token; });
  afterEach(() => { delete process.env.INFERENCE_HOLD_TOKEN; });

  test("refuse without the token, and refuse everything while it is unset", async () => {
    expect((await call("/api/inference/hold", {}, null)).status).toBe(401);
    expect((await call("/api/inference/hold", {}, "wrong")).status).toBe(401);
    delete process.env.INFERENCE_HOLD_TOKEN;
    expect((await call("/api/inference/hold")).status).toBe(401);
  });

  test("hold, report, and release", async () => {
    const held = await call("/api/inference/hold", { method: "POST", body: JSON.stringify({ holder: "evals", minutes: 30 }) });
    expect(held.status).toBe(200);
    expect((await status(held)).held).toBe(true);
    expect((await status(await call("/api/inference/hold"))).holds[0]?.holder).toBe("evals");
    const released = await call("/api/inference/release", { method: "POST", body: JSON.stringify({ holder: "evals" }) });
    expect((await status(released)).held).toBe(false);
  });

  test("answer a malformed request with 400, not 500", async () => {
    expect((await call("/api/inference/hold", { method: "POST", body: "{" })).status).toBe(400);
    expect((await call("/api/inference/hold", { method: "POST", body: JSON.stringify({ minutes: 5 }) })).status).toBe(400);
  });
});
