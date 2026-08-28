// The tool surface, exercised the way an agent reaches it.
//
// What matters here is the boundary rather than the writes — ../db/mutations/
// recommendations.test.ts already checks what each write does to the table.
// This checks that the schemas validate what they should, that every tool the
// model is shown carries a description worth reading, and that the shape each
// one hands back is one the next call can use.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, type Db } from "../db";
import type { AgentTool } from "../core/tools";
import { readOnly, renderBriefing } from "../core/toolGroups";
import {
  createRecommendationTools,
  recommendationsGroup,
  type RecommendationTools,
} from "./recommendations";

let dir: string;
let db: Db;
let tools: RecommendationTools;

/** Exercise a tool the way Agent.invokeTool does: validate at the boundary, then
 *  run. Async so a refusal thrown synchronously reaches the caller as the
 *  rejection an agent loop would actually see. */
async function call(tool: AgentTool, args: unknown): Promise<unknown> {
  return tool.execute(tool.schema.parse(args));
}

const propose = async (over: Record<string, unknown> = {}) =>
  ((await call(tools.propose, {
    title: "Let me settle vendor differences under £50 myself",
    blurb: "I asked you about fourteen of these last quarter and you approved every one.",
    confidence: "strong",
    basisLabel: "14 approvals · 0 rejections",
    from: "6 runs",
    effect: [{ label: "Questions I'd stop asking", value: "roughly 12 a quarter" }],
    affirm: "Set the floor at £50",
    quiet: "Keep asking me",
    ...over,
  })) as { id: string }).id;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rec-tools-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  tools = createRecommendationTools(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("tool surface", () => {
  test("exposes the eight tools, and separates the two an agent reading strangers may hold", () => {
    expect(tools.all.map((t) => t.definition.function.name)).toEqual([
      "recommendations_list",
      "recommendations_read",
      "recommendations_propose",
      "recommendations_revise",
      "recommendations_cite",
      "recommendations_answer",
      "recommendations_withdraw",
      "recommendations_supersede",
      "recommendations_forget",
    ]);
    expect(readOnly(recommendationsGroup({ db })).tools.map((t) => t.definition.function.name)).toEqual([
      "recommendations_list",
      "recommendations_read",
    ]);
  });

  test("every tool produces a JSON schema the model can be shown, and says what it is for", () => {
    for (const tool of tools.all) {
      const params = tool.definition.function.parameters as { type?: string; properties?: object };
      expect(params.type).toBe("object");
      expect(Object.keys(params.properties ?? {}).length).toBeGreaterThan(0);
      // A one-line description is not enough for a surface a person reads.
      expect(tool.definition.function.description.length).toBeGreaterThan(200);
    }
  });

  test("nothing is offered for setting a shelf, a mark or a when — all three are derived", () => {
    const fields = tools.all
      .flatMap((t) => Object.keys((t.definition.function.parameters as { properties?: object }).properties ?? {}))
      .join();
    for (const derived of ["group", "shelf", "state", "mark", "when"]) {
      // `group` is a filter on the list tool, so it is allowed there and only there.
      const owners = tools.all.filter((t) =>
        derived in ((t.definition.function.parameters as { properties?: Record<string, unknown> }).properties ?? {}),
      );
      expect(owners.every((t) => t.definition.function.name === "recommendations_list")).toBe(true);
    }
    expect(fields).not.toContain("decidedAt");
  });
});

describe("argument validation at the boundary", () => {
  test("a proposal needs a title and nothing else", () => {
    expect(() => tools.propose.schema.parse({})).toThrow();
    expect(tools.propose.schema.parse({ title: "Read the mail first" })).toMatchObject({ title: "Read the mail first" });
  });

  test("confidence, stance and shelf are named rather than free text", () => {
    expect(() => tools.propose.schema.parse({ title: "t", confidence: "very-sure" })).toThrow();
    expect(() => tools.answer.schema.parse({ id: "x", stance: "maybe" })).toThrow();
    expect(() => tools.list.schema.parse({ group: "Somewhere else" })).toThrow();
  });

  test("answering defaults to recording what a person said, not what the agent decided", () => {
    expect(tools.answer.schema.parse({ id: "x", stance: "adopted" })).toMatchObject({ answeredBy: "user" });
  });

  test("forgetting cannot be reached without saying so", () => {
    expect(() => tools.forget.schema.parse({ id: "x" })).toThrow();
    expect(() => tools.forget.schema.parse({ id: "x", confirm: false })).toThrow();
    expect(tools.forget.schema.parse({ id: "x", confirm: true })).toMatchObject({ confirm: true });
  });

  test("the list is capped so a long history cannot fill a context window", () => {
    expect(tools.list.schema.parse({})).toMatchObject({ limit: 50 });
    expect(() => tools.list.schema.parse({ limit: 500 })).toThrow();
  });

  test("citing needs at least one citation", () => {
    expect(() => tools.cite.schema.parse({ id: "x", citations: [] })).toThrow();
  });
});

describe("what comes back", () => {
  test("proposing answers with an id the other tools accept", async () => {
    const id = await propose();
    expect(await call(tools.read, { id })).toMatchObject({ id, group: "Waiting on you" });
  });

  test("the list carries the stored status as well as the shelf it is read into", async () => {
    const kept = await propose();
    const gone = await propose({ title: "Move inbox triage to 05:30 on Tuesdays" });
    await call(tools.withdraw, { id: gone, because: "The pattern broke." });

    const listed = (await call(tools.list, {})) as { rows: { id: string; status: string; group: string }[] };
    expect(listed.rows.find((r) => r.id === kept)).toMatchObject({ status: "proposed", group: "Waiting on you" });
    // Three statuses share the last shelf, and only `status` tells them apart.
    expect(listed.rows.find((r) => r.id === gone)).toMatchObject({ status: "withdrawn", group: "Set aside" });
  });

  test("filtering by status is narrower than filtering by shelf", async () => {
    const declined = await propose();
    const withdrawn = await propose({ title: "Move inbox triage to 05:30 on Tuesdays" });
    await call(tools.answer, { id: declined, stance: "declined" });
    await call(tools.withdraw, { id: withdrawn });

    const shelf = (await call(tools.list, { group: "Set aside" })) as { count: number };
    const status = (await call(tools.list, { status: "withdrawn" })) as { count: number; rows: { id: string }[] };
    expect(shelf.count).toBe(2);
    expect(status.count).toBe(1);
    expect(status.rows[0]?.id).toBe(withdrawn);
  });

  test("reading one that is not there says so rather than throwing at the model", async () => {
    expect(await call(tools.read, { id: "nope" })).toEqual({ error: "No recommendation with id nope" });
  });

  test("superseding takes both ids and leaves both rows", async () => {
    const old = await propose();
    const fresh = await propose({ title: "Let me settle vendor differences under £80 myself" });
    expect(await call(tools.supersede, { id: old, supersededBy: fresh })).toMatchObject({ status: "superseded" });

    const listed = (await call(tools.list, {})) as { rows: { id: string; status: string }[] };
    expect(listed.rows.map((r) => r.status).sort()).toEqual(["proposed", "superseded"]);
  });

  test("citing points at something that exists, and says so when it does not", async () => {
    const id = await propose();
    await expect(call(tools.cite, { id, citations: [{ sourceId: "not-a-thing" }] })).rejects.toThrow(/Nothing to cite/);
    expect(await call(tools.read, { id })).toMatchObject({ evidence: [] });
  });

  test("a suggestion cannot be answered twice through the tool either", async () => {
    const id = await propose();
    await call(tools.answer, { id, stance: "adopted" });
    await expect(call(tools.answer, { id, stance: "declined" })).rejects.toThrow(/already adopted/);
  });
});

// The same tools, reached the way an agent actually gets them: through a loader
// that hands over a briefing and unlocks the group. What is checked here is the
// group's own contract — that the briefing is complete, that every tool is
// classified by what it does, and that the read-only form is the one an agent
// holding a stranger's text may be given.
describe("the tool group", () => {
  const kinds: Record<string, "read" | "write"> = {
    recommendations_list: "read",
    recommendations_read: "read",
    recommendations_propose: "write",
    recommendations_revise: "write",
    recommendations_cite: "write",
    recommendations_answer: "write",
    recommendations_withdraw: "write",
    recommendations_supersede: "write",
    recommendations_forget: "write",
  };

  test("is well formed, and offers every tool the factory has", () => {
    const group = recommendationsGroup({ db });
    // defineToolGroup would have thrown on a missing summary, a duplicate tool
    // or a name the loader cannot be built from; getting here is most of it.
    expect(group.name).toBe("recommendations");
    expect(group.shape.singular).toBe("recommendation");
    expect(group.tools.map((t) => t.definition.function.name)).toEqual(
      tools.all.map((t) => t.definition.function.name),
    );
    expect(group.purpose.trim().length).toBeGreaterThan(200);
    expect(group.guidance?.trim().length ?? 0).toBeGreaterThan(200);
  });

  test("every tool is classified by what it does, not by how its name reads", () => {
    for (const tool of recommendationsGroup({ db }).tools) {
      expect(tool.kind).toBe(kinds[tool.definition.function.name]!);
    }
  });

  test("the read-only form is the two tools that change nothing", () => {
    const restricted = readOnly(recommendationsGroup({ db }));
    expect(restricted.tools.map((t) => t.definition.function.name)).toEqual([
      "recommendations_list",
      "recommendations_read",
    ]);
    // And the briefing renders from the tools, so it cannot advertise a write
    // that agent would then be refused.
    expect(renderBriefing(restricted)).not.toContain("recommendations_propose");
  });

  test("the shape names every field a tool can set, and hides the bookkeeping", () => {
    const shape = recommendationsGroup({ db }).shape;
    const spine = shape.spine.map((f) => f.name);
    expect(spine).toContain("status");
    expect(spine).toContain("appliedPermissionId");
    // Filled in by the writes themselves. An agent told these exist would only
    // look for the tool that sets them, and there is none.
    for (const hidden of ["decidedAt", "decidedBy", "decisionId", "reRaiseAfter"]) {
      expect(spine).not.toContain(hidden);
    }
    // Every column shown carries a sentence; the mapped type in ../db/schemaDoc
    // makes an undocumented one a compile error, this catches an empty one.
    expect(shape.spine.every((f) => (f.note?.length ?? 0) > 20)).toBe(true);

    // The agent's writing lives in narratives, attributes and actions, so no
    // column would ever mention it. `derived` is the only place it is named.
    expect(shape.derived?.map((f) => f.name)).toEqual([
      "blurb",
      "prose",
      "restraint",
      "from",
      "effect",
      "affirm / quiet",
    ]);
    expect(shape.related?.[0]?.fields.map((f) => f.name)).toEqual(["sourceId", "title", "why", "quote"]);
  });

  test("the status machine is stated once, in the guidance rather than in five descriptions", () => {
    const group = recommendationsGroup({ db });
    expect(group.guidance).toContain("proposed is the only status");
    for (const tool of group.tools) {
      if (tool.kind !== "write") continue;
      // A description repeating "only while it is proposed" is the duplication
      // the guidance exists to remove.
      expect(tool.definition.function.description).not.toContain("proposed");
    }
  });

  test("the briefing stays inside a budget worth paying", () => {
    const briefing = renderBriefing(recommendationsGroup({ db }));
    expect(briefing).toContain("## The shape of one recommendation");
    expect(briefing).toContain("## How they move");
    // Roughly 2.8k tokens. The whole point of a group is that a session pays
    // for this only when it opens one, so a briefing that grows without anybody
    // noticing spends the saving it was built to make.
    expect(briefing.length).toBeLessThan(12_000);
  });
});
