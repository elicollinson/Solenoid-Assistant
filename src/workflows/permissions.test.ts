// What a workflow may do with nobody watching, exercised through a real agent.
//
// The thing under test is not the lookup — that is three rows and a fallback —
// but the seam: a write tool called from inside a run has to be governed by the
// rule in the database without the agent, the tool or the workflow that wrote
// it knowing that permissions exist. So every case here goes through
// `Agent.invokeTool` with a scripted model, and asserts on what the tool
// actually did to the world.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { createDb, runMigrations, ulid, type Db } from "../db";
import * as s from "../db/schema";
import { Agent } from "../core/rawAgent";
import { defineTool } from "../core/tools";
import type { ChatMessage, ChatProvider } from "../core/providers";
import { grantWorkflowPermission, readDeferredWrite, settleDeferredWrite } from "../db/mutations/workflows";
import { loadHome } from "../db/queries/home";
import { loadWorkflow } from "../db/queries/workflows";
import { runDeferredWrite } from "./deferred";
import { syncWorkflowCatalog } from "./sync";
import { capabilityFor, resolvePermission, withRunPermissions, withWorkflowPermissions } from "./permissions";
import { Elysia } from "elysia";
import { remindersGroup } from "../tools/reminders";
import { createUiRoutes } from "../http/routes/ui";

class Scripted implements ChatProvider {
  readonly providerName = "scripted";
  readonly traced = true;
  calls = 0;
  constructor(private readonly script: Partial<ChatMessage>[]) {}
  async chat(): Promise<ChatMessage> {
    const next = this.script[this.calls++];
    if (!next) throw new Error(`no scripted response for call ${this.calls}`);
    return { role: "assistant", content: "", finishReason: "stop", ...next };
  }
}

let dir: string;
let db: Db;
let workflowId: string;
let runId: string;
/** What the gated tool actually did, if it ran at all. */
let ran: string[];

/** A write tool whose family is `memory`, so its capability is `memory.write`. */
const remember = defineTool({
  name: "memory_write",
  description: "Write a line into memory. Stands in for okf_patch, which needs a bundle on disk.",
  kind: "write",
  schema: z.object({ line: z.string() }),
  execute: ({ line }) => {
    ran.push(line);
    return { written: line };
  },
});

function agentFor(script: Partial<ChatMessage>[]): Agent {
  return new Agent({
    name: "under-test",
    routes: [{ client: new Scripted(script), model: "scripted" }],
    tools: [remember],
    promptInjectionScreening: false,
  });
}

const write = (line: string): Partial<ChatMessage> => ({
  finishReason: "tool_calls",
  toolCalls: [{ id: "c1", name: "memory_write", arguments: { line } }],
});

/** Run one turn the way `runner.ts` does — inside this run's permissions. */
async function turnUnderPermissions(line = "Ferris pays on the 30th."): Promise<string> {
  const agent = agentFor([write(line), { content: "done" }]);
  return withRunPermissions(
    { db, workflowId, runId, slug: "weather-briefing" },
    () => agent.runMessages([{ role: "user", content: "remember that", origin: "operator" }]),
  );
}

const openDecisions = () =>
  db.select().from(s.decisions).where(eq(s.decisions.state, "open")).all();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "permissions-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  syncWorkflowCatalog(db);
  ran = [];

  const [workflow] = db
    .select({ id: s.workflows.id })
    .from(s.workflows)
    .where(eq(s.workflows.slug, "weather-briefing"))
    .all();
  workflowId = workflow!.id;

  runId = ulid();
  db.insert(s.entities).values({ id: runId, kind: "workflow_run", createdAt: new Date(), updatedAt: new Date() }).run();
  db.insert(s.workflowRuns)
    .values({ id: runId, workflowId, ordinal: 1, trigger: "schedule", triggeredBy: "system", state: "running", startedAt: new Date() })
    .run();
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("naming the thing being governed", () => {
  test("a capability is the tool's family, however the family is spelled", () => {
    expect(capabilityFor("okf_create")).toBe("okf.write");
    expect(capabilityFor("calendar_set_attendees")).toBe("calendar.write");
    // MCP servers hyphenate. Both conventions have to land on one string, or a
    // rule written against one would silently govern nothing.
    expect(capabilityFor("remote-create-pages")).toBe("remote.write");
    expect(capabilityFor("standalone")).toBe("standalone.write");
  });
});

describe("resolving a rule", () => {
  test("this workflow's answer beats the global one", () => {
    db.insert(s.workflowPermissions)
      .values({ id: ulid(), workflowId: null, capability: "memory.write", mode: "allow", createdAt: new Date() })
      .run();
    grantWorkflowPermission(db, "weather-briefing", { capability: "memory.write", mode: "deny" });

    expect(resolvePermission(db, workflowId, "memory.write")).toEqual({ mode: "deny", scope: "workflow" });
  });

  test("a global rule governs a workflow that says nothing", () => {
    db.insert(s.workflowPermissions)
      .values({ id: ulid(), workflowId: null, capability: "memory.write", mode: "allow", createdAt: new Date() })
      .run();
    expect(resolvePermission(db, workflowId, "memory.write")).toEqual({ mode: "allow", scope: "global" });
  });

  test("revoking this workflow's rule falls back to the global one, not to the default", () => {
    db.insert(s.workflowPermissions)
      .values({ id: ulid(), workflowId: null, capability: "memory.write", mode: "allow", createdAt: new Date() })
      .run();
    grantWorkflowPermission(db, "weather-briefing", { capability: "memory.write", mode: "deny" });
    db.update(s.workflowPermissions)
      .set({ retiredAt: new Date() })
      .where(and(eq(s.workflowPermissions.workflowId, workflowId), isNull(s.workflowPermissions.retiredAt)))
      .run();

    expect(resolvePermission(db, workflowId, "memory.write")).toEqual({ mode: "allow", scope: "global" });
  });

  test("nothing anywhere is ask", () => {
    expect(resolvePermission(db, workflowId, "memory.write")).toEqual({ mode: "ask", scope: "default" });
  });
});

describe("what a run may actually do", () => {
  test("allow lets the write happen and says nothing to anybody", async () => {
    grantWorkflowPermission(db, "weather-briefing", { capability: "memory.write", mode: "allow" });

    expect(await turnUnderPermissions()).toBe("done");
    expect(ran).toEqual(["Ferris pays on the 30th."]);
    expect(openDecisions()).toEqual([]);
  });

  test("deny stops the write and tells the model plainly", async () => {
    grantWorkflowPermission(db, "weather-briefing", { capability: "memory.write", mode: "deny" });
    const agent = agentFor([write("anything"), { content: "I could not." }]);

    expect(
      await withRunPermissions(
        { db, workflowId, runId, slug: "weather-briefing" },
        () => agent.runMessages([{ role: "user", content: "remember that", origin: "operator" }]),
      ),
    ).toBe("I could not.");

    expect(ran).toEqual([]);
    // A refusal is not a question. Nothing is left waiting on anybody.
    expect(openDecisions()).toEqual([]);
  });

  test("ask writes nothing, finishes the run, and leaves the question for the morning", async () => {
    // No rule anywhere: the default is ask.
    expect(await turnUnderPermissions("Ferris pays on the 30th.")).toBe("done");
    expect(ran).toEqual([]);

    const [decision] = openDecisions();
    expect(decision).toBeDefined();
    // Not blocking: the run did not wait and has already finished.
    expect(decision!.blocking).toBe(false);
    expect(decision!.subjectId).toBe(runId);
    expect(decision!.title).toContain("memory_write");

    // The button carries the real call, so the record says what would happen
    // rather than "approve this".
    const actions = db.select().from(s.actions).where(eq(s.actions.decisionId, decision!.id)).all();
    const affirm = actions.find((a) => a.stance === "affirm");
    expect(affirm?.effectKind).toBe("tool_call");
    expect(affirm?.effect).toEqual({ tool: "memory_write", args: { line: "Ferris pays on the 30th." } });

    // And the facts name the rule you would edit to stop being asked.
    const facts = db.select().from(s.attributes).where(eq(s.attributes.subjectId, decision!.id)).all();
    expect(facts.map((f) => [f.label, f.value])).toContainEqual(["Governed by", "memory.write"]);
    expect(facts.map((f) => [f.label, f.value])).toContainEqual(["line", "Ferris pays on the 30th."]);
  });

  test("a read is never gated, whatever the rules say", async () => {
    grantWorkflowPermission(db, "weather-briefing", { capability: "memory.write", mode: "deny" });
    const seen: string[] = [];
    const look = defineTool({
      name: "memory_read",
      description: "Read a line back out of memory, changing nothing at all about it.",
      kind: "read",
      schema: z.object({}),
      execute: () => {
        seen.push("read");
        return { lines: [] };
      },
    });
    const agent = new Agent({
      name: "reader",
      routes: [{ client: new Scripted([
        { finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "memory_read", arguments: {} }] },
        { content: "nothing there" },
      ]), model: "scripted" }],
      tools: [look],
      promptInjectionScreening: false,
    });

    await withRunPermissions(
      { db, workflowId, runId, slug: "weather-briefing" },
      () => agent.runMessages([{ role: "user", content: "look", origin: "operator" }]),
    );
    expect(seen).toEqual(["read"]);
    expect(openDecisions()).toEqual([]);
  });
});

describe("outside a run", () => {
  test("there is no gate, because there is no workflow to have a rule about", async () => {
    const agent = agentFor([write("straight through"), { content: "done" }]);
    expect(await agent.runMessages([{ role: "user", content: "remember", origin: "operator" }])).toBe("done");
    expect(ran).toEqual(["straight through"]);
  });
});

describe("what the catalog ships with", () => {
  test("the workflows that write unattended declare their capabilities", () => {
    const seeded = db
      .select({ slug: s.workflows.slug, capability: s.workflowPermissions.capability, mode: s.workflowPermissions.mode })
      .from(s.workflowPermissions)
      .innerJoin(s.workflows, eq(s.workflows.id, s.workflowPermissions.workflowId))
      .where(isNull(s.workflowPermissions.retiredAt))
      .all();

    expect(seeded.map((r) => `${r.slug}:${r.capability}=${r.mode}`).sort()).toEqual([
      "log-monitoring:github.write=allow",
      "message-extraction:okf.write=allow",
      "okf-reflection:okf.write=allow",
      "screenshot-ingestion:collections.write=allow",
      "screenshot-ingestion:tavily.write=allow",
    ]);
  });

  test("seeding twice does not write a second rule, and never reopens one you retired", () => {
    db.update(s.workflowPermissions)
      .set({ retiredAt: new Date() })
      .where(eq(s.workflowPermissions.capability, "okf.write"))
      .run();

    syncWorkflowCatalog(db);

    const okf = db.select().from(s.workflowPermissions).where(eq(s.workflowPermissions.capability, "okf.write")).all();
    // Both workflows retain their retired rule. A sync is not the moment to hand
    // back a permission somebody took away.
    expect(okf.length).toBe(2);
    expect(okf.every(rule => rule.retiredAt !== null)).toBe(true);
  });
});

describe("a deferred write is visible, which is the whole point of writing it down", () => {
  // The first version of this feature wrote the `decisions` row and nothing
  // else, and no query in the product returned it. Three surfaces read a gate
  // and all three reach it through `activity_items`; these are those three.
  test("it reaches the home feed, the rail count and the Workflows pane", async () => {
    await turnUnderPermissions("Ferris pays on the 30th.");

    const home = loadHome(db);
    const items = home.sections.flatMap((section) => section.items);
    const gate = items.find((item) => item.title.includes("memory_write"));
    expect(gate).toBeDefined();
    expect(gate!.actions.map((a) => a.effectKind)).toContain("tool_call");
    // The rail counts the feed, so an entry nothing draws is an entry nobody
    // is told about.
    const activity = home.rail.groups.flatMap((g) => g.items).find((i) => i.label === "Activity");
    expect(activity?.count ?? 0).toBeGreaterThan(0);

    // And the run it belongs to shows it as the gate it is sitting on. The run
    // is ended first because that is what really happens: `ask` does not hold
    // the run, it finishes without the write and leaves the question behind.
    db.update(s.workflowRuns)
      .set({ state: "done", endedAt: new Date() })
      .where(eq(s.workflowRuns.id, runId))
      .run();
    // The detail pane's gate — `openGates` finds it by joining the decision to
    // the feed row, which is the join the first version of this had nothing to
    // satisfy.
    const detail = loadWorkflow(db, "weather-briefing");
    expect(detail?.gate).toBeTruthy();
    expect(detail?.gate?.actions.map((a) => a.label)).toEqual(["Write it", "Leave it"]);
  });
});

describe("answering one", () => {
  const deferredAction = () => {
    const [decision] = openDecisions();
    const actions = db.select().from(s.actions).where(eq(s.actions.decisionId, decision!.id)).all();
    return actions.find((a) => a.stance === "affirm")!;
  };

  test("saying yes actually makes the call the run wanted to make", async () => {
    await turnUnderPermissions("Ferris pays on the 30th.");
    expect(ran).toEqual([]);

    const call = readDeferredWrite(db, deferredAction().id);
    expect(call).toMatchObject({ tool: "memory_write", approves: true });

    const result = await runDeferredWrite(
      db,
      { runId: call!.runId, tool: call!.tool, args: call!.args },
      { db },
      // The tool under test lives in this file, not in the catalog, so the
      // resolver is handed it directly — the route passes the real catalog.
      async () => remember,
    );
    expect(result.ran).toBe(true);
    // The actual point: the write happened.
    expect(ran).toEqual(["Ferris pays on the 30th."]);
  });

  test("a rule narrowed to deny since it was asked refuses it now", async () => {
    await turnUnderPermissions("Ferris pays on the 30th.");
    const call = readDeferredWrite(db, deferredAction().id)!;

    // You changed your mind between 3am and breakfast.
    grantWorkflowPermission(db, "weather-briefing", { capability: "memory.write", mode: "deny" });

    const result = await runDeferredWrite(
      db,
      { runId: call.runId, tool: call.tool, args: call.args },
      { db },
      async () => remember,
    );
    expect(result).toMatchObject({ ran: false, reason: "denied" });
    expect(ran).toEqual([]);
  });

  test("a tool this build no longer has says so rather than failing silently", async () => {
    await turnUnderPermissions("Ferris pays on the 30th.");
    const call = readDeferredWrite(db, deferredAction().id)!;

    const result = await runDeferredWrite(
      db,
      { runId: call.runId, tool: call.tool, args: call.args },
      { db },
      async () => undefined,
    );
    expect(result).toMatchObject({ ran: false, reason: "unknown_tool" });
    expect(ran).toEqual([]);
  });
});

describe("what the feed reads back once it is answered", () => {
  // The regression this pins: the settled entry's TITLE once held the tool's
  // serialised result. A feed title is one prose line beside a badge and a
  // time, and a payload there has nothing to break on — so it set the feed's
  // min-content width and pushed the aside and the filter chips out of a frame
  // that clips rather than scrolls. The result belongs on the run, as a step.
  const settle = async () => {
    await turnUnderPermissions("Ferris pays on the 30th.");
    const [decision] = openDecisions();
    const action = db
      .select()
      .from(s.actions)
      .where(eq(s.actions.decisionId, decision!.id))
      .all()
      .find((a) => a.stance === "affirm")!;
    const call = readDeferredWrite(db, action.id)!;
    const result = await runDeferredWrite(
      db,
      { runId: call.runId, tool: call.tool, args: call.args },
      { db },
      async () => remember,
    );
    settleDeferredWrite(db, {
      decisionId: call.decisionId,
      actionId: action.id,
      ran: result.ran,
      outcome: result.summary,
      detail: result.detail ?? null,
      tool: call.tool,
      args: call.args,
      durationMs: result.durationMs,
      failed: !result.ran,
    });
    return db.select().from(s.activityItems).where(eq(s.activityItems.decisionId, call.decisionId)).all()[0]!;
  };

  test("the title is a sentence and holds no payload", async () => {
    const entry = await settle();
    expect(entry.title).toBe("memory_write ran and finished.");
    expect(entry.title).not.toContain("{");
    // Short enough to sit on one line beside a badge and a time.
    expect(entry.title.length).toBeLessThan(80);
  });

  test("the payload is on the run as a tool step, which is what reads it", async () => {
    const entry = await settle();
    const step = db.select().from(s.runSteps).where(eq(s.runSteps.runId, entry.runId!)).all().at(-1)!;

    expect(step.toolName).toBe("memory_write");
    expect(step.isTool).toBe(true);
    expect(step.toolResult).toContain("Ferris pays on the 30th.");
    // The strip's one-line aside is the ARGUMENTS, capped — never the result.
    expect(step.detail).toBe("line=Ferris pays on the 30th.");
  });

  test("the feed draws the strip, with no prose account under the title", async () => {
    const entry = await settle();
    const item = loadHome(db).sections.flatMap((section) => section.items).find((i) => i.id === entry.id)!;

    expect(item.title).toBe("memory_write ran and finished.");
    // Nothing lands in the prose slot: a serialised result is not prose, and
    // the two families are the one rule this kit does not bend.
    expect(item.account).toBeNull();
    expect(item.toolSummary).toContain("memory_write");
    expect(item.toolCalls.some((c) => c.name === "memory_write")).toBe(true);
  });
});

describe("answering one twice", () => {
  // The route makes the call BEFORE it records the outcome, on purpose: a crash
  // between the two has to leave a question open over a write that happened
  // rather than a record claiming one that did not. The cost of that ordering
  // is that a replayed actionId would be a second real write unless something
  // checks first, so this is that check — and it is asserted on the world, not
  // on a status code, because a 409 over two reminders would be a lie.
  //
  // A tool from the real catalog rather than this file's stand-in, since the
  // route resolves what it runs through `TOOL_GROUP_CATALOG`.
  const reminderTool = () =>
    remindersGroup({ db }).tools.find((t) => t.definition.function.name === "reminders_create")!;

  const deferAReminder = async () => {
    const agent = new Agent({
      name: "under-test",
      routes: [{
        client: new Scripted([
          {
            finishReason: "tool_calls",
            toolCalls: [{ id: "c1", name: "reminders_create", arguments: { title: "Send the meter reading" } }],
          },
          { content: "done" },
        ]),
        model: "scripted",
      }],
      tools: [reminderTool()],
      promptInjectionScreening: false,
    });
    await withRunPermissions(
      { db, workflowId, runId, slug: "weather-briefing" },
      () => agent.runMessages([{ role: "user", content: "remind me", origin: "operator" }]),
    );
    const [decision] = openDecisions();
    return db
      .select()
      .from(s.actions)
      .where(eq(s.actions.decisionId, decision!.id))
      .all()
      .find((a) => a.stance === "affirm")!;
  };

  const app = () => new Elysia().use(createUiRoutes(() => db));
  const answer = (actionId: string) =>
    app().handle(
      new Request("http://localhost/api/workflows/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId }),
      }),
    );

  const reminderCount = () => db.select().from(s.reminders).all().length;

  test("pressing Write it twice writes once", async () => {
    const action = await deferAReminder();
    expect(reminderCount()).toBe(0);

    const first = await answer(action.id);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ran: true });
    expect(reminderCount()).toBe(1);

    // The same button again — a stale tab, a retried request, a double click
    // slow enough that the first one finished.
    const second = await answer(action.id);
    expect(second.status).toBe(409);
    // The only assertion that matters.
    expect(reminderCount()).toBe(1);
  });

  test("a settled decision is no longer a callable write", async () => {
    const action = await deferAReminder();
    expect(readDeferredWrite(db, action.id)).toMatchObject({ approves: true, open: true });

    await answer(action.id);
    // Not "gone" — the record stays readable, it just cannot be run again.
    expect(readDeferredWrite(db, action.id)).toMatchObject({ approves: true, open: false });
  });

  test("leaving it twice is the same 409, and still nothing written", async () => {
    await deferAReminder();
    const [decision] = openDecisions();
    const leave = db
      .select()
      .from(s.actions)
      .where(eq(s.actions.decisionId, decision!.id))
      .all()
      .find((a) => a.stance === "quiet")!;

    expect((await answer(leave.id)).status).toBe(200);
    expect((await answer(leave.id)).status).toBe(409);
    expect(reminderCount()).toBe(0);
  });
});

describe("a caller that is not a run", () => {
  // `GET /message-extraction`, `GET /screenshots/ingest` and
  // `scripts/catchup-screenshot-ingestion.ts` execute a workflow's body without
  // opening a run. Each was ungated — `currentConsent()` outside a run is
  // undefined, and undefined lets everything through — which made every one of
  // them a way around a standing deny.
  const turnDirectly = (slug = "weather-briefing") =>
    withWorkflowPermissions(db, slug, () =>
      agentFor([write("Ferris pays on the 30th."), { content: "done" }])
        .runMessages([{ role: "user", content: "remember that", origin: "operator" }]),
    );

  test("an allowed capability goes through exactly as it does in a run", async () => {
    grantWorkflowPermission(db, "weather-briefing", { capability: "memory.write", mode: "allow" });
    await turnDirectly();
    expect(ran).toEqual(["Ferris pays on the 30th."]);
  });

  test("a denied one is refused here too, which is the hole this closes", async () => {
    grantWorkflowPermission(db, "weather-briefing", { capability: "memory.write", mode: "deny" });
    await turnDirectly();
    expect(ran).toEqual([]);
  });

  test("ask refuses rather than defers, because there is no run to answer through", async () => {
    // Nothing granted, so `memory.write` falls to the default.
    await turnDirectly();
    expect(ran).toEqual([]);
    // And no question was written, because nothing could carry it: a decision
    // is answered through the run it belonged to, and this had none. The model
    // is told exactly that rather than being left to think one is waiting.
    expect(openDecisions()).toEqual([]);
  });

  test("a slug this database has never synced refuses instead of writing", async () => {
    await turnDirectly("no-such-workflow");
    expect(ran).toEqual([]);
    expect(openDecisions()).toEqual([]);
  });
});

test("a historical deferred Notion action cannot reconnect a retired integration", async () => {
  const result = await runDeferredWrite(db, {
    runId, tool: "notion-create-pages", args: { title: "Historical request" },
  }, { db });
  expect(result).toMatchObject({ ran: false, reason: "unknown_tool" });
  expect(result.summary).toContain("this build has no tool");
});
