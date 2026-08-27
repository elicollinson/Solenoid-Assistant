// The whole path in one test: a synthetic OKF bundle → the indexer → SQLite →
// the knowledge queries → the components the design specifies. It renders the
// real payload, so a column renamed on the server or a prop dropped in the kit
// fails here rather than in a browser.
//
// The bundle is synthetic on purpose. The store this surface was built for is
// personal and gitignored, and a test that read it would neither run anywhere
// else nor be safe to print when it failed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createDb, runMigrations, type Db } from "../../../src/db";
import {
  loadKnowledge,
  loadKnowledgeObject,
  type KnowledgeDetailPayload,
  type KnowledgePayload,
} from "../../../src/db/queries/knowledge";
import { reindexOkf } from "../../../src/db/okf/reindex";
import { writeOkfFixture } from "../../../src/db/seed/okfBundle";
import { zonedTime } from "../../../src/db/seed/time";
import { KnowledgeObject } from "./KnowledgeObject";
import { ThingsIKnowView } from "./ThingsIKnowView";

let dir: string;
let db: Db;
let list: KnowledgePayload;

const MORNING = zonedTime(2026, 8, 25, 9, 20);
const noop = () => {};

const open = (name: string): KnowledgeDetailPayload => {
  const found = list.rows.find((r) => r.name.startsWith(name));
  if (!found) throw new Error(`no memory starting "${name}"`);
  const one = loadKnowledgeObject(db, found.id, MORNING);
  if (!one) throw new Error(`memory "${name}" did not load`);
  return one;
};

const listMarkup = () => renderToStaticMarkup(<ThingsIKnowView knowledge={list} onOpen={noop} />);
const objectMarkup = (name: string) =>
  renderToStaticMarkup(<KnowledgeObject memory={open(name)} onBack={noop} />);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-knowledge-render-"));
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
  test("draws the heading, the derived lede and a chip per group", () => {
    const html = listMarkup();
    expect(html).toContain("Things I know");
    expect(html).toContain("Five things I&#x27;ve written down about you and your life");
    expect(html).toContain("All 5");
    expect(html).toContain("People and contacts 1");
  });

  test("draws a section per group that has rows, with its count", () => {
    const html = listMarkup();
    for (const group of list.groups) {
      const n = list.rows.filter((r) => r.group === group).length;
      expect(html).toContain(`${group} · ${n}`);
    }
  });

  test("a row carries the name, the blurb, the short uri and the when", () => {
    const html = listMarkup();
    expect(html).toContain("The orchard gathering");
    expect(html).toContain("Wren is hosting, the long table is coming from us");
    expect(html).toContain("gathering-at-the-orchard");
    expect(html).toContain("Aug 14");
  });

  test("says how many facts it pulled out, and a dash where it pulled none", () => {
    const html = listMarkup();
    expect(html).toContain("4 facts");
    // "The long walk in May" is prose, so its cell is a dash rather than "0".
    expect(html).toContain("—");
    expect(html).not.toContain("0 facts");
  });

  test("badges the memory holding two answers, and only that one", () => {
    const html = listMarkup();
    expect(html.match(/needs you/g)?.length).toBe(1);
  });

  test("badges what is past its review date", () => {
    expect(listMarkup()).toContain("unchecked");
  });

  test("offers a way to find one, because there are more than a screenful", () => {
    expect(listMarkup()).toContain('placeholder="Find a memory"');
  });
});

describe("one memory", () => {
  test("draws the header with the uri, the revision and the fact count", () => {
    const html = objectMarkup("The orchard");
    expect(html).toContain("okf:memories/gathering-at-the-orchard");
    expect(html).toContain("rev 2");
    expect(html).toContain("4 facts");
  });

  test("accounts for itself from the file rather than from invention", () => {
    const html = objectMarkup("The orchard");
    expect(html).toContain("How I came to know this");
    expect(html).toContain("I wrote this one on Jul 30, 2026, and rewrote it one time since.");
  });

  test("draws the field table with whose claim each fact is", () => {
    const html = objectMarkup("The orchard");
    expect(html).toContain("What I have");
    expect(html).toContain("Whose claim");
    expect(html).toContain("September 12");
    expect(html).toContain("you told me");
  });

  test("draws the memory's own prose, and no table, when it holds no fields", () => {
    const html = objectMarkup("The long walk");
    expect(html).toContain("The memory, as I wrote it");
    expect(html).toContain("You walked the ridge in May with Wren");
    expect(html).not.toContain("What I have");
  });

  test("raises the conflict as an alert, with both sides marked in the table", () => {
    const html = objectMarkup("The shed roof");
    expect(html).toContain("I&#x27;m holding two answers for one field");
    expect(html).toContain("£1,240, ridge and felt");
    expect(html).toContain("£980, felt only");
  });

  test("a memory with nothing unsettled raises no alert", () => {
    expect(objectMarkup("The orchard")).not.toContain("holding two answers");
  });

  test("draws the trail only where there is more than one entry in it", () => {
    expect(objectMarkup("The orchard")).toContain("What has changed");
    expect(objectMarkup("The long walk")).not.toContain("What has changed");
  });

  test("lists what links here, counted", () => {
    const html = objectMarkup("Wren");
    expect(html).toContain("What links here · 2");
    expect(html).toContain("The long walk in May");
  });

  test("lists the sources as descriptors, since there is nothing to open", () => {
    expect(objectMarkup("Wren")).toContain("Committee minutes, March");
  });

  test("names the file, because the file is the source of truth", () => {
    expect(objectMarkup("The orchard")).toContain("okf/memories/gathering-at-the-orchard.md");
  });

  test("draws the tags it was filed by", () => {
    expect(objectMarkup("The orchard")).toContain("planning");
  });

  test("offers the write controls disabled, because nothing writes to okf/ yet", () => {
    const html = objectMarkup("The orchard");
    expect(html).toContain("Correct something");
    expect(html.match(/disabled=""/g)?.length).toBe(3);
  });

  test("a deprecated memory reads as closed rather than as quiet", () => {
    const html = objectMarkup("The old bike lock");
    expect(html).toContain("deprecated");
  });
});
