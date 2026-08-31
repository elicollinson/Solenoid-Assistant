// The calendar group, exercised the way an agent reaches it.
//
// Two things are worth guarding here and neither is a write — ../db/mutations/
// calendar.test.ts already checks what each write does to the four tables.
// The first is the group itself: that it is well formed, that every tool is
// classified by what it actually does, and that the read-only form an agent
// holding a stranger's text would be given contains exactly the reads. The
// second is the boundary: that the schemas refuse what they should and that
// what each tool hands back is something the next call can use.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOnly, renderBriefing, type ToolGroup } from "../core/toolGroups";
import type { AgentTool } from "../core/tools";
import { createDb, runMigrations, ulid, type Db } from "../db";
import * as s from "../db/schema";
import { zonedTime } from "../db/seed/time";
import { calendarGroup } from "./calendar";

let dir: string;
let db: Db;
let group: ToolGroup;

const at = (day: number, hour: number, minute = 0) => zonedTime(2026, 8, day, hour, minute).toISOString();

/**
 * Exercise a tool the way Agent.invokeTool does: validate at the boundary, then
 * run. Async so a refusal thrown synchronously reaches the caller as the
 * rejection an agent loop would actually see, and loosely typed because these
 * are model-facing payloads — casting each one back into a type would only be
 * restating the assertion underneath it.
 */
async function call(name: string, args: unknown): Promise<any> {
  const tool = group.tools.find((t) => t.definition.function.name === name);
  if (!tool) throw new Error(`no tool called ${name}`);
  return tool.execute(tool.schema.parse(args));
}

const kinds = () =>
  Object.fromEntries(group.tools.map((t: AgentTool) => [t.definition.function.name, t.kind]));

function participant(displayName: string): string {
  const id = ulid();
  const now = new Date();
  db.insert(s.entities).values({ id, kind: "participant", createdAt: now, updatedAt: now }).run();
  db.insert(s.participants).values({ id, kind: "person", displayName, createdAt: now }).run();
  return id;
}

const create = (over: Record<string, unknown> = {}) =>
  call("calendar_create", { title: "Latham review", startsAt: at(25, 14), endsAt: at(25, 15), ...over });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "calendar-tools-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  group = calendarGroup({ db });
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the group", () => {
  test("is one loadable group with the seven tools, each classified by what it does", () => {
    expect(group.name).toBe("calendar");
    expect(group.shape.singular).toBe("calendar item");
    expect(kinds()).toEqual({
      calendar_list: "read",
      calendar_read: "read",
      calendar_create: "write",
      calendar_reschedule: "write",
      calendar_cancel: "write",
      calendar_set_attendees: "write",
      calendar_hold: "write",
    });
  });

  test("is one idea spread over four tables, each named as an agent would ask for it", () => {
    expect(group.shape.related?.map((r) => r.label)).toEqual([
      "How often it comes round",
      "Who is coming",
      "The offer behind a held slot",
    ]);
    // The spine is the item's own columns, read off the table rather than
    // listed here, so a column added to it cannot go undocumented.
    const spine = group.shape.spine.map((f) => f.name);
    expect(spine).toContain("startsAt");
    expect(spine).toContain("status");
    // The projection links and the sync bookkeeping are hidden: nothing in this
    // group writes them and no agent has to know they are there.
    expect(spine).not.toContain("sourceId");
    expect(spine).not.toContain("etag");
  });

  test("the read-only form is exactly the two tools that change nothing", () => {
    expect(readOnly(group).tools.map((t) => t.definition.function.name)).toEqual([
      "calendar_list",
      "calendar_read",
    ]);
  });

  test("the briefing renders from the tools themselves, and says the same thing twice running", () => {
    const briefing = renderBriefing(group);
    for (const tool of group.tools) expect(briefing).toContain(tool.definition.function.name);
    expect(briefing).toContain("Who is coming");
    expect(briefing).toBe(renderBriefing(calendarGroup({ db })));
  });
});

describe("reading the week", () => {
  test("answers with the window it used and what overlaps it", async () => {
    const { id } = await create();
    const week = await call("calendar_list", { from: at(25, 0), to: at(26, 0) });

    expect(week.from).toBe(at(25, 0));
    expect(week.count).toBe(1);
    expect(week.items[0].id).toBe(id);
    // Both readings of the span, because the agent reasons in one and speaks
    // in the other.
    expect(week.items[0].startsAt).toBe(at(25, 14));
    expect(week.items[0].local).toBe("Tue 25 Aug 14:00 – 15:00");
  });

  test("a meeting already running when the window opens is on it", async () => {
    await create({ startsAt: at(25, 9), endsAt: at(25, 17) });
    expect((await call("calendar_list", { from: at(25, 12), to: at(25, 13) })).count).toBe(1);
  });

  test("cancelled ones are left out until they are asked for", async () => {
    const { id } = await create();
    await call("calendar_cancel", { id, because: "They are away" });

    expect((await call("calendar_list", { from: at(25, 0), to: at(26, 0) })).count).toBe(0);
    const shown = await call("calendar_list", { from: at(25, 0), to: at(26, 0), includeCancelled: true });
    expect(shown.items.map((i: { id: string; status: string }) => [i.id, i.status])).toEqual([[id, "cancelled"]]);
  });

  test("reads one in full, with who is coming and how often it comes round", async () => {
    const marta = participant("Marta Reyes");
    const { id } = await create({
      attendees: [{ participantId: marta, response: "accepted", isExternal: true }],
      repeats: { rrule: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=14;BYMINUTE=0" },
      account: ["They asked for the morning back in July."],
    });

    const one = await call("calendar_read", { id });
    expect(one.title).toBe("Latham review");
    expect(one.repeats.rrule).toBe("FREQ=WEEKLY;BYDAY=TU;BYHOUR=14;BYMINUTE=0");
    // The name is joined on read so the agent can see who it is looking at,
    // even though it writes attendees by id.
    expect(one.attendees).toEqual([
      { participantId: marta, name: "Marta Reyes", response: "accepted", optional: false, isExternal: true },
    ]);
    expect(one.account).toEqual(["They asked for the morning back in July."]);
    expect(one.hold).toBeNull();
  });

  test("an id this table does not hold is answered, not thrown", async () => {
    const answer = await call("calendar_read", { id: "run-01" });
    expect(answer.error).toContain("run-01");
  });
});

describe("changing the week", () => {
  test("moving one keeps its length and says where it came from", async () => {
    const { id } = await create();
    await call("calendar_reschedule", { id, startsAt: at(27, 8), because: "Latham asked for the morning" });

    const one = await call("calendar_read", { id });
    expect(one.startsAt).toBe(at(27, 8));
    expect(one.endsAt).toBe(at(27, 9));
    expect(one.movedFrom.because).toBe("Latham asked for the morning");
    expect(one.movedFrom.by).toBe("agent");
  });

  test("setting who is coming replaces the whole list", async () => {
    const marta = participant("Marta Reyes");
    const fenwick = participant("Fenwick");
    const { id } = await create({ attendees: [{ participantId: marta }] });

    const answer = await call("calendar_set_attendees", { id, attendees: [{ participantId: fenwick }] });
    expect(answer).toEqual({ id, attendees: 1 });
    expect((await call("calendar_read", { id })).attendees.map((a: { name: string }) => a.name)).toEqual(["Fenwick"]);
  });

  test("held time is offered as one question with two answers", async () => {
    const fenwick = participant("Fenwick");
    const offer = await call("calendar_hold", {
      title: "Boiler service",
      offeredById: fenwick,
      windows: [
        { startsAt: at(27, 8), endsAt: at(27, 11) },
        { startsAt: at(28, 13), endsAt: at(28, 16), clashNote: "runs into the standup" },
      ],
    });

    expect(offer.ids).toHaveLength(2);
    const held = await call("calendar_read", { id: offer.ids[1] });
    expect(held.kind).toBe("hold");
    expect(held.status).toBe("tentative");
    expect(held.hold.holdGroupId).toBe(offer.holdGroupId);
    expect(held.hold.clashNote).toBe("runs into the standup");

    // Taking one is releasing the other, and the holds table is where that is
    // recorded rather than in the row's disappearance.
    await call("calendar_cancel", { id: offer.ids[1], because: "You took the Thursday" });
    expect((await call("calendar_read", { id: offer.ids[1] })).hold.releasedAt).not.toBeNull();
    expect((await call("calendar_read", { id: offer.ids[0] })).hold.releasedAt).toBeNull();
  });
});

describe("the boundary", () => {
  test("a wall clock with no zone is refused, because it does not say which moment it means", () => {
    expect(create({ startsAt: "2026-08-25T14:00:00" })).rejects.toThrow();
  });

  test("a nameless item and an attendee with no id never reach the database", () => {
    expect(create({ title: "" })).rejects.toThrow();
    expect(create({ attendees: [{ response: "accepted" }] })).rejects.toThrow();
  });

  test("the refusals the mutations make reach the caller as rejections", async () => {
    const { id } = await create();
    await call("calendar_cancel", { id });
    expect(call("calendar_reschedule", { id, startsAt: at(27, 8) })).rejects.toThrow(/cancelled/);
  });
});
