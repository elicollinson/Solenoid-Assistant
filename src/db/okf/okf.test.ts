// The projection, checked against a bundle written for the purpose.
//
// Never against okf/: the real store is personal and gitignored, so a test that
// read it would fail on any machine but this one and leak contacts into CI logs
// on this one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, okfObjectId, runMigrations, type Db } from "../index";
import * as s from "../schema";
import { and, eq } from "drizzle-orm";
import { writeOkfFixture } from "../seed/okfBundle";
import { reindexOkf, uriFor, provenanceOf, relatedConcepts, sourceEntries } from "./reindex";
import { conflictGroups, extractFields, plain, readableSections } from "./fields";
import { chronologyByConcept, dayInstant, parseLog } from "./chronology";
import { shelfFor } from "./classify";

let dir: string;
let root: string;
let db: Db;

const idOf = (concept: string) => okfObjectId(uriFor(`memories/${concept}`));
const objectFor = (concept: string) =>
  db.select().from(s.okfObjects).where(eq(s.okfObjects.id, idOf(concept))).get();
const fieldsFor = (concept: string) =>
  db
    .select()
    .from(s.okfFields)
    .where(eq(s.okfFields.objectId, idOf(concept)))
    .orderBy(s.okfFields.ordinal)
    .all();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-okf-"));
  root = writeOkfFixture(join(dir, "okf"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  await reindexOkf(db, { root, now: new Date("2026-08-25T13:20:00Z") });
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("reading a memory apart", () => {
  test("pulls out the facts that are field-shaped and claims nothing else", () => {
    const fields = extractFields(`## Details

- **Date:** September 12
- **Host:** Wren

Wren offered the orchard before anyone asked.
`);
    expect(fields.map((f) => [f.label, f.value, f.section])).toEqual([
      ["Date", "September 12", "Details"],
      ["Host", "Wren", "Details"],
    ]);
  });

  test("leaves prose alone rather than inventing fields from it", () => {
    expect(extractFields("You walked the ridge in May and said you wanted to do it yearly.")).toEqual([]);
  });

  test("reads all four ways this bundle writes an assertion", () => {
    const fields = extractFields([
      "- **Colon inside:** one",
      "- **Colon outside**: two",
      "- **Dashed** — three",
      "**Bare:** four",
    ].join("\n"));
    expect(fields.map((f) => f.value)).toEqual(["one", "two", "three", "four"]);
  });

  test("a bolded run mid-sentence is emphasis, not a field", () => {
    expect(extractFields("The lock went with the **bike**: kept for the record.")).toEqual([]);
  });

  test("skips the Related block, which is the link graph rather than a fact", () => {
    const fields = extractFields("## Related\n\n- **Wren:** [her page](/memories/wren.md)\n");
    expect(fields).toEqual([]);
  });

  test("flattens links and emphasis so a value can sit in a table cell", () => {
    expect(plain("see [Wren](/memories/wren.md) and **the shed**")).toBe("see Wren and the shed");
  });

  test("offsets point back at the line, so a write could patch in place", () => {
    const body = "## Details\n\n- **Date:** September 12\n";
    const [field] = extractFields(body);
    expect(body.slice(field?.start, field?.end)).toBe("- **Date:** September 12");
  });
});

describe("two answers to one question", () => {
  test("a label said twice with different answers is a conflict", () => {
    const fields = extractFields("- **Quote:** £1,240\n- **Quote:** £980\n");
    expect(conflictGroups(fields)).toEqual(["quote", "quote"]);
  });

  test("a label said twice with the same answer is a repeat, not a conflict", () => {
    const fields = extractFields("- **Quote:** £980\n- **Quote:** £980\n");
    expect(conflictGroups(fields)).toEqual([null, null]);
  });

  test("the shed roof is the one the fixture holds", () => {
    const conflicts = db.select().from(s.okfConflicts).all();
    expect(conflicts.map((c) => c.label)).toEqual(["quote"]);
    expect(conflicts[0]?.objectId).toBe(idOf("the-shed-roof"));
  });

  test("both values are kept, neither superseding the other", () => {
    const quotes = fieldsFor("the-shed-roof").filter((f) => f.label === "Quote");
    expect(quotes.map((q) => q.value)).toEqual(["£1,240, ridge and felt", "£980, felt only"]);
    expect(quotes.every((q) => q.supersededById === null && q.retiredAt === null)).toBe(true);
  });
});

describe("the body, for the memories that hold no fields", () => {
  test("comes back as headed sections with the Related block dropped", () => {
    const sections = readableSections(`## Memory

You walked the ridge in May.

## Related

- [Wren](/memories/wren.md)
`);
    expect(sections).toEqual([{ heading: "Memory", paragraphs: ["You walked the ridge in May."] }]);
  });

  test("keeps a bullet as its own paragraph rather than running the list together", () => {
    const [section] = readableSections("## Notes\n\n- first\n- second\n");
    expect(section?.paragraphs).toEqual(["first", "second"]);
  });
});

describe("the bundle log", () => {
  test("reads the date, the kind and the concept each entry names", () => {
    const entries = parseLog(`# Bundle Update Log

## 2026-08-14
* **Update**: Updated [The orchard gathering](/memories/gathering-at-the-orchard.md).
`);
    expect(entries).toEqual([
      {
        date: "2026-08-14",
        kind: "Update",
        message: "Updated The orchard gathering",
        targets: ["memories/gathering-at-the-orchard"],
      },
    ]);
  });

  test("ignores a line that is not under a date", () => {
    expect(parseLog("* **Creation**: Established [x](/memories/x.md).")).toEqual([]);
  });

  test("a calendar day becomes an instant that renders as that same day", () => {
    // Midnight UTC is the evening before in America/New_York, which would draw
    // every entry a day early.
    expect(dayInstant("2026-08-14").toISOString()).toBe("2026-08-14T12:00:00.000Z");
  });

  test("groups by concept, newest first, with the ends of the trail found", () => {
    const byConcept = chronologyByConcept(parseLog(`## 2026-08-14
* **Update**: Updated [a](/memories/a.md).

## 2026-07-30
* **Creation**: Established [a](/memories/a.md).
`));
    const trail = byConcept.get("memories/a");
    expect(trail?.entries.length).toBe(2);
    expect(trail?.first.date).toBe("2026-07-30");
    expect(trail?.last.date).toBe("2026-08-14");
  });

  test("the revision count is the length of the trail, and Opened is its start", () => {
    const object = objectFor("gathering-at-the-orchard");
    expect(object?.rev).toBe(2);
    expect(object?.createdAt.toISOString()).toBe("2026-07-30T12:00:00.000Z");
    expect(object?.updatedAt.toISOString()).toBe("2026-08-14T12:00:00.000Z");
  });

  test("a memory the log never named is revision one", () => {
    // Every fixture is logged, so assert the fallback where it is decided.
    const byConcept = chronologyByConcept(parseLog(""));
    expect(byConcept.size).toBe(0);
  });

  test("the trail is stored under the object it belongs to", () => {
    const trail = db
      .select()
      .from(s.subjectEvents)
      .where(and(eq(s.subjectEvents.subjectId, idOf("gathering-at-the-orchard")), eq(s.subjectEvents.eventKind, "okf_log")))
      .all();
    expect(trail.length).toBe(2);
  });
});

describe("which shelf a memory sits on", () => {
  test("first match wins, so the taxonomy is the order", () => {
    expect(shelfFor(["personal", "contacts"]).group).toBe("People and contacts");
    expect(shelfFor(["personal", "career", "contacts"]).group).toBe("People and contacts");
    expect(shelfFor(["personal", "career"]).group).toBe("Work and career");
  });

  test("a tag set the rules do not claim falls through rather than being guessed at", () => {
    expect(shelfFor(["kite-flying"]).group).toBe("Everything else");
  });

  test("the fixture lands where the tags say", () => {
    expect(objectFor("gathering-at-the-orchard")?.groupLabel).toBe("Plans and dates");
    expect(objectFor("wren-and-how-you-know-her")?.groupLabel).toBe("People and contacts");
    expect(objectFor("the-shed-roof")?.groupLabel).toBe("Money and home");
  });
});

describe("whose claim a fact is", () => {
  test("you telling me is yours", () => {
    expect(provenanceOf([{ resource: null, title: null, author: "human:user" }])).toBe("user");
  });

  test("someone else's account reached me as a record I read", () => {
    expect(provenanceOf([{ resource: null, title: null, author: "human:tobin-ashgrove" }])).toBe("document");
  });

  test("no author at all means I put it together myself", () => {
    expect(provenanceOf([{ resource: "notes", title: "Notes", author: null }])).toBe("agent_inferred");
  });

  test("a single mapping is read as a one-element list, as the spec says", () => {
    expect(sourceEntries({ sources: { resource: "x", title: "X", author: null } })).toEqual([
      { resource: "x", title: "X", author: null },
    ]);
  });

  test("the fixture's fields carry it through to the row", () => {
    expect(fieldsFor("gathering-at-the-orchard").every((f) => f.provenance === "user")).toBe(true);
    expect(fieldsFor("the-shed-roof").every((f) => f.provenance === "document")).toBe(true);
  });
});

describe("links", () => {
  test("any cross-reference counts, not only the ones under Related", () => {
    expect(relatedConcepts("walked with [Wren](/memories/wren.md) in May")).toEqual(["memories/wren"]);
  });

  test("an off-bundle url is not a link between memories", () => {
    expect(relatedConcepts("[the council](https://example.org/permits)")).toEqual([]);
  });

  test("an edge is written for a Related block and for an inline mention alike", () => {
    const wren = idOf("wren-and-how-you-know-her");
    const inbound = db.select().from(s.links).where(eq(s.links.toId, wren)).all();
    expect(inbound.map((l) => l.fromId).sort()).toEqual(
      [idOf("gathering-at-the-orchard"), idOf("the-long-walk-in-may")].sort(),
    );
  });

  test("a Related link to a file nobody wrote is dropped rather than dangling", () => {
    const targets = new Set(db.select().from(s.links).all().map((l) => l.toId));
    for (const target of targets) {
      expect(db.select().from(s.okfObjects).where(eq(s.okfObjects.id, target)).get()).toBeTruthy();
    }
  });
});

describe("reindexing", () => {
  test("is idempotent: the same bundle yields the same rows", async () => {
    const before = db.select().from(s.okfObjects).all().length;
    const beforeFields = db.select().from(s.okfFields).all().length;
    await reindexOkf(db, { root, now: new Date("2026-08-26T13:20:00Z") });
    expect(db.select().from(s.okfObjects).all().length).toBe(before);
    expect(db.select().from(s.okfFields).all().length).toBe(beforeFields);
  });

  test("ids are derived, so a citation into memory survives a rebuild", async () => {
    const field = fieldsFor("gathering-at-the-orchard")[0];
    if (!field) throw new Error("the fixture lost its fields");
    await reindexOkf(db, { root, now: new Date("2026-08-27T13:20:00Z") });
    expect(fieldsFor("gathering-at-the-orchard")[0]?.id).toBe(field.id);
  });

  test("a fact whose value changed is retired rather than deleted", async () => {
    const before = fieldsFor("wren-and-how-you-know-her");
    const phone = before.find((f) => f.label === "Phone");
    if (!phone) throw new Error("the fixture lost its phone field");

    writeFileSync(
      join(root, "memories", "wren-and-how-you-know-her.md"),
      `---
type: Memory
title: Wren — met through the allotment, keeps the orchard
description: Wren keeps the orchard at the end of the lane.
tags: [personal, contacts, relationship]
generated: { by: okfManagerAgent, at: 2026-06-02T09:15:00Z }
stale_after: 2026-12-01
sources:
  - resource: allotment committee minutes
    title: Committee minutes, March
---

## Contact

- **Phone:** a new number she gave you directly
`,
    );
    await reindexOkf(db, { root, now: new Date("2026-08-28T13:20:00Z") });

    const retired = db.select().from(s.okfFields).where(eq(s.okfFields.id, phone.id)).get();
    expect(retired?.retiredAt).not.toBeNull();
    expect(retired?.value).toBe("listed on the committee sheet");

    const live = fieldsFor("wren-and-how-you-know-her").filter((f) => f.retiredAt === null);
    expect(live.map((f) => f.value)).toEqual(["a new number she gave you directly"]);
  });

  test("survives a field moving up the file", async () => {
    // The ordinal is unique per object, so a reorder walks a row into a slot
    // its neighbour has not left yet unless the write parks them first.
    writeFileSync(
      join(root, "memories", "gathering-at-the-orchard.md"),
      `---
type: Memory
title: The orchard gathering — Sept 12, at Wren's, bring the long table
description: A gathering at Wren's orchard on September 12.
tags: [personal, planning, events, party]
generated: { by: okfManagerAgent, at: 2026-08-14T11:02:00Z }
stale_after: 2026-11-01
sources:
  - resource: user conversation
    title: You told me over dinner
    author: human:user
---

## Details

- **Host:** Wren
- **Date:** September 12
- **Bringing:** the long table
- **Rain plan:** none agreed
`,
    );
    await reindexOkf(db, { root, now: new Date("2026-08-29T13:20:00Z") });

    const live = fieldsFor("gathering-at-the-orchard").filter((f) => f.retiredAt === null);
    expect(live.map((f) => [f.ordinal, f.label])).toEqual([
      [0, "Host"],
      [1, "Date"],
      [2, "Bringing"],
      [3, "Rain plan"],
    ]);
  });

  test("records what it read, so a parse failure would be visible rather than silent", () => {
    const sync = db.select().from(s.okfSyncState).all();
    expect(sync.length).toBe(5);
    expect(sync.every((row) => row.status === "ok" && row.contentSha256 !== null)).toBe(true);
  });
});
