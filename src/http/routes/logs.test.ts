// What the Logs tab actually reads, and what happens when the store is not
// there.
//
// The fallback is the point of these tests. VictoriaLogs is a second service
// on a laptop that gets closed; a log pane that breaks, or that silently shows
// four lines while claiming to show the run, is worse than one that says which
// half it is showing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, ulid, type Db } from "../../db";
import * as s from "../../db/schema";
import { syncWorkflowCatalog } from "../../workflows/sync";
import type { WorkflowRunLogsPayload } from "../../shared/workflows";
import { logStamp } from "../../db/queries/_format";
import { createLogRoutes } from "./logs";

let dir: string;
let db: Db;
let runId: string;
const started = new Date("2026-08-26T10:00:00.000Z");

/** A run with two lines on the record — the runner's own bookkeeping. */
function seedRun(): string {
  const [workflow] = db.select().from(s.workflows).limit(1).all();
  const id = ulid(started.getTime());
  db.insert(s.entities).values({ id, kind: "workflow_run", createdAt: started, updatedAt: started }).run();
  db.insert(s.workflowRuns)
    .values({ id, workflowId: workflow!.id, ordinal: 1, trigger: "manual", state: "done", startedAt: started })
    .run();
  db.insert(s.runLogs).values({ runId: id, at: started, seq: 0, level: "info", text: "Run 1 started by you." }).run();
  db.insert(s.runLogs).values({ runId: id, at: started, seq: 1, level: "ok", text: "Run 1 finished in 3s." }).run();
  return id;
}

/** A stand-in VictoriaLogs that answers `/select/logsql/query`. */
function collector(answer: (query: string) => Response) {
  const asked: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = new URLSearchParams(await request.text());
      const query = body.get("query") ?? "";
      asked.push(query);
      return answer(query);
    },
  });
  return { asked, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const ndjson = (rows: Record<string, unknown>[]) =>
  new Response(rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

let previousEndpoint: string | undefined;
let previousEnabled: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-logs-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  syncWorkflowCatalog(db);
  runId = seedRun();
  previousEndpoint = process.env.VICTORIALOGS_ENDPOINT;
  previousEnabled = process.env.VICTORIALOGS_ENABLED;
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
  if (previousEndpoint == null) delete process.env.VICTORIALOGS_ENDPOINT;
  else process.env.VICTORIALOGS_ENDPOINT = previousEndpoint;
  if (previousEnabled == null) delete process.env.VICTORIALOGS_ENABLED;
  else process.env.VICTORIALOGS_ENABLED = previousEnabled;
});

const routes = () => createLogRoutes(() => db);

async function logsFor(id: string): Promise<{ status: number; body: WorkflowRunLogsPayload }> {
  const response = await routes().handle(new Request(`http://localhost/api/runs/${id}/logs`));
  return { status: response.status, body: (await response.json()) as WorkflowRunLogsPayload };
}

describe("GET /api/runs/:runId/logs", () => {
  test("prefers the log store, and says so", async () => {
    const fake = collector(() =>
      ndjson([
        { _time: "2026-08-26T10:00:01.500Z", _msg: "asked the model", level: "info", service: "solenoid-server", component: "llm" },
        { _time: "2026-08-26T10:00:00.100Z", _msg: "Run 1 started by you.", level: "info", service: "solenoid-server", component: "workflow" },
      ]),
    );
    process.env.VICTORIALOGS_ENDPOINT = fake.url;
    try {
      const { status, body } = await logsFor(runId);
      expect(status).toBe(200);
      expect(body.source).toBe("victorialogs");
      expect(body.note).toBeNull();
      // Oldest first, and carrying the component the run record has no column for.
      expect(body.lines.map((l) => l.text)).toEqual(["Run 1 started by you.", "asked the model"]);
      expect(body.lines[1]).toMatchObject({ component: "llm", service: "solenoid-server" });
      // The same formatter the run record's lines go through — the two sources
      // answer one pane, and a stamp that shifts when the store goes down is a
      // log nobody can read a sequence out of.
      expect(body.lines[0]!.t).toBe(logStamp(new Date("2026-08-26T10:00:00.100Z")));
      expect(fake.asked[0]).toContain(`run_id:="${runId}"`);
    } finally {
      fake.stop();
    }
  });

  test("falls back to the run record when the store does not answer, and never fails the read", async () => {
    process.env.VICTORIALOGS_ENDPOINT = "http://127.0.0.1:1";
    const { status, body } = await logsFor(runId);
    expect(status).toBe(200);
    expect(body.source).toBe("database");
    expect(body.note).toContain("unreachable");
    expect(body.lines.map((l) => l.text)).toEqual(["Run 1 started by you.", "Run 1 finished in 3s."]);
  });

  // A store that was down while the run went has nothing for it. Showing the
  // few lines that were kept beats showing an empty pane and calling it the log.
  test("falls back when the store is up but has nothing for this run", async () => {
    const fake = collector(() => new Response(""));
    process.env.VICTORIALOGS_ENDPOINT = fake.url;
    try {
      const { body } = await logsFor(runId);
      expect(body.source).toBe("database");
      expect(body.note).toContain("Nothing in the log store");
      expect(body.lines).toHaveLength(2);
    } finally {
      fake.stop();
    }
  });

  test("says so rather than reaching out at all when shipping is switched off", async () => {
    process.env.VICTORIALOGS_ENABLED = "false";
    const { body } = await logsFor(runId);
    expect(body.source).toBe("database");
    expect(body.note).toContain("VICTORIALOGS_ENABLED");
  });

  test("404s a run that does not exist, rather than answering with an empty log", async () => {
    const response = await routes().handle(new Request("http://localhost/api/runs/nope/logs"));
    expect(response.status).toBe(404);
  });
});

describe("POST /api/logs", () => {
  test("accepts a batch from the browser", async () => {
    const response = await routes().handle(
      new Request("http://localhost/api/logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          entries: [{ level: "error", message: "Uncaught: boom", component: "window" }],
        }),
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1 });
  });

  test("refuses a level it does not know, so the store keeps five of them", async () => {
    const response = await routes().handle(
      new Request("http://localhost/api/logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries: [{ level: "critical", message: "x" }] }),
      }),
    );
    expect(response.status).toBe(422);
  });
});
