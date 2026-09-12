import { initDb } from "../db";
import { describe, expect, test } from "bun:test";
import type { Agent } from "../core/rawAgent";
import type { AgentResource } from "../agents/resource";
import { ingestRecentScreenshots } from "./screenshotIngestion";
import { syncWorkflowCatalog } from "./sync";
import { withWorkflowPermissions, withRunPermissions } from "./permissions";
import { grantWorkflowPermission, readDeferredWrite } from "../db/mutations/workflows";
import { runDeferredWrite } from "./deferred";
import * as s from "../db/schema";
import { eq } from "drizzle-orm";

function unusedResource(): AgentResource {
  return {
    agent: {} as Agent,
    close: async () => {},
  };
}

describe("ingestRecentScreenshots", () => {
  test("propagates classification quarantine into item status and summary", async () => {
    const result = await ingestRecentScreenshots({}, {
      classify: async () => ({
        windowStart: "2026-01-01T00:00:00.000Z",
        windowEnd: "2026-01-02T00:00:00.000Z",
        returned: 2,
        totalInWindow: 2,
        failed: 1,
        quarantined: 1,
        screenshots: [
          {
            uuid: "unsafe-id",
            filename: "unsafe.png",
            date: "2026-01-01T12:00:00.000Z",
            path: "/tmp/unsafe.png",
            status: "quarantined",
            classification: null,
            error: "Classification quarantined by prompt-injection screening",
          },
          {
            uuid: "failed-id",
            filename: "failed.png",
            date: "2026-01-01T12:01:00.000Z",
            path: "/tmp/failed.png",
            status: "failed",
            classification: null,
            error: "Classification failed: provider unavailable",
          },
        ],
      }),
      createContentResource: async () => unusedResource(),
      db: initDb(":memory:"),
      loadProcessed: async () => ({}),
    });

    expect(result.quarantined).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.screenshots.map(({ status }) => status)).toEqual([
      "quarantined",
      "failed",
    ]);
  });
});

test("saves successful screenshots locally, skips receipts, and isolates sourcing failures", async () => {
  const db = initDb(":memory:");
  syncWorkflowCatalog(db);
  let calls = 0, closes = 0;
  const shots = ["ok", "bad", "old", "reject"].map((uuid) => ({
    uuid, filename: `${uuid}.png`, path: `/tmp/${uuid}.png`, date: "2026-09-12T10:00:00Z",
    status: "classified" as const,
    classification: { classification: uuid === "reject" ? "Rejected" as const : "Music" as const, name: uuid },
  }));
  const dependencies = {
    db,
    classify: async () => ({ windowStart: "2026-09-12", windowEnd: "2026-09-13", returned: shots.length, totalInWindow: shots.length, failed: 0, quarantined: 0, screenshots: shots }),
    loadProcessed: async () => ({ old: { classification: "Music", name: "old", ingestedAt: "2026-09-01" } }),
    createContentResource: async () => ({
      agent: { run: async (name: string) => {
        calls++;
        if (name === "bad") throw new Error("Search unavailable");
        return { name, type: "Song", url: "https://example.com/song", description: "A song", coverImageUrl: "" };
      } } as unknown as Agent,
      close: async () => { closes++; },
    }),
  };
  try {
    const result = await withWorkflowPermissions(db, "screenshot-ingestion", () => ingestRecentScreenshots({}, dependencies));
    expect(result.screenshots.map((s) => s.status)).toEqual(["ingested", "failed", "skipped", "rejected"]);
    expect(result.screenshots[0]!.ingestion?.itemId).toBeTruthy();
    expect(result.failed).toBe(1); expect(calls).toBe(2); expect(closes).toBe(1);
    const retry = await withWorkflowPermissions(db, "screenshot-ingestion", () => ingestRecentScreenshots({}, dependencies));
    expect(retry.screenshots[0]!.status).toBe("skipped"); expect(calls).toBe(3);
    expect(db.$client.query("SELECT count(*) AS n FROM collection_items").get()).toEqual({ n: 1 });
  } finally { db.$client.close(); }
});

for (const mode of ["allow", "deny", "ask", "missing-context"] as const) {
  test(`collection save respects ${mode} without creating a receipt on refusal`, async () => {
    const db = initDb(":memory:");
    syncWorkflowCatalog(db);
    if (mode !== "missing-context") grantWorkflowPermission(db, "screenshot-ingestion", { capability: "collections.write", mode });
    const run = () => ingestRecentScreenshots({}, collectionDependencies(db));
    try {
      const result = await (mode === "missing-context" ? run() : withWorkflowPermissions(db, "screenshot-ingestion", run));
      expect(result.screenshots[0]!.status).toBe(mode === "allow" ? "ingested" : mode === "missing-context" ? "failed" : "skipped");
      expect(db.select().from(s.collectionItems).all()).toHaveLength(mode === "allow" ? 1 : 0);
      expect(db.select().from(s.collectionSources).all()).toHaveLength(mode === "allow" ? 1 : 0);
      expect(db.select().from(s.decisions).all()).toHaveLength(0);
      if (mode !== "allow") expect(result.screenshots[0]!.error).toBeTruthy();
    } finally { db.$client.close(); }
  });
}

test("ask defers the full extraction, approval saves once, and a later deny blocks replay", async () => {
  const db = initDb(":memory:");
  syncWorkflowCatalog(db);
  grantWorkflowPermission(db, "screenshot-ingestion", { capability: "collections.write", mode: "ask" });
  const workflow = db.select().from(s.workflows).where(eq(s.workflows.slug, "screenshot-ingestion")).get()!;
  const runId = "collection-run";
  const now = new Date();
  db.insert(s.entities).values({ id: runId, kind: "workflow_run", createdAt: now, updatedAt: now }).run();
  db.insert(s.workflowRuns).values({ id: runId, workflowId: workflow.id, ordinal: 1, trigger: "manual", triggeredBy: "user", state: "running", startedAt: now }).run();
  try {
    const result = await withRunPermissions({ db, workflowId: workflow.id, runId, slug: workflow.slug }, () => ingestRecentScreenshots({}, collectionDependencies(db)));
    expect(result.screenshots[0]!.status).toBe("skipped");
    expect(db.select().from(s.collectionSources).all()).toHaveLength(0);
    const action = db.select().from(s.actions).where(eq(s.actions.effectKind, "tool_call")).get()!;
    const call = readDeferredWrite(db, action.id)!;
    expect(call.open).toBe(true);
    expect(call.tool).toBe("collections_save_screenshot");
    expect((await runDeferredWrite(db, call, { db })).ran).toBe(true);
    expect((await runDeferredWrite(db, call, { db })).ran).toBe(true);
    const sources = db.select().from(s.collectionSources).all();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.contentCard.description).toBe("A novel");
    grantWorkflowPermission(db, "screenshot-ingestion", { capability: "collections.write", mode: "deny" });
    expect(await runDeferredWrite(db, { ...call, args: { ...(call.args as object), uuid: "another" } }, { db })).toMatchObject({ ran: false, reason: "denied" });
    expect(db.select().from(s.collectionSources).all()).toHaveLength(1);
  } finally { db.$client.close(); }
});

function collectionDependencies(db: ReturnType<typeof initDb>) {
  return {
    db, loadProcessed: async () => ({}),
    classify: async () => ({ windowStart: "2026-09-12", windowEnd: "2026-09-13", returned: 1, totalInWindow: 1, failed: 0, quarantined: 0,
      screenshots: [{ uuid: "book", filename: "book.png", path: "/tmp/book.png", date: "2026-09-12T10:00:00Z", status: "classified" as const,
        classification: { classification: "Book" as const, name: "Dune" } }] }),
    createContentResource: async () => ({ agent: { run: async () => ({ name: "Dune", type: "Book", description: "A novel", url: "https://example.com/dune", coverImageUrl: "" }) } as unknown as Agent, close: async () => {} }),
  };
}
