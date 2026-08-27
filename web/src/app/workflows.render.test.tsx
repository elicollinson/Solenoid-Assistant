// The whole path in one test: design fixtures → SQLite → the workflow queries →
// the components the design specifies. It renders the real payload, so a column
// renamed on the server or a prop dropped in the kit fails here rather than in
// a browser.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createDb, runMigrations, type Db } from "../../../src/db";
import { loadWorkflow, loadWorkflows, type WorkflowDetailPayload, type WorkflowsPayload } from "../../../src/db/queries/workflows";
import { seedDesignFixtures } from "../../../src/db/seed/design";
import { syncWorkflowCatalog } from "../../../src/workflows/sync";
import { zonedTime } from "../../../src/db/seed/time";
import { WorkflowDetail, type WorkflowEdits, type WorkflowTrigger } from "./WorkflowDetail";
import { WorkflowsView } from "./WorkflowsView";

let dir: string;
let db: Db;
let list: WorkflowsPayload;

const MORNING = zonedTime(2026, 8, 25, 9, 20);
const noop = () => {};

const detail = (slug: string): WorkflowDetailPayload => {
  const found = loadWorkflow(db, slug, MORNING);
  if (!found) throw new Error(`no workflow ${slug}`);
  return found;
};

/** Nothing started, nothing refused — the state every one of these renders in. */
const IDLE: WorkflowTrigger = { pending: false, error: null, started: null, onRun: noop, onClear: noop };
const SETTLED: WorkflowEdits = { busy: false, error: null, onStop: noop, onInstructions: noop };

const drawn = (workflow: WorkflowDetailPayload, tab: string, trigger: WorkflowTrigger = IDLE, askOnOpen = false) =>
  renderToStaticMarkup(
    <WorkflowDetail
      workflow={workflow}
      tab={tab}
      onTab={noop}
      paused={workflow.paused}
      onTogglePause={noop}
      onBack={noop}
      onInvoke={noop}
      trigger={trigger}
      edits={SETTLED}
      askOnOpen={askOnOpen}
    />,
  );

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-workflows-render-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  seedDesignFixtures(db, { now: MORNING });
  list = loadWorkflows(db, MORNING);
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the workflow table", () => {
  const html = () =>
    renderToStaticMarkup(
      <WorkflowsView workflows={list} busy={false} error={null} onTogglePause={noop} onOpen={noop} onRun={noop} />,
    );

  test("draws the header, the five filters and every row", () => {
    const markup = html();
    expect(markup).toContain("Workflows");
    expect(markup).toContain("One is going now; one stopped; one is waiting on you.");
    for (const filter of ["All", "Needs you", "Running", "Scheduled", "Paused"]) expect(markup).toContain(filter);
    for (const row of list.rows) expect(markup).toContain(row.name);
  });

  test("each row carries its cadence, its last run and its step", () => {
    const markup = html();
    expect(markup).toContain("Weekdays, 06:00");
    expect(markup).toContain("Running since 06:12");
    expect(markup).toContain("6/11");
    expect(markup).toContain("Paused by you on Aug 9");
  });

  test("state reads as a badge as well as a mark", () => {
    const markup = html();
    expect(markup).toContain(">running<");
    expect(markup).toContain(">needs you<");
    expect(markup).toContain(">halted<");
    expect(markup).toContain(">paused<");
  });

  test("a paused row reads as paused and empties its step column", () => {
    // Pausing is written now, so what arrives is a payload with the flag set
    // rather than a set of slugs the browser is holding on the side.
    const paused: WorkflowsPayload = {
      ...list,
      rows: list.rows.map((row) => (row.slug === "calendar-tidy" ? { ...row, paused: true, state: "idle" } : row)),
    };
    const markup = renderToStaticMarkup(
      <WorkflowsView workflows={paused} busy={false} error={null} onTogglePause={noop} onOpen={noop} onRun={noop} />,
    );
    // Two paused rows now: the seeded one and the one flipped above.
    expect(markup.match(/>paused</g)?.length).toBe(2);
  });

  test("a refused pause is said out loud rather than swallowed", () => {
    const markup = renderToStaticMarkup(
      <WorkflowsView
        workflows={list}
        busy={false}
        error="No workflow called calendar-tidy"
        onTogglePause={noop}
        onOpen={noop}
        onRun={noop}
      />,
    );
    expect(markup).toContain("No workflow called calendar-tidy");
  });
});

describe("one workflow", () => {
  test("the summary tab says where it stands, what changed and the rule", () => {
    const markup = drawn(detail("vendor-reconciliation"), "Summary");
    expect(markup).toContain("Where this stands");
    expect(markup).toContain("I&#x27;m matching 43 vendor invoices against the Q3 ledger.");
    expect(markup).toContain("What changed");
    expect(markup).toContain("Matched 32 of 43 invoices to ledger lines.");
    expect(markup).toContain("Standing instructions");
    expect(markup).toContain("Runs");
    expect(markup).toContain("18m 40s");
  });

  test("the open gate draws the alert plane with its own buttons", () => {
    const markup = drawn(detail("contract-review"), "Summary");
    expect(markup).toContain("Approve the Ferris contract reply");
    expect(markup).toMatch(/<button[^>]*>Send it<\/button>/);
    // Nothing sits on the reconciliation, so it draws no gate.
    expect(drawn(detail("vendor-reconciliation"), "Summary")).not.toContain("Approve the Ferris contract reply");
  });

  test("a workflow with no rule of its own says so rather than showing a blank", () => {
    const markup = drawn(detail("calendar-tidy"), "Summary");
    expect(markup).toContain("You haven&#x27;t given me a rule for this one");
  });

  test("the executions tab lists the runs and shows the newest write-up", () => {
    const markup = drawn(detail("vendor-reconciliation"), "Executions");
    expect(markup).toContain("Recent executions");
    for (const label of ["Run 14", "Run 13", "Run 12", "Run 11"]) expect(markup).toContain(label);
    expect(markup).toContain("I started at 06:12 with the Q3 ledger");
    expect(markup).toContain("4 tool calls");
    expect(markup).toContain("Write-up");
    expect(markup).toContain("Transcript");
  });

  test("the trace tab draws the tree, held steps and all", () => {
    const markup = drawn(detail("vendor-reconciliation"), "Trace");
    expect(markup).toContain("reconcile.match_invoices");
    expect(markup).toContain("Ferris — held per instruction");
    expect(markup).toContain("Amber steps are held on purpose, not broken.");
  });

  test("the logs tab prints to the millisecond", () => {
    const markup = drawn(detail("vendor-reconciliation"), "Logs");
    expect(markup).toContain("06:12:04.221");
    expect(markup).toContain("12 of 12 lines");
  });

  test("nothing here claims a write path it does not have", () => {
    // A design workflow: runs on the record and no code behind it. Run is drawn
    // and disabled rather than absent, so the row does not quietly lose a
    // control the real ones have.
    expect(detail("calendar-tidy").runnable).toBe(false);
    expect(drawn(detail("calendar-tidy"), "Summary")).toMatch(/<button[^>]*disabled[^>]*>Run<\/button>/);
    // A run under way says so on the button rather than offering a second one.
    const running = drawn(detail("vendor-reconciliation"), "Summary");
    expect(running).toMatch(/<button[^>]*disabled[^>]*>Running<\/button>/);
    // Stopping one is live, and only offered while there is something to stop.
    expect(running).toMatch(/<button[^>]*>Kill run<\/button>/);
    expect(running).not.toMatch(/<button[^>]*disabled[^>]*>Kill run<\/button>/);
    expect(drawn(detail("calendar-tidy"), "Summary")).not.toContain("Kill run");
  });

  test("a change in flight holds every control that would race it", () => {
    const busy = renderToStaticMarkup(
      <WorkflowDetail
        workflow={detail("vendor-reconciliation")}
        tab="Summary"
        onTab={noop}
        paused={false}
        onTogglePause={noop}
        onBack={noop}
        onInvoke={noop}
        trigger={IDLE}
        edits={{ busy: true, error: null, onStop: noop, onInstructions: noop }}
      />,
    );
    expect(busy).toMatch(/<button[^>]*disabled[^>]*>Stopping…<\/button>/);
    expect(busy).toMatch(/<button[^>]*disabled[^>]*>Pause<\/button>/);
  });

  test("a refused change is said beside the controls it came from", () => {
    const markup = renderToStaticMarkup(
      <WorkflowDetail
        workflow={detail("vendor-reconciliation")}
        tab="Summary"
        onTab={noop}
        paused={false}
        onTogglePause={noop}
        onBack={noop}
        onInvoke={noop}
        trigger={IDLE}
        edits={{ busy: false, error: "Nothing to stop — it isn't running.", onStop: noop, onInstructions: noop }}
      />,
    );
    expect(markup).toContain("That didn&#x27;t take.");
    expect(markup).toContain("Nothing to stop");
  });

  test("the standing rule can be rewritten, and says what clearing it means", () => {
    const markup = drawn(detail("vendor-reconciliation"), "Summary");
    expect(markup).toMatch(/<button[^>]*>Edit instructions<\/button>/);
    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>Edit instructions<\/button>/);
    // One with no rule asks for one rather than reporting its absence twice.
    expect(drawn(detail("calendar-tidy"), "Summary")).toContain("Give me a rule");
  });

  test("and no row on the table offers to start one", () => {
    expect(list.rows.every((row) => !row.runnable)).toBe(true);
  });

  test("a workflow that has never run says so on every tab", () => {
    const paused = detail("job-listings-sweep");
    for (const tab of ["Executions", "Trace", "Logs"]) {
      expect(drawn(paused, tab)).toContain("No run recorded for this workflow yet.");
    }
    // And it is still a page: the name, the pause and the summary are all there.
    const summary = drawn(paused, "Summary");
    expect(summary).toContain("Job listings sweep");
    expect(summary).toContain("You paused this on Aug 9");
  });
});

/**
 * The other half of this table: the workflows this service can actually run.
 *
 * Synced into the same database the fixtures are in, because that is what the
 * product does — the design's rows and the real ones share the surface, and the
 * difference between them has to read on screen rather than in a comment.
 */
describe("a workflow with code behind it", () => {
  let runnable: WorkflowDetailPayload;

  beforeAll(() => {
    syncWorkflowCatalog(db, MORNING);
    const found = loadWorkflow(db, "safety-classification", MORNING);
    if (!found) throw new Error("the catalog did not reach the database");
    runnable = found;
  });

  test("offers Run, and says what it is for before it has ever run", () => {
    const markup = drawn(runnable, "Summary");
    expect(runnable.runnable).toBe(true);
    expect(markup).toMatch(/<button[^>]*>Run<\/button>/);
    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>Run<\/button>/);
    expect(markup).toContain("Chunk a piece of text");
  });

  test("arriving from the table's Run draws the form, one field per argument", () => {
    const markup = drawn(runnable, "Summary", IDLE, true);
    expect(markup).toContain("Run this now");
    expect(markup).toContain("Text to screen");
    expect(markup).toContain("Words per chunk");
    // Prefilled with what the server would have fallen back to anyway.
    expect(markup).toContain('value="40"');
    expect(markup).toMatch(/<button[^>]*>Run it<\/button>/);
  });

  test("a refusal is put in front of you rather than swallowed", () => {
    const refused = { ...IDLE, error: "give me something to screen" };
    expect(drawn(runnable, "Summary", refused)).toContain("I couldn&#x27;t start it.");
    // Inside the form while it is open, so the field it is about is still there.
    const inForm = drawn(runnable, "Summary", refused, true);
    expect(inForm).toContain("give me something to screen");
    expect(inForm).toContain("Text to screen");
  });

  test("joins the table beside the design's rows, marked runnable", () => {
    const after = loadWorkflows(db, MORNING);
    const markup = renderToStaticMarkup(
      <WorkflowsView workflows={after} busy={false} error={null} onTogglePause={noop} onOpen={noop} onRun={noop} />,
    );
    // The row's controls only appear under the pointer, so what is checked here
    // is the flag they are drawn from and the row itself.
    expect(after.rows.filter((row) => row.runnable).map((row) => row.slug).sort()).toEqual([
      "message-extraction",
      "safety-classification",
      "screenshot-classification",
      "screenshot-ingestion",
      "weather-briefing",
    ]);
    expect(markup).toContain("Prompt-injection screen");
    expect(markup).toContain("Never run");
    // And the fixtures are still there — this is additive, not a replacement.
    expect(markup).toContain("Q3 vendor reconciliation");
  });
});
