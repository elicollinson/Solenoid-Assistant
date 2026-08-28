// The catalog as a whole, which is the one thing no single group can check.
//
// Each group's own test file proves that group is well formed. None of them can
// prove the ten of them fit together: that no two claim the same tool name,
// that every one has a read-only form for an agent holding a stranger's text,
// and that the loaders an agent is handed at the start of a run stay small
// enough to be worth the arrangement. That is what this file is for.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolBelt, loaderName, renderBriefing, renderLoaderDescription } from "../core/toolGroups";
import { createDb, runMigrations, type Db } from "../db";
import * as s from "../db/schema";
import {
  NoSuchToolGroupError,
  TOOL_GROUP_CATALOG,
  buildToolGroups,
  type ToolGroupContext,
} from "./groups";

let dir: string;
let db: Db;
let context: ToolGroupContext;

const NAMES = Object.keys(TOOL_GROUP_CATALOG);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "groups-catalog-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  context = { db, okf: { root: join(dir, "okf"), actor: "catalog/test" } };
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the catalog", () => {
  test("offers the ten groups this service was built for", () => {
    expect(NAMES).toEqual([
      "recommendations", "reminders", "calendar", "workflows", "knowledge",
      "activity", "okf", "imessage", "photos", "contacts",
    ]);
  });

  test("every entry is keyed by the name its group answers to", () => {
    for (const [key, factory] of Object.entries(TOOL_GROUP_CATALOG)) {
      expect(factory(context).name).toBe(key);
    }
  });

  test("names a group that does not exist rather than failing obscurely", () => {
    expect(() => buildToolGroups(context, ["remindeers"])).toThrow(NoSuchToolGroupError);
    expect(() => buildToolGroups(context, ["remindeers"])).toThrow(/recommendations, reminders/);
  });
});

describe("all ten together", () => {
  // The collision no individual group could have caught: ToolBelt refuses two
  // groups that answer to one tool name, so building the whole catalog into one
  // belt is the assertion.
  test("no two groups claim the same tool name", () => {
    const belt = new ToolBelt(buildToolGroups(context, NAMES, { trust: "full" }));
    expect(belt.size).toBe(NAMES.length);
    expect(belt.names).toEqual(NAMES);
  });

  test("every tool is classified read or write", () => {
    for (const group of buildToolGroups(context, NAMES, { trust: "full" })) {
      for (const tool of group.tools) {
        expect(["read", "write"]).toContain(tool.kind);
      }
    }
  });

  // The property the whole trust split rests on. A group with no read tools at
  // all would throw here rather than silently hand an untrusted agent nothing.
  test("every group has a read-only form, and it contains no writes", () => {
    for (const group of buildToolGroups(context, NAMES)) {
      expect(group.tools.length).toBeGreaterThan(0);
      expect(group.tools.filter((tool) => tool.kind === "write")).toEqual([]);
    }
  });

  test("read-only is what you get by not asking", () => {
    const implicit = buildToolGroups(context, NAMES);
    const explicit = buildToolGroups(context, NAMES, { trust: "read_only" });
    expect(implicit.map((g) => g.tools.length)).toEqual(explicit.map((g) => g.tools.length));

    const full = buildToolGroups(context, NAMES, { trust: "full" });
    const restricted = implicit.reduce((n, g) => n + g.tools.length, 0);
    const everything = full.reduce((n, g) => n + g.tools.length, 0);
    expect(restricted).toBeLessThan(everything);
  });

  // The licence for registering every briefing as authored text
  // (../safety/authoredText.ts): a briefing must be a pure function of CODE. If
  // a factory ever reached into its context for a row, an attacker who could
  // write that row could have their text redacted out of the injection screen's
  // view. Two contexts, two databases, byte-identical output — which asserting
  // renderBriefing(g) === renderBriefing(g) never could.
  test("no group's briefing depends on the data it is built against", () => {
    const second = mkdtempSync(join(tmpdir(), "groups-catalog-alt-"));
    try {
      const otherDb = createDb(join(second, "other.db"));
      runMigrations(otherDb);
      // Something in the tables, so an accidental read would show up as a diff.
      const now = new Date();
      const id = "01JQTESTACTIVITYITEM00000";
      otherDb.insert(s.entities)
        .values({ id, kind: "activity_item", createdAt: now, updatedAt: now }).run();
      otherDb.insert(s.activityItems)
        .values({ id, occurredAt: now, title: "A row that must not reach a briefing", state: "done" }).run();

      const other: ToolGroupContext = {
        db: otherDb,
        okf: { root: join(second, "elsewhere"), actor: "a-different-actor" },
      };
      for (const name of NAMES) {
        const a = TOOL_GROUP_CATALOG[name]!(context);
        const b = TOOL_GROUP_CATALOG[name]!(other);
        expect(renderBriefing(b)).toBe(renderBriefing(a));
        expect(renderLoaderDescription(b)).toBe(renderLoaderDescription(a));
      }
      otherDb.$client.close();
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  // A restricted group must not advertise what it dropped. `readOnly` enforces
  // this itself now; this keeps the catalog honest about it end to end.
  test("a read-only briefing never names a write tool", () => {
    const writeNames = buildToolGroups(context, NAMES, { trust: "full" })
      .flatMap((group) => group.tools)
      .filter((tool) => tool.kind === "write")
      .map((tool) => tool.definition.function.name);
    expect(writeNames.length).toBeGreaterThan(0);

    const belt = new ToolBelt(buildToolGroups(context, NAMES));
    for (const name of NAMES) {
      const briefing = belt.briefingFor(name);
      for (const write of writeNames) expect(briefing).not.toContain(write);
    }
  });
});

describe("what a session actually costs", () => {
  // The whole bargain: an agent offered every group holds ten loaders, not the
  // sixty-odd tool definitions behind them. If this ever stops being a large
  // saving, the arrangement has stopped paying for itself.
  test("ten loaders cost far less than the tools they stand in for", () => {
    const groups = buildToolGroups(context, NAMES, { trust: "full" });
    const belt = new ToolBelt(groups);
    const session = belt.session();

    const loaders = session.definitions();
    expect(loaders).toHaveLength(NAMES.length);
    expect(loaders.map((d) => d.function.name)).toEqual(NAMES.map(loaderName));

    const upfront = JSON.stringify(loaders).length;
    const everything = JSON.stringify(groups.flatMap((g) => g.tools.map((t) => t.definition))).length;
    expect(upfront).toBeLessThan(everything / 3);
  });

  test("a group's tools are unreachable until its loader is called", () => {
    const session = new ToolBelt(buildToolGroups(context, NAMES, { trust: "full" })).session();
    expect(session.resolve("recommendations_propose")).toBeUndefined();
    expect(session.unopenedOwnerOf("recommendations_propose")).toBe("recommendations");

    session.preopen("recommendations");
    expect(session.resolve("recommendations_propose")).toBeDefined();
    // Opening one group opens exactly one group.
    expect(session.resolve("calendar_create")).toBeUndefined();
  });
});
