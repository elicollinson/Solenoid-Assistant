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
      createRecommendationResource: async () => unusedResource(),
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
