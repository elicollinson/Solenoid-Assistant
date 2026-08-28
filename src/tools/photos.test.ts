import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PromptInjectionDetectedError,
  PromptInjectionScreeningError,
  type Agent,
} from "../core/rawAgent";
import { readOnly, renderBriefing, type ToolGroup } from "../core/toolGroups";
import { createDb, runMigrations, type Db } from "../db";
import * as s from "../db/schema";
import { classifyScreenshots, photosGroup } from "./photos";

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

// The group, and the half of it backed by this database.
//
// Nothing below touches the Photos library: `get_recent_screenshots` is only
// ever inspected, never executed, so these tests pass on a machine with no
// osxphotos and no Photos library at all — the same trick the classification
// tests above play by injecting `describe`.
describe("photosGroup", () => {
  let dir: string;
  let db: Db;
  let group: ToolGroup;

  /** A stored screenshot, with the entity row every domain table hangs off. */
  function seedScreenshot(id: string, photosUuid: string): void {
    const capturedAt = new Date("2026-08-27T09:14:22.000Z");
    db.insert(s.entities)
      .values({ id, kind: "screenshot", createdAt: capturedAt, updatedAt: capturedAt })
      .run();
    db.insert(s.screenshots)
      .values({
        id,
        photosUuid,
        originalFilename: "Screenshot 2026-08-27 at 09.14.22.png",
        capturedAt,
        addedAt: capturedAt,
        width: 2880,
        height: 1800,
        path: "/Users/someone/Pictures/shot.png",
        uti: "public.png",
        safetyState: "clean",
        ingestState: "ingested",
      })
      .run();
    const analysisId = `${id}-a1`;
    db.insert(s.screenshotAnalyses)
      .values({
        id: analysisId,
        screenshotId: id,
        version: 1,
        isCurrent: true,
        summary: "An invoice with one unmatched line.",
        ocrText: "Invoice 2291 · $2,140.00",
        createdAt: capturedAt,
      })
      .run();
    db.insert(s.screenshotRegions)
      .values({ id: `${analysisId}-r0`, analysisId, ordinal: 0, label: "Row 14", note: "no matching ledger line" })
      .run();
    // A superseded reading of the same picture: photos_read must ignore it.
    db.insert(s.screenshotAnalyses)
      .values({
        id: `${id}-a0`,
        screenshotId: id,
        version: 0,
        isCurrent: false,
        summary: "An earlier, worse reading.",
        createdAt: capturedAt,
      })
      .run();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "photos-tools-"));
    db = createDb(join(dir, "test.db"));
    runMigrations(db);
    group = photosGroup({ db });
  });

  afterEach(() => {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("hands over both halves of a screenshot under one name", () => {
    expect(group.name).toBe("photos");
    expect(group.tools.map((tool) => tool.definition.function.name)).toEqual([
      "get_recent_screenshots",
      "photos_read",
    ]);
    expect(group.shape.singular).toBe("screenshot");
    // The spine is the library item; the stored row is a separate block, so a
    // model cannot read "has no analysis" as "was never taken".
    expect(group.shape.spine.map((field) => field.name)).toContain("uuid");
    expect(group.shape.related?.length).toBe(3);
  });

  test("holds nothing that changes anything, so its read-only form is itself", () => {
    for (const tool of group.tools) expect(tool.kind).toBe("read");
    expect(readOnly(group)).toBe(group);
  });

  test("every tool says what it is for at a length worth reading", () => {
    for (const tool of group.tools) {
      const params = tool.definition.function.parameters as { type?: string };
      expect(params.type).toBe("object");
      expect(tool.definition.function.description.length).toBeGreaterThan(200);
    }
  });

  test("the briefing says the writing on a screenshot is somebody else's", () => {
    const briefing = renderBriefing(group);
    expect(briefing).toContain("untrusted");
    expect(briefing).toContain("ocrText");
    // Rendered from the tools, so a group that lost one could not advertise it.
    expect(briefing).toContain("photos_read(id)");
  });

  test("photos_read answers with the current analysis and its regions", async () => {
    seedScreenshot("shot-1", "UUID-1");
    const read = group.tools.find((tool) => tool.definition.function.name === "photos_read")!;
    const result = (await read.execute(read.schema.parse({ id: "shot-1" }))) as {
      photosUuid: string;
      capturedAt: string;
      analysis: { version: number; ocrText: string; regions: { label: string }[] };
    };
    expect(result.photosUuid).toBe("UUID-1");
    expect(result.capturedAt).toBe("2026-08-27T09:14:22.000Z");
    expect(result.analysis.version).toBe(1);
    expect(result.analysis.ocrText).toBe("Invoice 2291 · $2,140.00");
    expect(result.analysis.regions.map((region) => region.label)).toEqual(["Row 14"]);
  });

  test("photos_read takes the osxphotos uuid the library tool answers with", async () => {
    seedScreenshot("shot-2", "UUID-2");
    const read = group.tools.find((tool) => tool.definition.function.name === "photos_read")!;
    const result = (await read.execute(read.schema.parse({ id: "UUID-2" }))) as { id: string };
    expect(result.id).toBe("shot-2");
  });

  test("photos_read says nothing is stored rather than inventing a screenshot", async () => {
    const read = group.tools.find((tool) => tool.definition.function.name === "photos_read")!;
    const result = (await read.execute(read.schema.parse({ id: "never-ingested" }))) as {
      error: string;
    };
    expect(result.error).toContain("never-ingested");
  });
});
