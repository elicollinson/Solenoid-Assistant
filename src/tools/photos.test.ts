import { describe, expect, test } from "bun:test";
import {
  PromptInjectionDetectedError,
  PromptInjectionScreeningError,
  type Agent,
} from "../core/rawAgent";
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

  test("defaults local-model vision fanout to one request", async () => {
    let concurrency: number | undefined;
    await classifyScreenshots({} as Agent, {}, {
      describe: async (params) => {
        concurrency = params?.concurrency;
        return {
          windowStart: "2026-01-01T00:00:00.000Z",
          windowEnd: "2026-01-02T00:00:00.000Z",
          returned: 0,
          totalInWindow: 0,
          failed: 0,
          screenshots: [],
        };
      },
    });
    expect(concurrency).toBe(1);
  });

  test("quarantines one screenshot and continues classifying siblings", async () => {
    const classifier = {
      run: async (prompt: string) => {
        if (prompt.includes("unsafe")) {
          throw new PromptInjectionDetectedError("input");
        }
        return { classification: "Book", name: "Safe Book" };
      },
    } as unknown as Agent;
    const result = await classifyScreenshots(classifier, { concurrency: 2 }, {
      describe: async () => ({
        windowStart: "2026-01-01T00:00:00.000Z",
        windowEnd: "2026-01-02T00:00:00.000Z",
        returned: 2,
        totalInWindow: 2,
        failed: 0,
        screenshots: [
          {
            uuid: "unsafe-id",
            filename: "unsafe.png",
            date: "2026-01-01T12:00:00.000Z",
            path: "/tmp/unsafe.png",
            description: { app: "Chat", summary: "unsafe", prominentText: [] },
          },
          {
            uuid: "safe-id",
            filename: "safe.png",
            date: "2026-01-01T12:01:00.000Z",
            path: "/tmp/safe.png",
            description: { app: "Books", summary: "safe", prominentText: [] },
          },
        ],
      }),
    });

    expect(result.quarantined).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.screenshots[0]).toMatchObject({
      uuid: "unsafe-id",
      status: "quarantined",
      classification: null,
    });
    expect(result.screenshots[1]).toMatchObject({
      status: "classified",
      classification: {
        classification: "Book",
        name: "Safe Book",
      },
    });
  });

  test("scanner failure rejects screenshot classification", async () => {
    const classifier = {
      run: async () => {
        throw new PromptInjectionScreeningError();
      },
    } as unknown as Agent;
    const promise = classifyScreenshots(classifier, {}, {
      describe: async () => ({
        windowStart: "2026-01-01T00:00:00.000Z",
        windowEnd: "2026-01-02T00:00:00.000Z",
        returned: 1,
        totalInWindow: 1,
        failed: 0,
        screenshots: [{
          uuid: "one",
          filename: "one.png",
          date: "2026-01-01T12:00:00.000Z",
          path: "/tmp/one.png",
          description: { app: "Books", summary: "one", prominentText: [] },
        }],
      }),
    });
    await expect(promise).rejects.toBeInstanceOf(PromptInjectionScreeningError);
  });
});
