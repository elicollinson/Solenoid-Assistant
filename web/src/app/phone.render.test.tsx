// The whole path at 390px: design fixtures and a synthetic OKF bundle → SQLite
// → the loaders asked as the phone → the four screens the design draws there.
//
// It renders the real payloads, so a field the phone reads and the desktop does
// not — `WorkflowRow.lede`, `CalendarDay.lede`, `KnowledgePayload.restraint` —
// fails here rather than in a browser nobody has narrowed yet.
//
// The bundle is synthetic on purpose, for the same reason knowledge.render's is:
// the store this was built for is personal and gitignored, and a test that read
// it would neither run anywhere else nor be safe to print when it failed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDb, runMigrations, type Db } from "../../../src/db";
import { loadCalendar, loadCalendarItem, type CalendarPayload } from "../../../src/db/queries/calendar";
import { loadHome, type HomePayload } from "../../../src/db/queries/home";
import { loadKnowledge, loadKnowledgeObject, type KnowledgePayload } from "../../../src/db/queries/knowledge";
import { loadWorkflow, loadWorkflows, type WorkflowsPayload } from "../../../src/db/queries/workflows";
import { reindexOkf } from "../../../src/db/okf/reindex";
import { seedDesignFixtures } from "../../../src/db/seed/design";
import { writeOkfFixture } from "../../../src/db/seed/okfBundle";
import { zonedTime } from "../../../src/db/seed/time";
import { ActivityPhone } from "./phone/ActivityPhone";
import { CalendarPhone } from "./phone/CalendarPhone";
import { MemoryPhone } from "./phone/MemoryPhone";
import { WorkflowsPhone } from "./phone/WorkflowsPhone";
import { PhoneScreen, PHONE_TABS, phoneFrame } from "./phone/chrome";

let dir: string;
let db: Db;
let home: HomePayload;
let calendar: CalendarPayload;
let knowledge: KnowledgePayload;
let workflows: WorkflowsPayload;

const MORNING = zonedTime(2026, 8, 25, 9, 20);
const NOTHING = new Set<string>();
const noop = () => {};
const loading = { status: "loading" } as const;

/** Prose the agent wrote goes through React's escaping on the way to markup, so
 *  an apostrophe in a memory's name is `&#x27;` by the time it is here. */
const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** Every screen is drawn inside the frame it lives in, because the tab bar and
 *  the sheet's offset are part of what is being tested. */
const inFrame = (node: ReactNode) =>
  renderToStaticMarkup(
    <PhoneScreen tab="Activity" onTab={noop}>
      {node}
    </PhoneScreen>,
  );

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-phone-render-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  await reindexOkf(db, { root: writeOkfFixture(join(dir, "okf")), now: MORNING });
  seedDesignFixtures(db, { now: MORNING });

  home = loadHome(db, MORNING, "phone");
  calendar = loadCalendar(db, MORNING, "phone");
  knowledge = loadKnowledge(db, MORNING, "phone");
  workflows = loadWorkflows(db, MORNING, "phone");
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the frame", () => {
  test("carries four destinations and none of the three the phone has no screen for", () => {
    const markup = inFrame(null);
    for (const label of ["Activity", "Calendar", "Memory", "Workflows"]) expect(markup).toContain(`>${label}<`);
    for (const absent of ["Reminders", "Recommendations", "Settings"]) expect(markup).not.toContain(`>${absent}<`);
  });

  test("the tab bar and the rail disagree about the store's name on purpose", () => {
    // "Things I know" is what the rail calls it and what the route is keyed by;
    // it does not fit a quarter of 390px, so the bar says Memory.
    expect(PHONE_TABS).toContain("Things I know");
    expect(inFrame(null)).toContain(">Memory<");
  });

  test("the frame is the phone's, and says so where the scrollbars are read off", () => {
    expect(inFrame(null)).toContain('data-frame="phone"');
  });
});

describe("installed", () => {
  // The frame draws a device sitting on a canvas: a border, rounded corners and
  // a shadow. Installed, the OS is already drawing the real window around it,
  // and all three become a picture of a phone inside a phone.
  test("in a tab it is the design's 390×844 device on a canvas", () => {
    const style = phoneFrame(false);
    expect(style.width).toBe("min(390px, 100vw)");
    expect(style.border).toBe("var(--border-strong)");
    expect(style.boxShadow).toBe("var(--shadow-frame)");
  });

  test("installed it is the window: no border, no corners, no shadow", () => {
    const style = phoneFrame(true);
    expect(style.width).toBe("100%");
    expect(style.height).toBe("100dvh");
    expect(style.border).toBe("none");
    expect(style.borderRadius).toBe(0);
    expect(style.boxShadow).toBe("none");
  });

  test("either way it is measured in dvh, because iOS moves the other one", () => {
    // 100vh on iOS is the height with the URL bar collapsed, which is taller
    // than what you can see — a frame sized to it hides its own tab bar.
    for (const installed of [true, false]) expect(String(phoneFrame(installed).height)).toContain("dvh");
  });

  test("the header owns the inset the status bar sits in", () => {
    expect(inFrame(null)).toContain("var(--safe-top)");
  });
});

describe("activity", () => {
  const markup = (resolved: ReadonlySet<string> = NOTHING) =>
    inFrame(<ActivityPhone home={home} resolved={resolved} onInvoke={noop} />);

  test("says what I did overnight in the phone's words, not the desktop's", () => {
    expect(markup()).toContain("Nine things done overnight.");
    expect(markup()).not.toContain("I handled nine things overnight.");
  });

  test("what is still stopped on you is the second half, and it is amber", () => {
    expect(markup()).toContain("a word from you before I go further.");
    expect(markup()).toContain("var(--signal-amber-text)");
  });

  test("every entry the feed holds is drawn, grouped by day", () => {
    const drawn = markup();
    for (const section of home.sections) {
      expect(drawn).toContain(section.label);
      for (const item of section.items) expect(drawn).toContain(esc(item.title));
    }
  });

  test("only what needs you carries buttons", () => {
    const drawn = markup();
    const prominent = home.sections.flatMap((s) => s.items).filter((i) => i.prominent && i.actions.length);
    expect(prominent.length).toBeGreaterThan(0);
    for (const item of prominent) for (const action of item.actions) expect(drawn).toContain(`>${action.label}<`);

    const quiet = home.sections.flatMap((s) => s.items).find((i) => !i.prominent && i.actions.length);
    if (quiet?.actions[0]) expect(drawn).not.toContain(`>${quiet.actions[0].label}<`);
  });

  test("settling one takes its buttons away and turns it done", () => {
    const gated = home.sections.flatMap((s) => s.items).find((i) => i.decisionId && i.prominent && i.actions.length);
    if (!gated?.decisionId || !gated.actions[0]) throw new Error("the fixtures no longer hold a gated entry");
    const after = markup(new Set([gated.decisionId]));
    expect(after).toContain(esc(gated.title));
    expect(after).not.toContain(`>${gated.actions[0].label}<`);
  });
});

describe("the calendar", () => {
  const markup = () =>
    inFrame(<CalendarPhone calendar={calendar} detail={loading} openId={null} onOpen={noop} onInvoke={noop} />);

  test("draws the week as seven cells and the day as a list", () => {
    const drawn = markup();
    for (const day of calendar.days) expect(drawn).toContain(`>${day.date}<`);
    for (const item of calendar.items.filter((i) => i.day === "d0")) expect(drawn).toContain(esc(item.title));
  });

  test("says something about the day you are on rather than about the week", () => {
    expect(markup()).toContain(esc(calendar.days[0]?.lede ?? ""));
  });

  test("nothing from another day is on the page", () => {
    const drawn = markup();
    const elsewhere = calendar.items.find((i) => i.day === "d3" && !calendar.items.some((o) => o.day === "d0" && o.title === i.title));
    if (elsewhere) expect(drawn).not.toContain(`>${elsewhere.title}<`);
  });

  test("the now-line marks where today has got to", () => {
    // 09:20 in the fixture clock, drawn against the day rather than beside it.
    expect(markup()).toContain("09:20");
  });

  test("what I am holding back from sits under the agenda", () => {
    expect(markup()).toContain("holding both boiler windows");
  });

  test("a tapped block opens a sheet with its own account", () => {
    const item = calendar.items.find((i) => i.day === "d0" && i.kind === "event");
    if (!item) throw new Error("the week no longer holds an event on day zero");
    const detail = loadCalendarItem(db, item.id, MORNING);
    if (!detail) throw new Error(`${item.title} did not load`);
    const drawn = inFrame(
      <CalendarPhone
        calendar={calendar}
        detail={{ status: "ready", data: detail }}
        openId={item.id}
        onOpen={noop}
        onInvoke={noop}
      />,
    );
    expect(drawn).toContain("Why it is here");
    expect(drawn).toContain(detail.when);
    // The sheet clears the tab bar rather than sitting under it.
    expect(drawn).toContain("var(--tabbar-total)");
  });
});

describe("things I know", () => {
  const markup = () => inFrame(<MemoryPhone knowledge={knowledge} detail={loading} openId={null} onOpen={noop} />);

  test("opens with a sentence rather than with two counts", () => {
    expect(markup()).toContain(esc("Everything I've written down."));
    expect(markup()).not.toContain("discrete facts pulled out of them");
  });

  test("every memory is a row under its own group", () => {
    const drawn = markup();
    for (const group of knowledge.groups) expect(drawn).toContain(esc(group));
    for (const row of knowledge.rows) expect(drawn).toContain(esc(row.name));
  });

  test("a row says what the memory is, since there is no column to say it in", () => {
    const withBlurb = knowledge.rows.find((r) => r.blurb);
    if (!withBlurb) throw new Error("the bundle no longer produces a blurb");
    expect(markup()).toContain(esc(withBlurb.blurb));
  });

  test("what I have not settled sits under the list", () => {
    expect(markup()).toContain("I have not merged the two Ferris addresses.");
  });

  test("a tapped memory opens a sheet with its fields and their provenance", () => {
    const row = knowledge.rows.find((r) => r.facts > 0);
    if (!row) throw new Error("the bundle no longer produces a memory with fields");
    const detail = loadKnowledgeObject(db, row.id, MORNING);
    if (!detail) throw new Error(`${row.name} did not load`);
    const drawn = inFrame(
      <MemoryPhone knowledge={knowledge} detail={{ status: "ready", data: detail }} openId={row.id} onOpen={noop} />,
    );
    expect(drawn).toContain("What I have");
    expect(drawn).toContain(esc(detail.fields[0]?.value ?? ""));
    expect(drawn).toContain(row.uri);
  });

  test("nothing here claims a write path into the store it does not have", () => {
    const row = knowledge.rows[0];
    if (!row) throw new Error("the bundle produced no memories");
    const detail = loadKnowledgeObject(db, row.id, MORNING);
    if (!detail) throw new Error(`${row.name} did not load`);
    const drawn = inFrame(
      <MemoryPhone knowledge={knowledge} detail={{ status: "ready", data: detail }} openId={row.id} onOpen={noop} />,
    );
    expect(drawn).toMatch(/<button[^>]*disabled[^>]*>Correct something<\/button>/);
    expect(drawn).toMatch(/<button[^>]*disabled[^>]*>Add a fact<\/button>/);
  });
});

describe("workflows", () => {
  const markup = (paused: ReadonlySet<string> = NOTHING) =>
    inFrame(
      <WorkflowsPhone
        workflows={workflows}
        detail={loading}
        openSlug={null}
        onOpen={noop}
        pausedLocally={paused}
        onTogglePause={noop}
        onInvoke={noop}
      />,
    );

  test("groups by what each one needs rather than only offering filters", () => {
    const drawn = markup();
    for (const heading of ["Waiting on you", "Going now", "Stopped", "Ran, nothing needed", "Paused by you"]) {
      expect(drawn).toContain(heading);
    }
  });

  test("every workflow is there, each with the line written for this width", () => {
    const drawn = markup();
    for (const row of workflows.rows) {
      expect(drawn).toContain(esc(row.name));
      expect(row.lede).toBeTruthy();
      if (row.lede) expect(drawn).toContain(esc(row.lede));
    }
  });

  test("the desktop's columns are not squeezed in beside them", () => {
    // Cadence and step survive as one mono line; "last run" does not, because
    // three columns of machine facts at 390px is what the sheet is for.
    const drawn = markup();
    expect(drawn).toContain("weekdays, 06:00");
    expect(drawn).not.toContain("Running since 06:12");
  });

  test("a pause taken here moves the row rather than only dimming it", () => {
    const running = workflows.rows.find((r) => r.state === "running");
    if (!running) throw new Error("nothing is running in the fixtures");
    const before = markup();
    const after = markup(new Set([running.slug]));
    expect(before.indexOf("Going now")).toBeGreaterThan(-1);
    // Its own group empties out with it, since it was the only one going.
    expect(after).not.toContain("Going now");
    expect(after).toContain("Paused by you");
  });

  test("a tapped row opens the summary, the gate and the rule — and no trace", () => {
    const gated = workflows.rows.find((r) => r.state === "attention");
    if (!gated) throw new Error("nothing is waiting on you in the fixtures");
    const detail = loadWorkflow(db, gated.slug, MORNING, "phone");
    if (!detail) throw new Error(`${gated.slug} did not load`);
    const drawn = inFrame(
      <WorkflowsPhone
        workflows={workflows}
        detail={{ status: "ready", data: detail }}
        openSlug={gated.slug}
        onOpen={noop}
        pausedLocally={NOTHING}
        onTogglePause={noop}
        onInvoke={noop}
      />,
    );
    expect(drawn).toContain("What changed");
    expect(drawn).toContain("This workflow");
    expect(drawn).toContain(esc(detail.gate?.title ?? ""));
    // The four tabs stay on the desktop: cutting a trace to fit makes it worse.
    for (const tab of ["Executions", "Trace", "Logs"]) expect(drawn).not.toContain(`>${tab}<`);
  });

  test("the sheet says it in the phone's words, not the desktop's summary", () => {
    const detail = loadWorkflow(db, "weekly-digest", MORNING, "phone");
    const desktop = loadWorkflow(db, "weekly-digest", MORNING);
    if (!detail || !desktop) throw new Error("the digest did not load");
    const drawn = inFrame(
      <WorkflowsPhone
        workflows={workflows}
        detail={{ status: "ready", data: detail }}
        openSlug="weekly-digest"
        onOpen={noop}
        pausedLocally={NOTHING}
        onTogglePause={noop}
        onInvoke={noop}
      />,
    );
    expect(drawn).toContain("Step four failed twice against the archive.");
    expect(drawn).not.toContain(esc(desktop.summary ?? ""));
  });

  test("nothing here claims it can start a run", () => {
    const detail = loadWorkflow(db, "bill-watch", MORNING, "phone");
    if (!detail) throw new Error("bill-watch did not load");
    const drawn = inFrame(
      <WorkflowsPhone
        workflows={workflows}
        detail={{ status: "ready", data: detail }}
        openSlug="bill-watch"
        onOpen={noop}
        pausedLocally={NOTHING}
        onTogglePause={noop}
        onInvoke={noop}
      />,
    );
    expect(drawn).toMatch(/<button[^>]*disabled[^>]*>Run it now<\/button>/);
  });
});
