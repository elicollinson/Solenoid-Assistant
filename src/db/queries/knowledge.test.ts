// The Things I know surface, checked against a bundle written for the purpose.
//
// The design stores each object's group, its mark, its fact count and its
// "when" as display strings. All four fall out of the file read against the
// tags and the clock here, so what is worth guarding is that the derivation
// lands where the design says — and that the page says only what the file
// supports, since this surface draws a real store rather than fixtures.
import { eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, type Db } from "../index";
import { createUiRoutes } from "../../http/routes/ui";
import { loadKnowledge, loadKnowledgeObject, type KnowledgeDetailPayload, type KnowledgePayload } from "./knowledge";
import { reindexOkf } from "../okf/reindex";
import { seedDesignFixtures } from "../seed/design";
import * as s from "../schema";
import { writeOkfFixture } from "../seed/okfBundle";
import { zonedTime } from "../seed/time";

let dir: string;
let db: Db;
let list: KnowledgePayload;

// The same fixed morning the home, workflow and reminder tests use.
const MORNING = zonedTime(2026, 8, 25, 9, 20);

const row = (name: string) => list.rows.find((r) => r.name.startsWith(name));

const open = (name: string): KnowledgeDetailPayload => {
  const found = row(name);
  if (!found) throw new Error(`no memory starting "${name}"`);
  const one = loadKnowledgeObject(db, found.id, MORNING);
  if (!one) throw new Error(`memory ${found.id} did not load`);
  return one;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-knowledge-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  await reindexOkf(db, { root: writeOkfFixture(join(dir, "okf")), now: MORNING });
  list = loadKnowledge(db, MORNING);
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the list", () => {
  test("holds every memory, newest written first", () => {
    expect(list.rows.map((r) => r.name.slice(0, 24))).toEqual([
      "The orchard gathering — ",
      "The shed roof — two diff",
      "Wren — met through the a",
      "The long walk in May",
      "The old bike lock code",
    ]);
  });

  test("groups by what the memory is about, in the taxonomy's order", () => {
    expect(list.groups).toEqual(["People and contacts", "Money and home", "Plans and dates", "Everything else"]);
    expect(row("The orchard")?.group).toBe("Plans and dates");
    expect(row("Wren")?.group).toBe("People and contacts");
  });

  test("counts only what is field-shaped, so a prose memory says none", () => {
    expect(row("The orchard")?.facts).toBe(4);
    expect(row("The long walk")?.facts).toBe(0);
  });

  test("marks the one holding two answers, and nothing else", () => {
    expect(list.rows.filter((r) => r.state === "attention").map((r) => r.name.slice(0, 13))).toEqual(["The shed roof"]);
  });

  test("a deprecated memory is closed rather than quiet", () => {
    expect(row("The old bike lock")?.state).toBe("done");
  });

  test("staleness is read against the clock, not stored", () => {
    // The shed roof said review by Aug 20 and it is the 25th.
    expect(row("The shed roof")?.stale).toBe(true);
    expect(row("The orchard")?.stale).toBe(false);
  });

  test("the when is the day the memory was last written", () => {
    expect(row("The orchard")?.when).toBe("Aug 14");
    expect(row("The shed roof")?.when).toBe("Aug 9");
  });

  test("the uri is what a citation from anywhere else would name", () => {
    expect(row("Wren")?.uri).toBe("okf:memories/wren-and-how-you-know-her");
  });

  test("the lede counts the store rather than describing it", () => {
    expect(list.lede).toBe(
      "Five things I've written down about you and your life, and eight discrete facts pulled out of them. " +
        "One of them holds two answers to the same question and I haven't picked between them. " +
        "One is past the date I said I'd check it again.",
    );
  });

  test("the lede moves with the clock", () => {
    // By December the orchard and Wren have joined the shed roof in going
    // unchecked, and the line says so without anything being rewritten.
    expect(list.lede).toContain("One is past the date I said I'd check it again.");
    const later = loadKnowledge(db, zonedTime(2026, 12, 5, 9, 20));
    expect(later.lede).toContain("Three are past the date I said I'd check them again.");
  });

  test("every filter counts the rows it would show", () => {
    for (const filter of list.filters) {
      const shown = filter.group === null ? list.rows : list.rows.filter((r) => r.group === filter.group);
      expect(filter.count).toBe(shown.length);
    }
    expect(list.filters[0]).toEqual({ label: "All", group: null, count: 5 });
  });
});

describe("one memory", () => {
  test("says how it came to be from the file rather than from invention", () => {
    expect(open("The orchard").account).toEqual([
      "I wrote this one on Jul 30, 2026, and rewrote it one time since.",
      "It rests on one source: You told me over dinner — you.",
      "I'll check this again by Nov 1.",
    ]);
  });

  test("says plainly when it is past its own review date", () => {
    expect(open("The shed roof").account[2]).toBe(
      "I said I'd look at this again by Aug 20 and that date has passed, so treat it as something I haven't checked lately.",
    );
  });

  test("carries the facts with whose claim each one is", () => {
    expect(open("The orchard").fields.map((f) => [f.label, f.value, f.provenance])).toEqual([
      ["Date", "September 12", "you told me"],
      ["Host", "Wren", "you told me"],
      ["Bringing", "the long table", "you told me"],
      ["Rain plan", "none agreed", "you told me"],
    ]);
  });

  test("someone else's account is filed as a record I read, with them named", () => {
    const shed = open("The shed roof");
    expect(shed.fields[0]?.provenance).toBe("read from a record");
    expect(shed.fields[0]?.source).toBe("tobin ashgrove");
  });

  test("explains the conflict and flags both sides of it", () => {
    const shed = open("The shed roof");
    expect(shed.conflict).toBe(
      'This memory states "quote" more than once, with different answers each time. ' +
        "I kept both rather than overwriting one, because overwriting would have hidden the change from you.",
    );
    expect(shed.fields.filter((f) => f.conflict).map((f) => f.value)).toEqual([
      "£1,240, ridge and felt",
      "£980, felt only",
    ]);
  });

  test("a memory with nothing to settle offers no conflict", () => {
    expect(open("The long walk").conflict).toBeNull();
  });

  test("gives the prose for a memory that holds no fields", () => {
    const walk = open("The long walk");
    expect(walk.fields).toEqual([]);
    expect(walk.sections).toEqual([
      { heading: "Memory", paragraphs: ["You walked the ridge in May with Wren and said afterwards that you wanted to make it a yearly thing."] },
      { heading: "Context", paragraphs: ["Nothing has been arranged for next year."] },
    ]);
  });

  test("the trail is the bundle's log, newest first", () => {
    expect(open("The orchard").trail).toEqual([
      { t: "Aug 14, 2026", kind: "Update", text: "Updated The orchard gathering — Sept 12, at Wren's, bring the long table" },
      { t: "Jul 30, 2026", kind: "Creation", text: "Established The orchard gathering — Sept 12, at Wren's, bring the long table" },
    ]);
  });

  test("what links here counts inbound mentions, wherever in the file they were", () => {
    const wren = open("Wren");
    expect(wren.refs.map((r) => r.label.slice(0, 21)).sort()).toEqual([
      "The long walk in May",
      "The orchard gathering",
    ]);
  });

  test("a memory nothing mentions has no backlinks rather than an empty flourish", () => {
    expect(open("The old bike lock").refs).toEqual([]);
  });

  test("sources are listed as descriptors, since there is no artifact to open", () => {
    expect(open("Wren").sources).toEqual([{ title: "Committee minutes, March", who: "allotment committee minutes" }]);
  });

  test("the meta pairs read off the file and the log", () => {
    expect(open("The orchard").meta).toEqual([
      { label: "Kind", value: "plan" },
      { label: "Revision", value: "rev 2" },
      { label: "Opened", value: "Jul 30, 2026" },
      { label: "Last written", value: "Aug 14" },
      { label: "Review by", value: "Nov 1" },
      { label: "Status", value: "stable" },
    ]);
  });

  test("names the file it came from, because the file is the source of truth", () => {
    expect(open("The orchard").path).toBe("okf/memories/gathering-at-the-orchard.md");
  });
});

describe("over http", () => {
  const app = () => new Elysia().use(createUiRoutes(() => db));

  test("GET /api/knowledge answers with the store", async () => {
    const response = await app().handle(new Request("http://localhost/api/knowledge"));
    expect(response.status).toBe(200);
    expect(((await response.json()) as KnowledgePayload).rows.length).toBe(5);
  });

  test("GET /api/knowledge/:id answers with one memory", async () => {
    const id = list.rows[0]?.id ?? "";
    const response = await app().handle(new Request(`http://localhost/api/knowledge/${id}`));
    expect(response.status).toBe(200);
    expect(((await response.json()) as KnowledgeDetailPayload).id).toBe(id);
  });

  test("an id that is not a memory is a 404, not an empty page", async () => {
    const response = await app().handle(new Request("http://localhost/api/knowledge/okfo_nothing"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "No memory with id okfo_nothing" });
  });
});

describe("the seed leaves the store alone", () => {
  // The design fixtures and the OKF projection share one `entities` table, and
  // an unqualified wipe of it cascades through okf_objects and okf_fields.
  // `okf/` on disk survives that, so nothing looks wrong until this screen is
  // opened and reads empty — which is exactly how it went unnoticed once.
  let seeded: Db;
  let seededDir: string;
  let after: KnowledgePayload;

  beforeAll(async () => {
    seededDir = mkdtempSync(join(tmpdir(), "solenoid-seed-okf-"));
    seeded = createDb(join(seededDir, "test.db"));
    runMigrations(seeded);
    await reindexOkf(seeded, { root: writeOkfFixture(join(seededDir, "okf")), now: MORNING });
    seedDesignFixtures(seeded, { now: MORNING });
    seedDesignFixtures(seeded, { now: MORNING }); // and again: the seed is idempotent
    after = loadKnowledge(seeded, MORNING);
  });

  afterAll(() => {
    seeded.$client.close();
    rmSync(seededDir, { recursive: true, force: true });
  });

  test("every memory is still there afterwards", () => {
    expect(after.rows.length).toBe(list.rows.length);
    expect(after.rows.map((r) => r.uri)).toEqual(list.rows.map((r) => r.uri));
  });

  test("and so are the facts pulled out of them", () => {
    expect(after.lede).toBe(list.lede);
  });

  test("the chronology behind each memory survives too", () => {
    const events = seeded
      .select()
      .from(s.subjectEvents)
      .where(eq(s.subjectEvents.eventKind, "okf_log"))
      .all();
    expect(events.length).toBeGreaterThan(0);
  });

  test("a backlink between two memories is an edge the seed does not own", () => {
    const okf = new Set(
      seeded
        .select({ id: s.entities.id })
        .from(s.entities)
        .where(inArray(s.entities.kind, [...s.OKF_ENTITY_KIND]))
        .all()
        .map((r) => r.id),
    );
    const kept = seeded.select().from(s.links).all().filter((l) => okf.has(l.fromId) && okf.has(l.toId));
    expect(kept.length).toBeGreaterThan(0);
  });

  test("the seed still wrote its own rows", () => {
    const workflows = seeded.select().from(s.workflows).all();
    expect(workflows.length).toBe(8);
  });
});
