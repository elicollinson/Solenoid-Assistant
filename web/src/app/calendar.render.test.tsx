// The whole path in one test: design fixtures → SQLite → the calendar queries
// → the components the design specifies. It renders the real payload, so a
// column renamed on the server or a prop dropped in the kit fails here rather
// than in a browser.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createDb, runMigrations, type Db } from "../../../src/db";
import { loadCalendar, loadCalendarItem, type CalendarPayload } from "../../../src/db/queries/calendar";
import { seedDesignFixtures } from "../../../src/db/seed/design";
import { zonedTime } from "../../../src/db/seed/time";
import { CalendarDetail } from "./CalendarDetail";
import { CalendarView } from "./CalendarView";
import type { CalendarItem } from "./api";

let dir: string;
let db: Db;
let week: CalendarPayload;

const MORNING = zonedTime(2026, 8, 25, 9, 20);
const noop = () => {};

const block = (title: string): CalendarItem => {
  const found = week.items.find((i) => i.title === title);
  if (!found) throw new Error(`nothing on the calendar called "${title}"`);
  return found;
};

const weekMarkup = (selected: string | null = null) =>
  renderToStaticMarkup(
    <CalendarView calendar={week} selected={selected} detailOpen={selected != null} onOpen={noop} />,
  );

const asideMarkup = (title: string) => {
  const item = block(title);
  const data = loadCalendarItem(db, item.id, MORNING);
  if (!data) throw new Error(`"${title}" did not load`);
  return renderToStaticMarkup(
    <CalendarDetail item={item} detail={{ status: "ready", data }} onClose={noop} onInvoke={noop} />,
  );
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-calendar-render-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  seedDesignFixtures(db, { now: MORNING });
  week = loadCalendar(db, MORNING);
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the canvas", () => {
  test("draws the header, the counted line, the range and both modes", () => {
    const html = weekMarkup();
    expect(html).toContain("Calendar");
    expect(html).toContain("Five of my runs and two of your commitments.");
    expect(html).toContain("Aug 25 – 31, 2026");
    for (const mode of ["Week", "Day"]) expect(html).toContain(`>${mode}<`);
  });

  test("names the four kinds under their swatches", () => {
    const html = weekMarkup();
    for (const label of ["yours", "my runs", "reminders", "held"]) expect(html).toContain(`>${label}<`);
  });

  test("heads every day of the week, today in the accent", () => {
    const html = weekMarkup();
    for (const day of ["Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Mon"]) expect(html).toContain(`>${day}<`);
    expect(html).toContain('color:var(--accent)">25<');
  });

  test("draws all four kinds, each with the plane its kind has", () => {
    const html = weekMarkup();
    expect(html).toContain("Latham quarter review");
    expect(html).toContain("vendor-reconciliation");
    expect(html).toContain("Call Marta back");
    expect(html).toContain("Boiler service — first slot");
    // A hold is offered, not agreed, and says so without a word for it.
    expect(html).toContain("1px dashed var(--line-strong)");
  });

  test("a run is machine output and reads as one", () => {
    const html = weekMarkup();
    expect(html).toContain("run 14 · step 6/11");
    // Mono for the title too, which is what tells a run from a commitment
    // before you have read either of them.
    expect(html).toContain('font:var(--text-mono);color:var(--text-1)');
    // A block too short for two lines drops the mono line rather than
    // clipping it: the forty-minute read at six is title only.
    expect(html).not.toContain("weekdays · 06:00");
  });

  test("the hours run down the side and the now-line sits on today", () => {
    const html = weekMarkup();
    for (const hour of ["06", "10", "14", "18", "22"]) expect(html).toContain(`>${hour}</span>`);
    expect(html).toContain("border-top:1px solid var(--accent)");
  });

  test("the canvas gives up the third column when something is open", () => {
    expect(weekMarkup()).toContain("grid-column:2 / span 2");
    expect(weekMarkup(block("Latham quarter review").id)).toContain("grid-column:2");
  });
});

describe("one thing on it", () => {
  test("an event says what it is, when, and why it is there", () => {
    const html = asideMarkup("Latham quarter review");
    expect(html).toContain(">yours<");
    expect(html).toContain("Today, 10:00 – 11:30");
    expect(html).toContain("Why it is here");
    expect(html).toContain("Yours, not mine.");
    expect(html).toContain("Room 2");
    expect(html).toContain("Show me the notes");
    // An event came from nowhere else, so there is nowhere to go from it.
    expect(html).not.toContain("Where this came from");
  });

  test("a run offers the way back to the workflow that ran it", () => {
    const html = asideMarkup("vendor-reconciliation");
    expect(html).toContain(">my run<");
    expect(html).toContain(">running<");
    expect(html).toContain("Today, from 06:12");
    expect(html).toContain("Where this came from");
    expect(html).toContain("Workflow · Q3 vendor reconciliation");
  });

  test("a reminder is the one Reminders holds, not a second copy of it", () => {
    const html = asideMarkup("Call Marta back");
    expect(html).toContain(">reminder<");
    expect(html).toContain("She called on Tuesday while you were out.");
    expect(html).toContain("Reminder · Call Marta back");
  });

  test("a held slot says who offered it and what taking it would do", () => {
    const html = asideMarkup("Boiler service — first slot");
    expect(html).toContain(">held slot<");
    expect(html).toContain("Fenwick Heating");
    expect(html).toContain("Take this one");
    expect(html).toContain("Take Friday instead");
  });

  test("while it is still being read, the block it came from carries the header", () => {
    const html = renderToStaticMarkup(
      <CalendarDetail item={block("Latham quarter review")} detail={{ status: "loading" }} onClose={noop} onInvoke={noop} />,
    );
    expect(html).toContain("Latham quarter review");
    expect(html).toContain("Room 2 · four people");
    // Nothing has been read yet, so nothing claims to have been.
    expect(html).not.toContain("Why it is here");
  });

  test("a read that fails says so where the account would have been", () => {
    const html = renderToStaticMarkup(
      <CalendarDetail
        item={block("Standup")}
        detail={{ status: "error", message: "/api/calendar/x answered 500" }}
        onClose={noop}
        onInvoke={noop}
      />,
    );
    expect(html).toContain("Standup");
    expect(html).toContain("answered 500");
  });
});
