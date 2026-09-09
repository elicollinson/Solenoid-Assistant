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
import { syncWorkflowCatalog } from "../../../src/workflows/sync";
import { writeOkfFixture } from "../../../src/db/seed/okfBundle";
import { zonedTime } from "../../../src/db/seed/time";
import { ActivityPhone } from "./phone/ActivityPhone";
import { CalendarPhone } from "./phone/CalendarPhone";
import { MemoryPhone } from "./phone/MemoryPhone";
import { RecommendationsPhone } from "./phone/RecommendationsPhone";
import { RemindersPhone } from "./phone/RemindersPhone";
import { WorkflowsPhone, type WorkflowEdits, type WorkflowTrigger } from "./phone/WorkflowsPhone";
import { runGoing } from "./WorkflowDetail";
import { loadReminder, loadReminders, type RemindersPayload } from "../../../src/db/queries/reminders";
import { loadRecommendation, loadRecommendations } from "../../../src/db/queries/recommendations";
import { proposeRecommendation } from "../../../src/db/mutations/recommendations";
import { BAR_OF, PhoneScreen, PHONE_TABS, phoneFrame } from "./phone/chrome";

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
  test("the bar carries the design's five, and the other two sit behind them", () => {
    // Reminders and Recommendations are reachable — from the Calendar and
    // Memory screens' segment rows, and by any navigation effect naming them —
    // but seven labels do not fit a 390px bar, so the bar itself draws five.
    const markup = inFrame(null);
    for (const label of ["Chat", "Activity", "Calendar", "Memory", "Workflows"]) expect(markup).toContain(`>${label}<`);
    for (const absent of ["Reminders", "Recommendations", "Settings"]) expect(markup).not.toContain(`>${absent}<`);
    expect(BAR_OF.Reminders).toBe("Calendar");
    expect(BAR_OF.Recommendations).toBe("Things I know");
  });

  test("a screen behind another lights that one's bar entry", () => {
    const markup = renderToStaticMarkup(
      <PhoneScreen tab="Reminders" onTab={noop}>
        {null}
      </PhoneScreen>,
    );
    expect(markup).toMatch(/aria-current="page"[^>]*>(?:(?!<\/button>).)*Calendar/);
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
    const prominent = home.sections
      .flatMap((s) => s.items)
      .filter((i) => i.prominent && i.actions.length && !(i.state === "running" && i.progress));
    expect(prominent.length).toBeGreaterThan(0);
    for (const item of prominent) for (const action of item.actions) expect(drawn).toContain(`>${action.label}<`);

    const quiet = home.sections.flatMap((s) => s.items).find((i) => !i.prominent && i.actions.length);
    if (quiet?.actions[0]) expect(drawn).not.toContain(`>${quiet.actions[0].label}<`);
  });

  test("a running entry draws its progress, not the desktop's row of buttons", () => {
    // The seed marks the running entry prominent as well. The design draws it
    // as a quiet line with its meter, and Open / Pause / Trace at 390px is
    // three half-buttons — so the meter wins.
    const running = home.sections.flatMap((s) => s.items).find((i) => i.state === "running" && i.progress);
    if (!running?.actions[0]) throw new Error("the fixtures no longer hold a running entry with actions");
    const drawn = markup();
    expect(drawn).not.toContain(`>${running.actions[0].label}<`);
    expect(drawn).toContain("var(--meter-fill)");
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
  const idle: WorkflowTrigger = { pending: false, error: null, started: null, onRun: noop, onClear: noop };
  const quiet: WorkflowEdits = { busy: false, error: null, onStop: noop, onInstructions: noop, onPermission: noop };
  const markup = (payload: WorkflowsPayload = workflows) =>
    inFrame(
      <WorkflowsPhone
        workflows={payload}
        detail={loading}
        openSlug={null}
        onOpen={noop}
        onTogglePause={noop}
        onInvoke={noop}
        trigger={idle}
        edits={quiet}
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

  test("a pause the server has written moves the row rather than only dimming it", () => {
    const running = workflows.rows.find((r) => r.state === "running");
    if (!running) throw new Error("nothing is running in the fixtures");
    const before = markup();
    const after = markup({
      ...workflows,
      rows: workflows.rows.map((r) => (r.slug === running.slug ? { ...r, paused: true } : r)),
    });
    expect(before.indexOf("Going now")).toBeGreaterThan(-1);
    // Its own group empties out with it, since it was the only one going.
    expect(after).not.toContain("Going now");
    expect(after).toContain("Paused by you");
  });

  test("a tapped row opens the summary, the gate and the rule, with the other three tabs behind chips", () => {
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
        onTogglePause={noop}
        onInvoke={noop}
        trigger={idle}
        edits={quiet}
      />,
    );
    expect(drawn).toContain("What changed");
    expect(drawn).toContain("This workflow");
    expect(drawn).toContain(esc(detail.gate?.title ?? ""));
    // The desktop's other three tabs are here too, one chip each; the sheet
    // opens on Summary and draws the rest only when asked.
    for (const tab of ["Trace", "Logs"]) expect(drawn).toContain(`>${tab}<`);
    expect(drawn).not.toContain("Recent executions");
  });

  test("a gate answered in this browser is drawn closed, not asked again", () => {
    const gated = workflows.rows.find((r) => r.state === "attention");
    if (!gated) throw new Error("nothing is waiting on you in the fixtures");
    const detail = loadWorkflow(db, gated.slug, MORNING, "phone");
    if (!detail?.gate) throw new Error(`${gated.slug} has no gate`);
    const sheet = (resolved: ReadonlySet<string>) =>
      inFrame(
        <WorkflowsPhone
          workflows={workflows}
          detail={{ status: "ready", data: detail }}
          openSlug={gated.slug}
          onOpen={noop}
          resolved={resolved}
          onTogglePause={noop}
          onInvoke={noop}
          trigger={idle}
          edits={quiet}
        />,
      );
    expect(sheet(NOTHING)).toContain(esc(detail.gate.title));
    expect(sheet(new Set([detail.gate.id]))).not.toContain(esc(detail.gate.title));
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
        onTogglePause={noop}
        onInvoke={noop}
        trigger={idle}
        edits={quiet}
      />,
    );
    expect(drawn).toContain("Step four failed twice against the archive.");
    expect(drawn).not.toContain(esc(desktop.summary ?? ""));
  });

  test("a design fixture, with no code behind it, does not claim it can start a run", () => {
    const detail = loadWorkflow(db, "bill-watch", MORNING, "phone");
    if (!detail) throw new Error("bill-watch did not load");
    const drawn = inFrame(
      <WorkflowsPhone
        workflows={workflows}
        detail={{ status: "ready", data: detail }}
        openSlug="bill-watch"
        onOpen={noop}
        onTogglePause={noop}
        onInvoke={noop}
        trigger={idle}
        edits={quiet}
      />,
    );
    expect(drawn).toMatch(/<button[^>]*disabled[^>]*>Run it now<\/button>/);
  });

  test("the sheet carries the desktop's other three tabs, on the run you picked", () => {
    const detail = loadWorkflow(db, "vendor-reconciliation", MORNING, "phone");
    if (!detail || !detail.executions[0]) throw new Error("vendor-reconciliation kept no runs");
    const sheet = (tab: "Summary" | "Executions" | "Trace" | "Logs") =>
      inFrame(
        <WorkflowsPhone
          workflows={workflows}
          detail={{ status: "ready", data: detail }}
          openSlug="vendor-reconciliation"
          onOpen={noop}
          tab={tab}
          onTab={noop}
          onTogglePause={noop}
          onInvoke={noop}
          trigger={idle}
          edits={quiet}
        />,
      );
    // The chips, with the run count on Runs.
    expect(sheet("Summary")).toContain(`>Runs ${detail.executions.length}<`);
    for (const label of ["Summary", "Trace", "Logs"]) expect(sheet("Summary")).toContain(`>${label}<`);
    // Runs lists every execution and draws the newest one's account.
    const runs = sheet("Executions");
    for (const run of detail.executions) expect(runs).toContain(esc(run.label));
    expect(runs).toContain("Recent executions");
    // Trace and Logs are the same run's diagnostics, with their controls.
    const trace = sheet("Trace");
    expect(trace).toContain(">Expanded<");
    expect(trace).toContain(">Collapsed<");
    const logs = sheet("Logs");
    for (const level of ["All", "Warnings", "Errors"]) expect(logs).toContain(`>${level}<`);
    expect(logs).toContain("raw log");
  });

  test("a running workflow can be stopped from the sheet, and says so while it is", () => {
    const detail = loadWorkflow(db, "vendor-reconciliation", MORNING, "phone");
    if (!detail || detail.state !== "running") throw new Error("vendor-reconciliation is not running in the fixtures");
    const sheet = (edits: Partial<WorkflowEdits>) =>
      inFrame(
        <WorkflowsPhone
          workflows={workflows}
          detail={{ status: "ready", data: detail }}
          openSlug="vendor-reconciliation"
          onOpen={noop}
          onTogglePause={noop}
          onInvoke={noop}
          trigger={idle}
          edits={{ ...quiet, ...edits }}
        />,
      );
    expect(sheet({})).toMatch(/<button[^>]*>Kill run<\/button>/);
    expect(sheet({ busy: true })).toMatch(/<button[^>]*disabled[^>]*>Stopping…<\/button>/);
    expect(sheet({ error: "The run had already ended." })).toContain("The run had already ended.");
    // Holding the schedule turns the mark idle, but the run it started before
    // the hold is still going — and Kill run is the only way to stop it, so it
    // stays. start → pause schedule → stop, without re-enabling the schedule.
    const held = { ...detail, paused: true, state: "idle" as const };
    const heldRows = { ...workflows, rows: workflows.rows.map((r) => (r.slug === held.slug ? { ...r, paused: true, state: "idle" as const } : r)) };
    expect(held.executions[0]?.state).toBe("running");
    const paused = inFrame(
      <WorkflowsPhone
        workflows={heldRows}
        detail={{ status: "ready", data: held }}
        openSlug="vendor-reconciliation"
        onOpen={noop}
        onTogglePause={noop}
        onInvoke={noop}
        trigger={idle}
        edits={quiet}
      />,
    );
    expect(paused).toMatch(/<button[^>]*>Kill run<\/button>/);
    expect(paused).toContain(">Put it back on schedule<");
    expect(runGoing(held)).toBe(true);
    expect(runGoing({ executions: [] })).toBe(false);

    // A workflow that is not running offers no stop.
    const idleDetail = loadWorkflow(db, "bill-watch", MORNING, "phone");
    if (!idleDetail) throw new Error("bill-watch did not load");
    expect(
      inFrame(
        <WorkflowsPhone
          workflows={workflows}
          detail={{ status: "ready", data: idleDetail }}
          openSlug="bill-watch"
          onOpen={noop}
          onTogglePause={noop}
          onInvoke={noop}
          trigger={idle}
          edits={quiet}
        />,
      ),
    ).not.toContain("Kill run");
  });

  test("the standing rule can be edited from the sheet", () => {
    const detail = loadWorkflow(db, "contract-review", MORNING, "phone");
    if (!detail) throw new Error("contract-review did not load");
    const drawn = inFrame(
      <WorkflowsPhone
        workflows={workflows}
        detail={{ status: "ready", data: detail }}
        openSlug="contract-review"
        onOpen={noop}
        onTogglePause={noop}
        onInvoke={noop}
        trigger={idle}
        edits={quiet}
      />,
    );
    expect(drawn).toContain("Standing instructions");
    expect(drawn).toMatch(/<button[^>]*>(Edit instructions|Give me a rule)<\/button>/);
    expect(drawn).not.toMatch(/<button[^>]*disabled[^>]*>(Edit instructions|Give me a rule)<\/button>/);
  });

  test("a catalogued workflow can be run from the sheet, with its form", () => {
    // The catalog is what makes a row runnable; the design fixtures are not.
    syncWorkflowCatalog(db, MORNING);
    const table = loadWorkflows(db, MORNING, "phone");
    const row = table.rows.find((r) => r.slug === "safety-classification");
    const detail = loadWorkflow(db, "safety-classification", MORNING, "phone");
    if (!row || !detail) throw new Error("the catalog no longer holds the prompt-injection screen");
    expect(detail.runnable).toBe(true);
    expect(detail.inputs.length).toBeGreaterThan(0);

    const sheet = (trigger: Partial<WorkflowTrigger>) =>
      inFrame(
        <WorkflowsPhone
          workflows={table}
          detail={{ status: "ready", data: detail }}
          openSlug={row.slug}
          onOpen={noop}
          onTogglePause={noop}
          onInvoke={noop}
          trigger={{ ...idle, ...trigger }}
          edits={quiet}
        />,
      );
    expect(sheet({})).toMatch(/<button[^>]*>Run it now<\/button>/);
    expect(sheet({})).not.toMatch(/<button[^>]*disabled[^>]*>Run it now<\/button>/);
    // While it is starting the button says so and cannot be pressed twice;
    // a refusal is put in the sheet in the server's words.
    expect(sheet({ pending: true })).toMatch(/<button[^>]*disabled[^>]*>Starting…<\/button>/);
    expect(sheet({ error: "Words per chunk must be at least 1." })).toContain("Words per chunk must be at least 1.");
  });
});

describe("reminders", () => {
  let reminders: RemindersPayload;
  beforeAll(() => {
    reminders = loadReminders(db, MORNING);
  });
  const NO_MARKS = new Map<string, "done" | "later">();
  const markup = (marks = NO_MARKS) =>
    inFrame(
      <RemindersPhone reminders={reminders} detail={loading} openId={null} onOpen={noop} marks={marks} onMark={noop} onInvoke={noop} />,
    );

  test("every reminder is a row under its due bucket, with the three filters", () => {
    const drawn = markup();
    for (const label of ["All", "Needs you", "Done"]) expect(drawn).toContain(`>${label}<`);
    for (const row of reminders.rows) expect(drawn).toContain(esc(row.title));
    expect(drawn).toContain("Overdue");
  });

  test("a due row offers Done and Later, and a mark moves it to Closed or Someday", () => {
    const due = reminders.rows.find((r) => r.group === "Today" || r.group === "Overdue");
    if (!due) throw new Error("nothing is due in the fixtures");
    expect(markup()).toContain(">Done<");
    expect(markup()).toContain(">Later<");
    const done = markup(new Map([[due.id, "done"]]));
    expect(done).toContain("Closed");
    expect(done).toContain("You closed this out, so I stopped tracking it.");
    const later = markup(new Map([[due.id, "later"]]));
    expect(later).toContain("Someday");
  });

  test("a tapped reminder opens a sheet with its reason, gate, evidence and history", () => {
    const gated = reminders.rows.find((r) => r.gated);
    if (!gated) throw new Error("no gated reminder in the fixtures");
    const detail = loadReminder(db, gated.id, MORNING);
    if (!detail) throw new Error(`${gated.title} did not load`);
    const drawn = inFrame(
      <RemindersPhone
        reminders={reminders}
        detail={{ status: "ready", data: detail }}
        openId={gated.id}
        onOpen={noop}
        marks={NO_MARKS}
        onMark={noop}
        onInvoke={noop}
      />,
    );
    expect(drawn).toContain("Why I set this");
    expect(drawn).toContain("This is the decision I");
    for (const action of detail.gate?.actions ?? []) expect(drawn).toContain(esc(action.label));
    expect(drawn).toContain("What I");
    expect(drawn).toMatch(/<button[^>]*>Mark it done<\/button>/);
    expect(drawn).toMatch(/<button[^>]*>Remind me later<\/button>/);
    // Dropping a reminder has no write path on either shell.
    expect(drawn).toMatch(/<button[^>]*disabled[^>]*>Drop it<\/button>/);
    if (detail.evidence.length) expect(drawn).toContain(esc(detail.evidence[0]!.title));
    expect(drawn).toContain("var(--tabbar-total)");
  });
});

describe("recommendations", () => {
  test("an empty store says so rather than inventing a suggestion", () => {
    const drawn = inFrame(
      <RecommendationsPhone
        recommendations={loadRecommendations(db, MORNING)}
        detail={loading}
        openId={null}
        onOpen={noop}
        stances={new Map()}
        onAnswer={noop}
      />,
    );
    expect(drawn).toContain("Nothing to suggest yet.");
    for (const label of ["All", "Waiting on you", "Standing", "Set aside"]) expect(drawn).toContain(`>${label}<`);
  });

  test("an open suggestion carries its two answers, a sheet, and moves when answered", () => {
    const id = proposeRecommendation(db, {
      title: "Let me settle vendor differences under £50 myself",
      blurb: "I asked you about fourteen of these last quarter and you approved every one.",
      confidence: "strong",
      prose: ["Every reconciliation run this quarter turned up a handful of differences small enough that the answer never changed."],
      restraint: "I did not apply this while waiting.",
      basisLabel: "14 approvals · 0 rejections",
      scopeLabel: "Vendor reconciliation",
      scopeOkfUri: "okf:policy/spend-floor",
      from: "6 runs",
      effect: [["Questions I'd stop asking", "roughly 12 a quarter"]],
      affirm: "Set the floor at £50",
      quiet: "Keep asking me",
      formedAt: MORNING,
    });
    const list = loadRecommendations(db, MORNING);
    const detail = loadRecommendation(db, id, MORNING);
    if (!detail) throw new Error("the proposed recommendation did not load");
    const sheet = (stances: ReadonlyMap<string, "adopted" | "declined">, openId: string | null) =>
      inFrame(
        <RecommendationsPhone recommendations={list} detail={{ status: "ready", data: detail }} openId={openId} onOpen={noop} stances={stances} onAnswer={noop} />,
      );
    const open = sheet(new Map(), null);
    expect(open).toContain("Waiting on you");
    expect(open).toMatch(/<button[^>]*>Set the floor at £50<\/button>/);
    expect(open).toContain(">No<");

    const opened = sheet(new Map(), id);
    expect(opened).toContain("What I noticed");
    expect(opened).toContain("This is the permission I");
    expect(opened).toContain("What changes if you say yes");
    expect(opened).toContain(">Keep asking me<");
    expect(opened).toMatch(/<button[^>]*disabled[^>]*>Ask me again later<\/button>/);

    const adopted = sheet(new Map([[id, "adopted"]]), id);
    expect(adopted).toContain("Standing");
    expect(adopted).toContain("You took this just now.");
    expect(adopted).not.toMatch(/<button[^>]*>Set the floor at £50<\/button>/);
    const declined = sheet(new Map([[id, "declined"]]), null);
    expect(declined).toContain("Set aside");
  });
});
