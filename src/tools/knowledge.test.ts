// The Knowledge group, exercised the way an agent reaches it.
//
// Two things are worth guarding here and they are not the same. One is the
// shape of the group — that every tool is a read, and therefore that the
// read-only form of the group is the group itself, which is the whole claim
// the file header makes. The other is that the four tools answer from a real
// indexed bundle rather than from fixtures, because a projection that is not
// rebuilt from the files is exactly the failure this group is designed around.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "../core/tools";
import { readOnly, renderBriefing, type ToolGroup } from "../core/toolGroups";
import { createDb, runMigrations, type Db } from "../db";
import { reindexOkf } from "../db/okf/reindex";
import { writeOkfFixture } from "../db/seed/okfBundle";
import { zonedTime } from "../db/seed/time";
import { knowledgeGroup } from "./knowledge";

let dir: string;
let db: Db;
let group: ToolGroup;

// The same fixed morning ../db/queries/knowledge.test.ts reads the store on.
const MORNING = zonedTime(2026, 8, 25, 9, 20);

/** Exercise a tool the way Agent.invokeTool does: validate at the boundary, then run. */
async function call(name: string, args: unknown = {}): Promise<unknown> {
  const tool = group.tools.find((t) => t.definition.function.name === name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return (tool as AgentTool).execute(tool.schema.parse(args));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "knowledge-tools-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  await reindexOkf(db, { root: writeOkfFixture(join(dir, "okf")), now: MORNING });
  group = knowledgeGroup({ db });
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the group", () => {
  test("is well-formed and exposes exactly the four tools", () => {
    expect(group.name).toBe("knowledge");
    expect(group.shape.singular).toBe("memory");
    expect(group.tools.map((t) => t.definition.function.name)).toEqual([
      "knowledge_list",
      "knowledge_read",
      "knowledge_search",
      "knowledge_conflicts",
    ]);
  });

  test("every tool is a read, because a write here would land in a cache", () => {
    for (const tool of group.tools) expect(tool.kind).toBe("read");
  });

  test("every tool name is prefixed, so none can collide with the okf group's", () => {
    for (const tool of group.tools) {
      expect(tool.definition.function.name.startsWith("knowledge_")).toBe(true);
    }
  });

  test("every tool carries a description and a schema the model can be shown", () => {
    for (const tool of group.tools) {
      const params = tool.definition.function.parameters as { type?: string; properties?: object };
      expect(params.type).toBe("object");
      expect(Object.keys(params.properties ?? {}).length).toBeGreaterThan(0);
      expect(tool.definition.function.description).not.toBe("");
    }
  });

  test("the read-only form is the group itself — there is nothing to drop", () => {
    // Identity rather than equality: readOnly hands the group straight back
    // when its filter removed nothing, so a NEW object here would mean a write
    // tool had got in and been dropped.
    expect(readOnly(group)).toBe(group);
    const fresh = knowledgeGroup({ db });
    expect(readOnly(fresh)).toBe(fresh);
    expect(readOnly(group).tools).toBe(group.tools);
  });

  test("the briefing has no writing section and sends writes to the okf group", () => {
    const briefing = renderBriefing(group);
    expect(briefing).toContain("Reading — these change nothing:");
    expect(briefing).not.toContain("Writing —");
    expect(briefing).toContain("okf");
  });

  test("the shape hides the indexer's bookkeeping and the reading trail", () => {
    const named = new Set(group.shape.spine.map((f) => f.name));
    expect(named.has("uri")).toBe(true);
    expect(named.has("staleAfter")).toBe(true);
    // Neither an operator's question nor a column an agent can act on.
    for (const hidden of ["contentSha256", "fileMtime", "fileSize", "indexedAt", "indexVersion", "frontmatter"]) {
      expect(named.has(hidden)).toBe(false);
    }
    expect(group.shape.related?.map((r) => r.fields.length).every((n) => n > 0)).toBe(true);
  });
});

describe("knowledge_list", () => {
  test("returns the store, newest written first, with a counted lede", async () => {
    const payload = (await call("knowledge_list")) as {
      lede: string;
      count: number;
      rows: { name: string; uri: string; facts: number }[];
    };
    expect(payload.count).toBeGreaterThan(0);
    expect(payload.rows[0]?.uri.startsWith("okf:")).toBe(true);
    expect(payload.lede).not.toBe("");
  });

  test("narrows to the memories holding a disagreement", async () => {
    const payload = (await call("knowledge_list", { conflictedOnly: true })) as {
      rows: { name: string }[];
    };
    expect(payload.rows.length).toBe(1);
    expect(payload.rows[0]?.name).toContain("shed roof");
  });

  test("a group nobody uses returns nothing rather than everything", async () => {
    const payload = (await call("knowledge_list", { group: "Health and care" })) as { count: number };
    expect(payload.count).toBe(0);
  });

  test("rejects the out-of-range limit and the invented group a model might improvise", () => {
    const list = group.tools[0]!;
    expect(() => list.schema.parse({ limit: 500 })).toThrow();
    expect(() => list.schema.parse({ group: "Things" })).toThrow();
    expect(list.schema.parse({})).toMatchObject({ conflictedOnly: false, staleOnly: false, limit: 50 });
  });
});

describe("knowledge_read", () => {
  test("takes the id, and takes the uri too", async () => {
    const listed = (await call("knowledge_list")) as { rows: { id: string; uri: string }[] };
    const first = listed.rows[0]!;
    const byId = (await call("knowledge_read", { id: first.id })) as { uri: string };
    const byUri = (await call("knowledge_read", { id: first.uri })) as { uri: string };
    expect(byId.uri).toBe(first.uri);
    expect(byUri.uri).toBe(first.uri);
  });

  test("hands back the prose, the facts with their provenance, and the account", async () => {
    const listed = (await call("knowledge_list", { conflictedOnly: true })) as { rows: { id: string }[] };
    const memory = (await call("knowledge_read", { id: listed.rows[0]!.id })) as {
      fields: { label: string; value: string; provenance: string; conflict: boolean }[];
      sections: { heading: string }[];
      account: string[];
      conflict: string | null;
    };
    expect(memory.sections.map((s) => s.heading)).toContain("Quotes");
    expect(memory.fields.filter((f) => f.conflict).length).toBe(2);
    expect(memory.fields[0]?.provenance).not.toBe("");
    expect(memory.account.length).toBeGreaterThan(0);
    expect(memory.conflict).not.toBeNull();
  });

  test("answers an unknown id with a refusal rather than an empty memory", async () => {
    expect(await call("knowledge_read", { id: "okf:memories/never-written" })).toMatchObject({
      error: expect.stringContaining("No memory"),
    });
  });
});

describe("knowledge_search", () => {
  test("matches a title and says where it matched", async () => {
    const found = (await call("knowledge_search", { query: "shed roof" })) as {
      rows: { name: string; matchedIn: string[] }[];
    };
    expect(found.rows.length).toBe(1);
    expect(found.rows[0]?.matchedIn).toContain("title");
  });

  test("matches a fact's value and returns it, so a hit can be judged before a read", async () => {
    const found = (await call("knowledge_search", { query: "ridge and felt" })) as {
      rows: { matchedIn: string[]; facts: { value: string }[] }[];
    };
    expect(found.rows[0]?.matchedIn).toContain("fact");
    expect(found.rows[0]?.facts.map((f) => f.value)).toContain("£1,240, ridge and felt");
  });

  test("includeBody off drops the memories that only mention the term in passing", async () => {
    const inProse = (await call("knowledge_search", { query: "Newer is not the same" })) as { count: number };
    const without = (await call("knowledge_search", {
      query: "Newer is not the same",
      includeBody: false,
    })) as { count: number };
    expect(inProse.count).toBe(1);
    expect(without.count).toBe(0);
  });

  test("a term nothing uses returns nothing, and a one-letter query is refused", async () => {
    expect(await call("knowledge_search", { query: "helicopter" })).toMatchObject({ count: 0 });
    expect(() => group.tools[2]!.schema.parse({ query: "a" })).toThrow();
  });
});

describe("knowledge_conflicts", () => {
  test("surfaces both answers to the question asked twice, neither superseded", async () => {
    const payload = (await call("knowledge_conflicts")) as {
      count: number;
      rows: {
        memory: { name: string };
        resolvedAt: Date | null;
        answers: { value: string; provenance: string }[];
      }[];
    };
    expect(payload.count).toBe(1);
    const [conflict] = payload.rows;
    expect(conflict?.memory.name).toContain("shed roof");
    expect(conflict?.resolvedAt).toBeNull();
    expect(conflict?.answers.map((a) => a.value)).toEqual(["£1,240, ridge and felt", "£980, felt only"]);
  });

  test("defaults to the open ones, since a settled conflict is history", () => {
    expect(group.tools[3]!.schema.parse({})).toMatchObject({ includeResolved: false, limit: 50 });
  });
});
