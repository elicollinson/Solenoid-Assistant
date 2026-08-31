// The Contacts group, exercised the way an agent reaches it.
//
// `lookup_contact` is never executed here. It reads the real macOS address book
// through a process-wide trust gate that throws when Full Disk Access is
// missing, so executing it would make this suite depend on whose laptop it runs
// on — the same line ./imessage.test.ts draws around the Messages database.
// What is asserted about it is its enforcement surface: that it is a read, that
// it takes one parameter, and that its description says what it is not.
//
// Everything else runs against a temporary database, because the interesting
// half of this group is the trust state on a stored participant rather than the
// address book.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolBelt, loaderName, readOnly, renderBriefing } from "../core/toolGroups";
import type { AgentTool } from "../core/tools";
import { createDb, runMigrations, ulid, type Db } from "../db";
import * as s from "../db/schema";
import { contactsGroup, createContactTools, lookupContactTool, type ContactTools } from "./contacts";

let dir: string;
let db: Db;
let tools: ContactTools;

/** Exercise a tool the way Agent.invokeTool does: validate at the boundary,
 *  then run. A refusal from the schema reaches the caller, as it would there. */
async function call(tool: AgentTool, args: unknown): Promise<unknown> {
  return tool.execute(tool.schema.parse(args));
}

/** A participant needs its entity row first — the supertype is a real foreign
 *  key and PRAGMA foreign_keys is on. */
function participant(
  displayName: string,
  trustState: (typeof s.TRUST_STATE)[number],
  handles: readonly { kind: (typeof s.HANDLE_KIND)[number]; value: string }[] = [],
  kind: (typeof s.PARTICIPANT_KIND)[number] = "person",
): string {
  const id = ulid();
  const now = new Date("2026-08-01T00:00:00.000Z");
  db.insert(s.entities).values({ id, kind: "participant", createdAt: now, updatedAt: now }).run();
  db.insert(s.participants).values({ id, kind, displayName, trustState, createdAt: now }).run();
  for (const handle of handles) {
    db.insert(s.participantHandles)
      .values({ id: ulid(), participantId: id, kind: handle.kind, value: handle.value, isPrimary: true })
      .run();
  }
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "contact-tools-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  tools = createContactTools(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the group", () => {
  test("is well formed, and its loader is the one the belt would mint", () => {
    const group = contactsGroup({ db });
    expect(group.name).toBe("contacts");
    expect(group.shape.singular).toBe("participant");
    expect(loaderName(group.name)).toBe("get_contacts_tools");
    expect(group.summary.trim().length).toBeGreaterThan(0);
    expect(group.purpose.trim().length).toBeGreaterThan(0);
  });

  test("hands over three tools, every one of them a read", () => {
    const group = contactsGroup({ db });
    expect(group.tools.map((t) => t.definition.function.name)).toEqual([
      "contacts_list",
      "contacts_read",
      "lookup_contact",
    ]);
    expect(group.tools.every((t) => t.kind === "read")).toBe(true);
    // Nothing in this group may change a trust state, so there is no write to
    // classify. If one is ever added, this is the test that should fail first.
    expect(group.tools.filter((t) => t.kind === "write")).toEqual([]);
  });

  test("every tool says enough for a model to choose it", () => {
    for (const tool of contactsGroup({ db }).tools) {
      const params = tool.definition.function.parameters as { type?: string; properties?: object };
      expect(params.type).toBe("object");
      expect(Object.keys(params.properties ?? {}).length).toBeGreaterThan(0);
      expect(tool.definition.function.description.length).toBeGreaterThan(200);
      // A description that only restates the name teaches nothing.
      expect(tool.definition.function.description).not.toBe(tool.definition.function.name);
    }
  });

  test("readOnly is the identity here, because there is nothing to drop", () => {
    const group = contactsGroup({ db });
    const restricted = readOnly(group);
    expect(restricted).toBe(group);
    expect(restricted.tools.map((t) => t.definition.function.name)).toEqual(
      group.tools.map((t) => t.definition.function.name),
    );
  });

  test("the briefing names both sources and keeps them apart", () => {
    const briefing = renderBriefing(contactsGroup({ db }));
    expect(briefing).toContain("# Contacts");
    expect(briefing).toContain("trustState");
    // The stored record and the address book, each said to be what it is.
    expect(briefing).toContain("Handles — one row per address they are reachable at");
    expect(briefing).toContain("macOS address book");
    expect(briefing).toContain("not a row in this database");
    for (const state of s.TRUST_STATE) expect(briefing).toContain(state);
    // Read-only group: the briefing must not offer a writing section.
    expect(briefing).not.toContain("Writing —");
  });

  test("the briefing is a function of the code, not of the rows", () => {
    const before = renderBriefing(contactsGroup({ db }));
    participant("Marta Reyes", "trusted", [{ kind: "phone", value: "+19375551234" }]);
    expect(renderBriefing(contactsGroup({ db }))).toBe(before);
  });

  test("a belt takes it, and its tools are unreachable until the loader runs", () => {
    const belt = new ToolBelt([contactsGroup({ db })]);
    expect(belt.names).toEqual(["contacts"]);
    expect(belt.claims("contacts_read")).toBe(true);

    const session = belt.session();
    expect(session.resolve("contacts_read")).toBeUndefined();
    expect(session.unopenedOwnerOf("contacts_read")).toBe("contacts");
    session.resolve("get_contacts_tools")!.execute({});
    expect(session.opened).toEqual(["contacts"]);
    expect(session.resolve("contacts_read")).toBeDefined();
  });
});

describe("lookup_contact", () => {
  // Construction only: execute() reads the real address book (see the header).
  test("is the same tool under the same name it has always had", () => {
    expect(lookupContactTool.definition.function.name).toBe("lookup_contact");
    expect(tools.lookup).toBe(lookupContactTool);
    expect(lookupContactTool.kind).toBe("read");
  });

  test("takes a handle and nothing else, in any format", () => {
    const properties = (lookupContactTool.definition.function.parameters as {
      properties: Record<string, unknown>;
    }).properties;
    expect(Object.keys(properties)).toEqual(["handle"]);
    expect(() => lookupContactTool.schema.parse({ handle: "" })).toThrow();
    expect(lookupContactTool.schema.parse({ handle: "(937) 555-1234" })).toEqual({ handle: "(937) 555-1234" });
  });

  test("its description says a hit is not a stored record", () => {
    expect(lookupContactTool.definition.function.description).toContain("contacts_read");
    expect(lookupContactTool.definition.function.description).toContain("stores nothing");
  });
});

describe("contacts_list", () => {
  test("lists the people this app knows, with their trust state and handles", async () => {
    participant("Marta Reyes", "trusted", [{ kind: "phone", value: "+19375551234" }]);
    participant("Unknown Caller", "unknown", [{ kind: "phone", value: "+19375559999" }]);

    const listed = (await call(tools.list, {})) as {
      count: number;
      truncated: boolean;
      rows: { displayName: string; trustState: string; handles: { value: string }[] }[];
    };
    expect(listed.count).toBe(2);
    expect(listed.truncated).toBe(false);
    expect(listed.rows.map((r) => r.displayName)).toEqual(["Marta Reyes", "Unknown Caller"]);
    expect(listed.rows[0]?.handles.map((h) => h.value)).toEqual(["+19375551234"]);
  });

  test("filters by trust state, which is the question worth asking", async () => {
    participant("Marta Reyes", "trusted");
    participant("Unknown Caller", "unknown");
    participant("A Blocked Number", "blocked");

    const unknown = (await call(tools.list, { trust: "unknown" })) as { count: number };
    const blocked = (await call(tools.list, { trust: "blocked" })) as {
      rows: { displayName: string }[];
    };
    expect(unknown.count).toBe(1);
    expect(blocked.rows[0]?.displayName).toBe("A Blocked Number");
    expect(() => tools.list.schema.parse({ trust: "friendly" })).toThrow();
  });

  test("filters by kind, so the user and the agent can be left out", async () => {
    participant("You", "trusted", [], "self");
    participant("Marta Reyes", "known");
    const people = (await call(tools.list, { kind: "person" })) as { rows: { displayName: string }[] };
    expect(people.rows.map((r) => r.displayName)).toEqual(["Marta Reyes"]);
  });

  test("is capped, and says when it truncated rather than lying by omission", async () => {
    for (let i = 0; i < 3; i++) participant(`Person ${i}`, "known");
    expect(tools.list.schema.parse({})).toMatchObject({ limit: 50 });
    expect(() => tools.list.schema.parse({ limit: 500 })).toThrow();

    const capped = (await call(tools.list, { limit: 2 })) as { count: number; truncated: boolean };
    expect(capped.count).toBe(2);
    expect(capped.truncated).toBe(true);
  });
});

describe("contacts_read", () => {
  test("needs exactly one of id and handle", () => {
    expect(() => tools.read.schema.parse({})).toThrow();
    expect(() => tools.read.schema.parse({ id: "x", handle: "+19375551234" })).toThrow();
    expect(tools.read.schema.parse({ id: "x" })).toMatchObject({ id: "x" });
  });

  test("reads one participant with every handle and its trust state", async () => {
    const id = participant("Marta Reyes", "trusted", [
      { kind: "phone", value: "+19375551234" },
      { kind: "email", value: "marta@example.com" },
    ]);
    const read = (await call(tools.read, { id })) as {
      found: boolean;
      trustState: string;
      handles: { kind: string; value: string }[];
    };
    expect(read.found).toBe(true);
    expect(read.trustState).toBe("trusted");
    expect(read.handles.map((h) => h.value).sort()).toEqual(["+19375551234", "marta@example.com"]);
  });

  test("normalises a handle before matching, so any format finds its person", async () => {
    participant("Marta Reyes", "trusted", [{ kind: "phone", value: "+19375551234" }]);
    for (const written of ["+19375551234", "(937) 555-1234", "937-555-1234"]) {
      expect(await call(tools.read, { handle: written })).toMatchObject({
        found: true,
        displayName: "Marta Reyes",
        matchedOn: "exact",
      });
    }
  });

  test("falls back to the last ten digits when the country code disagrees", async () => {
    participant("Marta Reyes", "trusted", [{ kind: "phone", value: "+449375551234" }]);
    expect(await call(tools.read, { handle: "+19375551234" })).toMatchObject({
      found: true,
      matchedOn: "last_ten_digits",
      matchedHandle: "+449375551234",
    });
  });

  test("lowercases an email the way the column stores it", async () => {
    participant("Marta Reyes", "known", [{ kind: "email", value: "marta@example.com" }]);
    expect(await call(tools.read, { handle: "Marta@Example.COM" })).toMatchObject({
      found: true,
      trustState: "known",
    });
  });

  test("a handle nobody has seen answers unknown, and invents no record", async () => {
    const miss = (await call(tools.read, { handle: "+19375550000" })) as {
      found: boolean;
      trustState: string;
      tried: string[];
    };
    expect(miss.found).toBe(false);
    expect(miss.trustState).toBe("unknown");
    expect(miss.tried).toContain("+19375550000");
    // Nothing was written on the way past — the miss is the whole answer.
    expect(db.select().from(s.participants).all()).toEqual([]);
  });

  test("an id that names nothing says so rather than throwing at the model", async () => {
    expect(await call(tools.read, { id: "nope" })).toMatchObject({
      found: false,
      error: "No participant with id nope",
    });
  });

  test("a short code cannot borrow somebody else's identity", async () => {
    participant("Marta Reyes", "trusted", [{ kind: "phone", value: "+19375551234" }]);
    // Too few digits for a last-ten key, so there is no loose match to make.
    expect(await call(tools.read, { handle: "51234" })).toMatchObject({ found: false, trustState: "unknown" });
  });
});
