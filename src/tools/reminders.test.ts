// The reminders group, exercised the way an agent reaches it.
//
// What matters here is the boundary rather than the writes — ../db/mutations/
// reminders.test.ts already checks what each write does to the table. This
// checks that the group is well formed, that every tool is classified by what
// it actually does to the database, that `readOnly` leaves exactly the tools an
// agent holding a stranger's text may have, and that the briefing rendered from
// all of it says what is true.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, type Db } from "../db";
import type { AgentTool } from "../core/tools";
import { readOnly, renderBriefing, type ToolGroup } from "../core/toolGroups";
import { remindersGroup } from "./reminders";

let dir: string;
let db: Db;
let group: ToolGroup;

/** Which tools an agent reading a stranger's text may hold, and what each of
 *  the others is. Written out rather than derived, so a tool that quietly
 *  changes kind has to be changed here too. */
const KINDS: Record<string, "read" | "write"> = {
  reminders_list: "read",
  reminders_read: "read",
  reminders_create: "write",
  reminders_revise: "write",
  reminders_complete: "write",
  reminders_dismiss: "write",
};

const tool = (name: string): AgentTool => {
  const found = group.tools.find((t) => t.definition.function.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

/** Exercise a tool the way Agent.invokeTool does: validate at the boundary,
 *  then run. Async so a refusal thrown synchronously reaches the caller as the
 *  rejection an agent loop would actually see. */
async function call(name: string, args: unknown): Promise<unknown> {
  const t = tool(name);
  return t.execute(t.schema.parse(args));
}

/** Two days out, in the timezone the product runs in. These tools read the
 *  real clock — there is no `now` to inject, because the buckets are answers
 *  about right now — so a fixture date has to be relative to it. */
const IN_TWO_DAYS = new Date(Date.now() + 2 * 86_400_000).toISOString();

const create = async (over: Record<string, unknown> = {}) =>
  ((await call("reminders_create", {
    title: "Send Fenwick the meter reading",
    blurb: "Their terms give you until the 30th, and the reading has to be theirs, not yours.",
    prose: ["They will estimate if nothing arrives."],
    dueAt: IN_TWO_DAYS,
    originKind: "conversation",
    originLabel: "from thread/9a44",
    meta: [{ label: "Invoices", value: "two, £84 between them" }],
    ...over,
  })) as { id: string }).id;

const listed = async (args: Record<string, unknown> = {}) =>
  (await call("reminders_list", args)) as { count: number; rows: { id: string; group: string; state: string }[] };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reminder-tools-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  group = remindersGroup({ db });
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the group", () => {
  test("is well formed, and carries the six tools under the name its loader is built from", () => {
    expect(group.name).toBe("reminders");
    expect(group.shape.singular).toBe("reminder");
    expect(group.summary.length).toBeGreaterThan(40);
    expect(group.purpose.length).toBeGreaterThan(200);
    expect(group.guidance?.length ?? 0).toBeGreaterThan(200);
    expect(group.tools.map((t) => t.definition.function.name)).toEqual(Object.keys(KINDS));
  });

  test("classifies every tool by what it does to the database, not by how it reads", () => {
    for (const t of group.tools) {
      expect(t.kind).toBe(KINDS[t.definition.function.name]!);
    }
  });

  test("every tool says when to use it, and produces a schema the model can be shown", () => {
    for (const t of group.tools) {
      const params = t.definition.function.parameters as { type?: string; properties?: object };
      expect(params.type).toBe("object");
      expect(Object.keys(params.properties ?? {}).length).toBeGreaterThan(0);
      // A one-line description is not enough for a surface a person reads.
      expect(t.definition.function.description.length).toBeGreaterThan(200);
    }
  });

  test("the spine documents the columns and hides the ones nothing here can use", () => {
    const spine = group.shape.spine.map((f) => f.name);
    expect(spine).toContain("dueAt");
    expect(spine).toContain("completedReason");
    // A documented column the agent cannot reach is an invitation to ask for a
    // tool that does not exist.
    expect(spine).not.toContain("snoozedUntil");
    expect(spine).not.toContain("recurrenceRrule");
    expect(spine).not.toContain("dueTz");
    // Every documented one carries a sentence rather than only a type.
    for (const field of group.shape.spine) expect(field.note?.length ?? 0).toBeGreaterThan(10);
  });

  test("nothing is offered for setting a bucket, a mark or a when — all three are derived", () => {
    const derived = (group.shape.derived ?? []).map((f) => f.name);
    expect(derived).toEqual(["group", "when", "mark", "source", "gated"]);

    for (const name of ["group", "when", "mark", "gated"]) {
      const owners = group.tools.filter(
        (t) => name in ((t.definition.function.parameters as { properties?: Record<string, unknown> }).properties ?? {}),
      );
      // `group` is a filter on the list tool, so it is allowed there and only there.
      expect(owners.every((t) => t.definition.function.name === "reminders_list")).toBe(true);
    }
    const fields = group.tools
      .flatMap((t) => Object.keys((t.definition.function.parameters as { properties?: object }).properties ?? {}))
      .join();
    expect(fields).not.toContain("completedAt");
  });
});

describe("what an agent reading a stranger's text is given", () => {
  test("readOnly leaves exactly the two tools that change nothing", () => {
    const restricted = readOnly(group);
    expect(restricted.tools.map((t) => t.definition.function.name)).toEqual(["reminders_list", "reminders_read"]);
    expect(restricted.tools.every((t) => t.kind === "read")).toBe(true);
    // Same group otherwise: it is the tools that are dropped, not the prose.
    expect(restricted.name).toBe(group.name);
    expect(restricted.purpose).toBe(group.purpose);
  });

  test("the briefing is rendered from the tools it actually has, so it cannot advertise a write it will refuse", () => {
    const full = renderBriefing(group);
    expect(full).toContain("reminders_create");
    expect(full).toContain("reminders_dismiss");

    const restricted = renderBriefing(readOnly(group));
    expect(restricted).toContain("reminders_list");
    expect(restricted).not.toContain("reminders_create");
    expect(restricted).not.toContain("reminders_complete");
  });
});

describe("argument validation at the boundary", () => {
  test("a reminder needs a title and nothing else", () => {
    expect(() => tool("reminders_create").schema.parse({})).toThrow();
    expect(tool("reminders_create").schema.parse({ title: "Renew the permit" })).toMatchObject({
      title: "Renew the permit",
      state: "idle",
      setBy: "agent",
    });
  });

  test("the closed states cannot be written directly, either way round", () => {
    expect(() => tool("reminders_create").schema.parse({ title: "t", state: "done" })).toThrow();
    expect(() => tool("reminders_revise").schema.parse({ id: "x", state: "cancelled" })).toThrow();
  });

  test("a due date is a timestamp, or the empty string that means no date at all", () => {
    expect(() => tool("reminders_create").schema.parse({ title: "t", dueAt: "next Tuesday" })).toThrow();
    expect(() => tool("reminders_revise").schema.parse({ id: "x", dueAt: "soon" })).toThrow();
    expect(tool("reminders_revise").schema.parse({ id: "x", dueAt: "" })).toMatchObject({ dueAt: "" });
  });

  test("calling one off cannot be done without saying why; finishing one can", () => {
    expect(() => tool("reminders_dismiss").schema.parse({ id: "x" })).toThrow();
    expect(() => tool("reminders_dismiss").schema.parse({ id: "x", because: "" })).toThrow();
    expect(tool("reminders_complete").schema.parse({ id: "x" })).toMatchObject({ by: "agent" });
  });

  test("the list is capped so a long history cannot fill a context window", () => {
    expect(tool("reminders_list").schema.parse({})).toMatchObject({ limit: 50 });
    expect(() => tool("reminders_list").schema.parse({ limit: 500 })).toThrow();
    expect(() => tool("reminders_list").schema.parse({ group: "Next year" })).toThrow();
  });
});

describe("what comes back", () => {
  test("what create answers with is what the other five take", async () => {
    const id = await create();
    expect(await call("reminders_revise", { id, blurb: "The 30th is theirs." })).toMatchObject({ id, revised: true });
    expect(await call("reminders_complete", { id, because: "Sent it." })).toMatchObject({ id, state: "done" });
  });

  test("the list carries the stored state and the computed bucket side by side", async () => {
    const soon = await create();
    const someday = await create({ title: "Ask about the boiler", dueAt: undefined });
    await call("reminders_dismiss", { id: someday, because: "They rang first." });

    const all = await listed();
    expect(all.rows.find((r) => r.id === soon)?.group).toBe("This week");
    // The mark folds cancelled into idle; the stored state does not, which is
    // the only way to tell what was called off from what was finished.
    expect(all.rows.find((r) => r.id === someday)).toMatchObject({ group: "Closed", state: "cancelled" });

    expect((await listed({ group: "Closed" })).rows.map((r) => r.id)).toEqual([someday]);
    expect((await listed({ state: "idle" })).rows.map((r) => r.id)).toEqual([soon]);
    expect((await listed({ limit: 1 })).count).toBe(1);
  });

  test("read answers with the whole thing, and says so plainly when there is nothing there", async () => {
    const id = await create();
    expect(await call("reminders_read", { id })).toMatchObject({
      id,
      title: "Send Fenwick the meter reading",
      group: "This week",
      source: "from thread/9a44",
      note: "Their terms give you until the 30th, and the reading has to be theirs, not yours.",
      prose: ["They will estimate if nothing arrives."],
      gate: null,
      evidence: [],
    });
    expect(await call("reminders_read", { id: "01NOTHING" })).toEqual({ error: "No reminder with id 01NOTHING" });
  });

  test("a refusal from the write layer reaches the agent rather than being swallowed", async () => {
    const id = await create();
    await call("reminders_complete", { id });
    expect(call("reminders_revise", { id, title: "something else" })).rejects.toThrow(/already done/);
    expect(call("reminders_dismiss", { id, because: "changed my mind" })).rejects.toThrow(/already done/);
  });
});
