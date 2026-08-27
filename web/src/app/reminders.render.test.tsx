// The whole path in one test: design fixtures → SQLite → the reminder queries →
// the components the design specifies. It renders the real payload, so a column
// renamed on the server or a prop dropped in the kit fails here rather than in
// a browser.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createDb, runMigrations, type Db } from "../../../src/db";
import { loadReminder, loadReminders, type ReminderDetailPayload, type RemindersPayload } from "../../../src/db/queries/reminders";
import { seedDesignFixtures } from "../../../src/db/seed/design";
import { zonedTime } from "../../../src/db/seed/time";
import { ReminderDetail } from "./ReminderDetail";
import { RemindersView, type LocalMark } from "./RemindersView";

let dir: string;
let db: Db;
let list: RemindersPayload;

const MORNING = zonedTime(2026, 8, 25, 9, 20);
const NO_MARKS = new Map<string, LocalMark>();
const noop = () => {};

const idOf = (title: string) => {
  const found = list.rows.find((r) => r.title.startsWith(title));
  if (!found) throw new Error(`no reminder starting "${title}"`);
  return found.id;
};

const detail = (title: string): ReminderDetailPayload => {
  const one = loadReminder(db, idOf(title), MORNING);
  if (!one) throw new Error(`reminder "${title}" did not load`);
  return one;
};

const listMarkup = (marks: ReadonlyMap<string, LocalMark> = NO_MARKS) =>
  renderToStaticMarkup(<RemindersView reminders={list} marks={marks} onMark={noop} onOpen={noop} />);

const detailMarkup = (title: string, mark?: LocalMark) =>
  renderToStaticMarkup(
    <ReminderDetail reminder={detail(title)} mark={mark} onMark={noop} onBack={noop} onInvoke={noop} />,
  );

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-reminders-render-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  seedDesignFixtures(db, { now: MORNING });
  list = loadReminders(db, MORNING);
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the list", () => {
  test("draws the header, the lede and the three filters", () => {
    const html = listMarkup();
    expect(html).toContain("Reminders");
    expect(html).toContain("One of them is past when you asked to hear about it.");
    for (const filter of ["All", "Needs you", "Done"]) expect(html).toContain(filter);
  });

  test("groups the rows under the buckets that have something in them", () => {
    const html = listMarkup();
    for (const group of ["Overdue", "Today", "This week", "Someday", "Closed"]) expect(html).toContain(group);
    // Nothing is set more than a week out, so that bucket stays empty and the
    // heading never draws. ("Later" is also a row control, hence the payload.)
    expect(list.rows.some((r) => r.group === "Later")).toBe(false);
  });

  test("each row carries its note, its source and when it is due", () => {
    const html = listMarkup();
    expect(html).toContain("Tell Ferris whether the credit note stands");
    expect(html).toContain("Two invoices are held against this");
    expect(html).toContain("from okf:vendor/ferris-terms");
    expect(html).toContain("Yesterday 17:00");
  });

  test("only what needs you is badged, and what is closed says so", () => {
    const html = listMarkup();
    expect(html.match(/needs you/g)?.length).toBe(2);
    expect(html).toContain("Closed");
  });

  test("closing one in the browser moves it and replaces the line that explained the date", () => {
    const html = listMarkup(new Map([[idOf("Call Marta"), "done"]]));
    expect(html).toContain("You closed this out, so I stopped tracking it.");
    expect(html).not.toContain("She prefers afternoon calls");
  });

  test("closing the overdue one recounts the sentence that called it overdue", () => {
    expect(listMarkup()).toContain("One of them is past when you asked to hear about it.");
    const html = listMarkup(new Map([[idOf("Tell Ferris"), "done"]]));
    expect(html).toContain("Nothing is overdue.");
    expect(html).not.toContain("One of them is past when you asked to hear about it.");
    // The agent's own line in front of the count is left exactly as written.
    expect(html).toContain("Things I&#x27;m holding for you rather than acting on.");
  });

  test("pushing one out of today leaves the overdue count alone", () => {
    // Only Overdue is counted, so pushing something due today changes nothing
    // about how late you are.
    const html = listMarkup(new Map([[idOf("Call Marta"), "later"]]));
    expect(html).toContain("One of them is past when you asked to hear about it.");
  });

  test("pushing one drops its date rather than inventing a new one", () => {
    const html = listMarkup(new Map([[idOf("Call Marta"), "later"]]));
    expect(html).toContain("Pushed a week. I&#x27;ll raise it again then and not before.");
    expect(html).toContain("In a week");
  });
});

describe("one reminder", () => {
  test("draws the header, the state word and the mono line under it", () => {
    const html = detailMarkup("Tell Ferris");
    expect(html).toContain("← Reminders");
    expect(html).toContain("needs you");
    expect(html).toContain("overdue");
    expect(html).toContain("yesterday 17:00");
  });

  test("draws every paragraph of the account and every line of the trail", () => {
    const html = detailMarkup("Tell Ferris");
    expect(html).toContain("Why I set this");
    expect(html).toContain("guessing either way would put a number in the ledger");
    expect(html).toContain("What I&#x27;ve done about it");
    expect(html).toContain("Held again this morning.");
  });

  test("the pairs and the standing rule sit in the aside", () => {
    const html = detailMarkup("Tell Ferris");
    expect(html).toContain("This reminder");
    expect(html).toContain("Blocks");
    expect(html).toContain("Q3 vendor reconciliation");
    expect(html).toContain("Standing instruction");
    expect(html).toContain("Don&#x27;t touch anything Ferris until the credit note is decided.");
  });

  test("only the one with an open decision draws the alert panel", () => {
    expect(detailMarkup("Pick a slot")).toContain("This is the decision I&#x27;m waiting on");
    expect(detailMarkup("Pick a slot")).toContain("Take Friday");
    // The credit note is overdue, not gated: its two offers read as links.
    expect(detailMarkup("Tell Ferris")).not.toContain("This is the decision I&#x27;m waiting on");
    expect(detailMarkup("Tell Ferris")).toContain("Settle it now");
  });

  test("the evidence list names each source, who it is from and why it was kept", () => {
    const html = detailMarkup("Tell Ferris");
    expect(html).toContain("What I looked at");
    expect(html).toContain("Credit note CN-0117 — for your records");
    expect(html).toContain("captured by me from the accounts portal");
    expect(html).toContain("4 messages · 1 pinned"); // the chat's support line
    // The ref and the source itself only appear once a row is opened, which is
    // the viewer's job; the query tests cover what it will be handed.
  });

  test("nothing writes yet, so dropping it and editing the rule are shown disabled", () => {
    const html = detailMarkup("Tell Ferris");
    expect(html).toContain("Drop it");
    expect(html).toContain("Edit instructions");
    // Two buttons on this page commit to nothing, and both say so in the DOM.
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });

  test("a closed one offers the way back rather than two more decisions", () => {
    const html = detailMarkup("Send Priya");
    expect(html).toContain("Back to the list");
    expect(html).not.toContain("Mark it done");
    expect(html).toContain("closed");
  });

  test("marking it done in the browser reads through the whole header", () => {
    const html = detailMarkup("Tell Ferris", "done");
    expect(html).toContain("Back to the list");
    expect(html).toContain("just now");
    expect(html).not.toContain("Settle it now");
  });

  test("a reminder with nothing behind it says so rather than drawing empty sections", () => {
    const bare = detail("Call Marta");
    expect(bare.instruction).toBeNull();
    const html = detailMarkup("Call Marta");
    expect(html).not.toContain("Standing instruction");
    expect(html).toContain("Missed call logged.");
  });
});
