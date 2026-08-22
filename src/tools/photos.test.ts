import { describe, expect, test } from "bun:test";
import type { Agent } from "../core/rawAgent";
import { classifyScreenshots } from "./photos";

describe("classifyScreenshots", () => {
  test("counts a vision failure once", async () => {
    const result = await classifyScreenshots({} as Agent, {}, {
      describe: async () => ({
        windowStart: "2026-01-01T00:00:00.000Z",
        windowEnd: "2026-01-02T00:00:00.000Z",
        returned: 1,
        totalInWindow: 1,
        failed: 1,
        screenshots: [
          {
            uuid: "one",
            filename: "one.png",
            date: "2026-01-01T12:00:00.000Z",
            path: "",
            description: null,
            error: "vision failed",
          },
        ],
      }),
    });

    expect(result.failed).toBe(1);
    expect(result.screenshots[0]?.error).toBe("vision failed");
  });
});
