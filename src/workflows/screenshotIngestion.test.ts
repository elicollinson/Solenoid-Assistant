import { initDb } from "../db";
import { describe, expect, test } from "bun:test";
import type { Agent } from "../core/rawAgent";
import type { AgentResource } from "../agents/resource";
import { ingestRecentScreenshots } from "./screenshotIngestion";

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
    const result = await ingestRecentScreenshots({}, dependencies);
    expect(result.screenshots.map((s) => s.status)).toEqual(["ingested", "failed", "skipped", "rejected"]);
    expect(result.screenshots[0]!.ingestion?.itemId).toBeTruthy();
    expect(result.failed).toBe(1); expect(calls).toBe(2); expect(closes).toBe(1);
    const retry = await ingestRecentScreenshots({}, dependencies);
    expect(retry.screenshots[0]!.status).toBe("skipped"); expect(calls).toBe(3);
    expect(db.$client.query("SELECT count(*) AS n FROM collection_items").get()).toEqual({ n: 1 });
  } finally { db.$client.close(); }
});
