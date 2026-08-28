// The activity group, checked at the boundary an agent actually reaches.
//
// Two things are being asserted, and the second is the one that matters. The
// first is ordinary: the group is well formed, the filters filter, the read
// tool assembles what it points at. The second is that this group has no
// writes and cannot grow one by accident — `readOnly` hands back the very same
// group, and the briefing has no writing section for a model to read as an
// offer. A write tool arriving here later should break this file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, ulid, type Db } from "../db";
import * as s from "../db/schema";
import type { AgentTool } from "../core/tools";
import { readOnly, renderBriefing, type ToolGroup } from "../core/toolGroups";
import { activityGroup } from "./activity";

let dir: string;
let db: Db;
let group: ToolGroup;

/** Exercise a tool the way Agent.invokeTool does: validate at the boundary,
 *  then run. Defaults fill in here rather than in the test's arguments. */
async function call(tool: AgentTool, args: unknown = {}): Promise<any> {
  return tool.execute(tool.schema.parse(args));
}

const toolNamed = (name: string): AgentTool => {
  const found = group.tools.find((t) => t.definition.function.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

const DAY = 86_400_000;
const NOW = new Date("2026-08-28T12:00:00.000Z");

function entity(kind: (typeof s.ENTITY_KIND)[number], at: Date): string {
  const id = ulid(at.getTime());
  db.insert(s.entities).values({ id, kind, createdAt: at, updatedAt: at }).run();
  return id;
}

/**
 * One workflow, one run of it, and one feed entry narrating that run — the
 * shape every seeded entry has, because an entry with nothing behind it is not
 * a thing this product writes.
 */
function seedEntry(over: Partial<typeof s.activityItems.$inferInsert> = {}, occurredAt = NOW): string {
  const workflowId = entity("workflow", occurredAt);
  db.insert(s.workflows)
    .values({
      id: workflowId,
      slug: `wf-${workflowId}`,
      name: "Contract review",
      triggerKind: "on_demand",
      createdAt: occurredAt,
    })
    .run();

  const runId = entity("workflow_run", occurredAt);
  db.insert(s.workflowRuns)
    .values({
      id: runId,
      workflowId,
      ordinal: 3,
      trigger: "manual",
      triggeredBy: "user",
      state: "attention",
      stepIndex: 6,
      stepTotal: 11,
      startedAt: occurredAt,
      durationMs: 41_000,
    })
    .run();
  db.insert(s.runSteps)
    .values({
      id: entity("run_step", occurredAt),
      runId,
      ordinal: 0,
      name: "gmail.draft",
      detail: "thread/1f8ac2",
      state: "ok",
      isTool: true,
      toolName: "gmail.draft",
      durationMs: 1_900,
    })
    .run();

  const itemId = entity("activity_item", occurredAt);
  const decisionId = entity("decision", occurredAt);
  db.insert(s.decisions)
    .values({
      id: decisionId,
      subjectId: itemId,
      title: "Approve the Ferris contract reply",
      body: "Nothing goes out until you say so.",
      state: "open",
      blocking: true,
      openedAt: occurredAt,
    })
    .run();

  db.insert(s.activityItems)
    .values({
      id: itemId,
      occurredAt,
      state: "attention",
      title: "Reply to the Ferris contract amendment",
      badge: "needs you",
      prominence: "prominent",
      framed: true,
      sourceId: runId,
      workflowId,
      runId,
      decisionId,
      toolSummary: "4 tool calls · gmail.draft, memory.read ×2",
      progressValue: 6,
      progressTotal: 11,
      ...over,
    })
    .run();

  db.insert(s.narratives)
    .values([
      {
        id: ulid(),
        subjectId: itemId,
        slot: "account",
        ordinal: 0,
        text: "I drafted a reply agreeing to the March 1 start.",
        generatedAt: occurredAt,
      },
      {
        id: ulid(),
        subjectId: itemId,
        slot: "account",
        ordinal: 1,
        text: "I would rather you read it before it goes out.",
        generatedAt: occurredAt,
      },
    ])
    .run();

  db.insert(s.actions)
    .values({
      id: ulid(),
      subjectId: itemId,
      decisionId,
      ordinal: 0,
      label: "Send it",
      stance: "affirm",
      effectKind: "tool_call",
      effect: { tool: "gmail.send" },
      createdAt: occurredAt,
    })
    .run();

  return itemId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "activity-tools-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  group = activityGroup({ db });
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the group", () => {
  test("is well formed and offers the two reads plus the one note", () => {
    expect(group.name).toBe("activity");
    expect(group.shape.singular).toBe("activity item");
    expect(group.tools.map((t) => t.definition.function.name)).toEqual([
      "activity_list",
      "activity_read",
      "activity_annotate",
    ]);
  });

  // The line this group is built on: you may remark on a record that stands,
  // and you may not make one. If a second write ever appears here, it has to
  // pass that test in somebody's head first, and this fails until it does.
  test("annotating is the only write, because posting would invent the record", () => {
    expect(group.tools.filter((t) => t.kind === "write").map((t) => t.definition.function.name))
      .toEqual(["activity_annotate"]);
    const names = group.tools.map((t) => t.definition.function.name);
    for (const forbidden of ["activity_post", "activity_create", "activity_dismiss", "activity_read_mark"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  test("every tool says enough for a model to choose it, and hands the model a schema", () => {
    for (const tool of group.tools) {
      const params = tool.definition.function.parameters as { type?: string; properties?: object };
      expect(params.type).toBe("object");
      expect(Object.keys(params.properties ?? {}).length).toBeGreaterThan(0);
      // A one-line description is not enough for a surface a person reads.
      expect(tool.definition.function.description.length).toBeGreaterThan(200);
    }
  });

  test("the spine is read off the table, so every column the agent may see is documented", () => {
    const named = new Set(group.shape.spine.map((f) => f.name));
    for (const column of ["occurredAt", "state", "title", "runId", "decisionId", "dismissedAt"]) {
      expect(named.has(column)).toBe(true);
    }
    // Prose about the two derived columns is the point of the group; check the
    // notes are there rather than checking their wording.
    expect(group.shape.spine.every((f) => f.note)).toBe(true);
  });
});

describe("read-only", () => {
  test("readOnly drops the note tool", () => {
    expect(readOnly(group)).not.toBe(group);
    expect(readOnly(group).tools.map((t) => t.definition.function.name)).toEqual([
      "activity_list",
      "activity_read",
    ]);
  });

  test("the full briefing separates the reads from the one write", () => {
    const briefing = renderBriefing(group);
    expect(briefing).toContain("Reading — these change nothing:");
    expect(briefing).toContain("Writing —");
    // The reason is the centrepiece, not a footnote: an agent that reads only
    // the briefing should still learn why it cannot post to the feed.
    expect(briefing).toContain("derived");
  });

  test("an agent holding untrusted text is not told the note tool exists", () => {
    const briefing = renderBriefing(readOnly(group));
    expect(briefing).not.toContain("activity_annotate");
    expect(briefing).not.toContain("Writing —");
  });
});

describe("activity_list", () => {
  test("returns the feed newest first, with the first paragraph of each account", async () => {
    const older = seedEntry({ title: "Q3 vendor reconciliation" }, new Date(NOW.getTime() - DAY));
    const newer = seedEntry();

    const out = await call(toolNamed("activity_list"));
    expect(out.count).toBe(2);
    expect(out.rows.map((r: any) => r.id)).toEqual([newer, older]);
    expect(out.rows[0].account).toBe("I drafted a reply agreeing to the March 1 start.");
    expect(out.rows[0].progress).toEqual({ value: 6, total: 11 });
  });

  test("leaves out what the person cleared away, unless asked", async () => {
    seedEntry({ dismissedAt: NOW });
    expect((await call(toolNamed("activity_list"))).count).toBe(0);
    expect((await call(toolNamed("activity_list"), { includeDismissed: true })).count).toBe(1);
  });

  test("filters by state, by unread and by window", async () => {
    seedEntry({ state: "done", readAt: NOW }, new Date(NOW.getTime() - 3 * DAY));
    seedEntry({ state: "attention" });

    expect((await call(toolNamed("activity_list"), { state: "attention" })).count).toBe(1);
    expect((await call(toolNamed("activity_list"), { unreadOnly: true })).count).toBe(1);
    expect(
      (await call(toolNamed("activity_list"), { since: new Date(NOW.getTime() - DAY).toISOString() })).count,
    ).toBe(1);
    expect((await call(toolNamed("activity_list"), { until: NOW.toISOString() })).count).toBe(2);
  });

  test("an empty feed is an answer, not an error", async () => {
    expect(await call(toolNamed("activity_list"))).toEqual({ count: 0, rows: [] });
  });
});

describe("activity_read", () => {
  test("carries the whole account and what the entry points at", async () => {
    const id = seedEntry();
    const out = await call(toolNamed("activity_read"), { id });

    expect(out.account).toEqual([
      "I drafted a reply agreeing to the March 1 start.",
      "I would rather you read it before it goes out.",
    ]);
    expect(out.workflow.name).toBe("Contract review");
    expect(out.run.ordinal).toBe(3);
    expect(out.toolCalls).toEqual([
      { name: "gmail.draft", detail: "thread/1f8ac2", note: null, state: "ok", durationMs: 1_900 },
    ]);
    expect(out.decision.title).toBe("Approve the Ferris contract reply");
    expect(out.decision.blocking).toBe(true);
    expect(out.buttons.map((b: any) => b.label)).toEqual(["Send it"]);
    // Unpressed: the question on the feed is still open.
    expect(out.buttons[0].invokedAt).toBeNull();
  });

  test("an unknown id is an answer the model can act on rather than a throw", async () => {
    expect(await call(toolNamed("activity_read"), { id: "nope" })).toEqual({
      error: "No activity item with id nope",
    });
  });
});
