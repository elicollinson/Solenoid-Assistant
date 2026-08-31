// The whole path in one test: design fixtures → SQLite → the home query → the
// components the design specifies. It renders the real payload, so a column
// renamed on the server or a prop dropped in the kit fails here rather than in
// a browser.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createDb, runMigrations, type Db } from "../../../src/db";
import { loadHome, type HomePayload } from "../../../src/db/queries/home";
import { proposeRecommendation } from "../../../src/db/mutations/recommendations";
import { seedDesignFixtures } from "../../../src/db/seed/design";
import { zonedTime } from "../../../src/db/seed/time";
import { ActivityView } from "./ActivityView";
import { AgentAside } from "./AgentAside";
import { AgentRail } from "./AgentRail";
import { withoutResolved } from "./settle";

let dir: string;
let db: Db;
let home: HomePayload;

const MORNING = zonedTime(2026, 8, 25, 9, 20);
const NOTHING = new Set<string>();
const noop = () => {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-render-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  seedDesignFixtures(db, { now: MORNING });
  // The aside's third section is the newest open suggestion. The seed writes no
  // recommendations — that table is the agent's to fill at runtime — so one is
  // written here the way the agent writes it.
  proposeRecommendation(
    db,
    {
      title: "Move the Thursday standup to Friday",
      blurb: "You've moved the Thursday standup three weeks running. Want me to shift it to Friday for good?",
      basisLabel: "three weeks of moves",
      affirm: "Do it",
      quiet: "Dismiss",
    },
    MORNING,
  );
  home = loadHome(db, MORNING);
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the activity feed renders what the design draws", () => {
  const html = () => renderToStaticMarkup(
    <ActivityView header={home.header} sections={home.sections} resolved={NOTHING} onInvoke={noop} />,
  );

  test("the header, the filters and every entry", () => {
    const markup = html();
    expect(markup).toContain("Good morning, Eli");
    expect(markup).toContain("Two need a word from you before I go further.");
    for (const filter of ["All", "Needs you", "Running"]) expect(markup).toContain(filter);
    expect(markup).toContain("This morning");
    expect(markup).toContain("Yesterday");
    expect(markup).toContain("Reply to the Ferris contract amendment");
    expect(markup).toContain("Weekly digest stopped halfway");
  });

  test("the gate reads as buttons and the plain affordances as links", () => {
    const markup = html();
    expect(markup).toContain("<button");
    expect(markup).toMatch(/<button[^>]*>Send it<\/button>/);
    // "Open workflow" belongs to a running entry with no decision behind it.
    expect(markup).toMatch(/<a [^>]*>Open workflow<\/a>/);
  });

  test("the running entry carries a meter and the collapsed tool calls", () => {
    const markup = html();
    expect(markup).toContain("running · step 6/11");
    expect(markup).toContain("4 tool calls · gmail.draft, memory.read ×2, calendar.check");
    // Collapsed by default: the calls themselves are not in the markup yet.
    expect(markup).not.toContain("okf:vendor/ferris-terms");
  });

  test("the attention state paints the alert plane, not the raised one", () => {
    const markup = html();
    expect(markup).toContain("var(--surface-alert)");
    expect(markup).toContain("var(--signal-amber)");
  });

  test("closing a gate recounts the header and clears it from the aside", () => {
    const decisionId = home.sections.flatMap((s) => s.items).find((i) => i.decisionId)?.decisionId;
    const shown = withoutResolved(home, new Set([decisionId!]));
    expect(home.header.lede).toContain("Two need a word from you before I go further.");
    expect(shown.header.lede).toContain("One needs a word from you before I go further.");
    // The agent's own line in front of the count is left exactly as written.
    expect(shown.header.lede).toContain("I handled nine things overnight.");
    expect(shown.aside.waiting.length).toBe(home.aside.waiting.length - 1);
  });

  test("closing the last gate leaves nothing to say rather than a zero", () => {
    const all = new Set(home.aside.waiting.map((w) => w.id));
    expect(withoutResolved(home, all).header.lede).toContain("Nothing needs you right now.");
  });

  test("a resolved gate reads as done and says nothing was sent", () => {
    const decisionId = home.sections.flatMap((s) => s.items).find((i) => i.decisionId)?.decisionId;
    expect(decisionId).toBeTruthy();
    const markup = renderToStaticMarkup(
      <ActivityView header={home.header} sections={home.sections} resolved={new Set([decisionId!])} onInvoke={noop} />,
    );
    expect(markup).toContain("resolved locally · no write path yet");
    expect(markup).not.toMatch(/<button[^>]*>Send it<\/button>/);
  });
});

describe("the rail and the aside", () => {
  test("the rail names the product and carries the derived counts", () => {
    const markup = renderToStaticMarkup(
      <AgentRail rail={home.rail} selected="Activity" onSelect={noop} theme="paper" onToggleTheme={noop} />,
    );
    expect(markup).toContain("Solenoid");
    expect(markup).not.toContain("Bramble");
    expect(markup).toContain("Working on one thing");
    expect(markup).toContain("Stop everything");
    for (const label of ["Activity", "Calendar", "Reminders", "Things I know", "Recommendations", "Workflows"]) {
      expect(markup).toContain(label);
    }
  });

  test("the aside carries all three of its sections", () => {
    const markup = renderToStaticMarkup(<AgentAside aside={home.aside} onInvoke={noop} />);
    expect(markup).toContain("Waiting on you");
    expect(markup).toContain("Approve the Ferris contract reply");
    expect(markup).toContain("Next up");
    // "Next up" reads the calendar, so this is the first thing genuinely on it.
    expect(markup).toContain("Latham quarter review, Room 2 · four people");
    expect(markup).toContain("Worth a look");
    expect(markup).toContain("Want me to shift it to Friday for good?");
  });

  test("an empty aside says so in the agent's voice rather than rendering blank", () => {
    const markup = renderToStaticMarkup(
      <AgentAside aside={{ waiting: [], nextUp: [], worthALook: null }} onInvoke={noop} />,
    );
    expect(markup).toContain("Nothing right now.");
    expect(markup).toContain("The rest of the day is clear.");
  });
});
