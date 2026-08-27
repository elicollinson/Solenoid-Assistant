// The whole path in one test: design fixtures → SQLite → the recommendation
// queries → the components the design specifies. It renders the real payload,
// so a column renamed on the server or a prop dropped in the kit fails here
// rather than in a browser.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createDb, runMigrations, type Db } from "../../../src/db";
import {
  loadRecommendation,
  loadRecommendations,
  type RecommendationDetailPayload,
  type RecommendationsPayload,
} from "../../../src/db/queries/recommendations";
import { seedDesignFixtures } from "../../../src/db/seed/design";
import { zonedTime } from "../../../src/db/seed/time";
import { RecommendationDetail } from "./RecommendationDetail";
import { RecommendationsView, type LocalStance } from "./RecommendationsView";

let dir: string;
let db: Db;
let list: RecommendationsPayload;

const MORNING = zonedTime(2026, 8, 25, 9, 20);
const NO_STANCES = new Map<string, LocalStance>();
const noop = () => {};

const idOf = (title: string) => {
  const found = list.rows.find((r) => r.title.startsWith(title));
  if (!found) throw new Error(`no recommendation starting "${title}"`);
  return found.id;
};

const detail = (title: string): RecommendationDetailPayload => {
  const one = loadRecommendation(db, idOf(title), MORNING);
  if (!one) throw new Error(`recommendation "${title}" did not load`);
  return one;
};

const listMarkup = (stances: ReadonlyMap<string, LocalStance> = NO_STANCES) =>
  renderToStaticMarkup(
    <RecommendationsView recommendations={list} stances={stances} onAnswer={noop} onOpen={noop} />,
  );

const detailMarkup = (title: string, stance?: LocalStance) =>
  renderToStaticMarkup(
    <RecommendationDetail recommendation={detail(title)} stance={stance} onAnswer={noop} onBack={noop} />,
  );

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-recommendations-render-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  seedDesignFixtures(db, { now: MORNING });
  list = loadRecommendations(db, MORNING);
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the list", () => {
  test("draws the header, the counted lede and the four filters", () => {
    const html = listMarkup();
    expect(html).toContain("Recommendations");
    expect(html).toContain("Four are waiting on you, and I haven&#x27;t acted on any of them.");
    for (const filter of ["All", "Waiting on you", "Standing", "Set aside"]) expect(html).toContain(filter);
  });

  test("draws a heading for each shelf that has something on it", () => {
    const html = listMarkup();
    for (const shelf of ["Waiting on you", "Standing", "Set aside"]) expect(html).toContain(shelf);
  });

  test("each row carries its line, what it rests on and when", () => {
    const html = listMarkup();
    expect(html).toContain("Let me settle vendor differences under £50 myself");
    expect(html).toContain("I stopped short of a rule because you never gave me one.");
    expect(html).toContain("14 approvals · 0 rejections");
    expect(html).toContain("Today 06:40");
  });

  test("only what is being asked is badged; what is settled says where it stands", () => {
    const html = listMarkup();
    expect(html.match(/needs you/g)?.length).toBe(4);
    expect(html).toContain("in force");
    expect(html).toContain("set aside");
  });

  test("a row offers the agent's own words to agree with, and one word to decline", () => {
    const html = listMarkup();
    expect(html).toContain("Set the floor at £50");
    expect(html).toContain("Shift Tuesdays to 05:30");
    // There is one line for both, and the affirm is the one carrying what you
    // would be agreeing to. What I would do instead gets said in the detail.
    expect(html).not.toContain("Keep asking me");
    expect(html.match(/>No</g)?.length).toBe(4);
  });

  test("taking one in the browser moves it and restates it", () => {
    const html = listMarkup(new Map([[idOf("Let me settle"), "adopted"]]));
    expect(html).toContain("You took this just now. I&#x27;ll hold to it from the next run and say so when it first applies.");
    expect(html).not.toContain("Set the floor at £50");
    expect(html).toContain("Just now");
  });

  test("answering one recounts the sentence that counted them", () => {
    expect(listMarkup()).toContain("Four are waiting on you");
    const one = listMarkup(new Map([[idOf("Let me settle"), "adopted"]]));
    expect(one).toContain("Three are waiting on you, and I haven&#x27;t acted on any of them.");
    // The agent's own line in front of the count is left exactly as written.
    expect(one).toContain("Changes I&#x27;d make to how I work, drawn from what I&#x27;ve watched.");
  });

  test("turning one down sets it aside rather than dropping it off the list", () => {
    const html = listMarkup(new Map([[idOf("Move inbox triage"), "declined"]]));
    expect(html).toContain("You said no. I&#x27;ve set it aside and won&#x27;t raise it again unless what I&#x27;m seeing changes.");
    expect(html).not.toContain("Shift Tuesdays to 05:30");
    expect(html).toContain("Move inbox triage to 05:30 on Tuesdays");
  });
});

describe("one suggestion", () => {
  test("draws the header, the state word and the mono line under it", () => {
    const html = detailMarkup("Let me settle");
    expect(html).toContain("← Recommendations");
    expect(html).toContain("needs you");
    expect(html).toContain("okf:policy/spend-floor");
    expect(html).toContain("today 06:40");
  });

  test("draws every paragraph of what it noticed", () => {
    const html = detailMarkup("Let me settle");
    expect(html).toContain("What I noticed");
    expect(html).toContain("I brought fourteen of them to you and you approved fourteen.");
    expect(html).toContain("a spend rule is yours to write, not mine to assume");
  });

  test("the ask is a panel, and it says what the agent held back from doing", () => {
    const html = detailMarkup("Let me settle");
    expect(html).toContain("This is the permission I&#x27;m asking for");
    expect(html).toContain("The four differences from this morning&#x27;s run are still sitting unresolved.");
    // The same sentence heads the aside, because it is the same restraint.
    expect(html).toContain("Where I stopped");
  });

  test("what would change is a table, and the pairs sit in the aside", () => {
    const html = detailMarkup("Let me settle");
    expect(html).toContain("What changes if you say yes");
    expect(html).toContain("Money in scope");
    expect(html).toContain("£50 per line, £600 seen");
    expect(html).toContain("This suggestion");
    expect(html).toContain("6 runs");
    expect(html).toContain("Vendor reconciliation");
  });

  test("what it was formed from names each artifact and why it was kept", () => {
    const html = detailMarkup("Let me settle");
    expect(html).toContain("What I formed it from");
    expect(html).toContain("The fourteenth approval");
    expect(html).toContain("Approvals ledger, this quarter");
    expect(html).toContain("3 messages · 1 pinned");
  });

  test("putting it off would have to write a date, so it is shown disabled", () => {
    const html = detailMarkup("Let me settle");
    expect(html).toContain("Ask me again later");
    expect(html.match(/disabled=""/g)?.length).toBe(1);
  });

  test("a settled one offers the way back rather than two more decisions", () => {
    const html = detailMarkup("Group quarter-boundary");
    expect(html).toContain("Back to the list");
    expect(html).toContain("in force");
    expect(html).toContain("What changed");
    expect(html).not.toContain("This is the permission I&#x27;m asking for");
  });

  test("answering it in the browser reads through the whole header", () => {
    const html = detailMarkup("Let me settle", "adopted");
    expect(html).toContain("Back to the list");
    expect(html).toContain("in force");
    expect(html).not.toContain("This is the permission I&#x27;m asking for");
  });

  test("the aside's card has one sentence and draws no empty sections", () => {
    const html = detailMarkup("Move the Thursday");
    expect(html).toContain("Move the Thursday standup to Friday");
    expect(html).toContain("What I noticed");
    expect(html).not.toContain("What changes if you say yes");
    expect(html).not.toContain("Where I stopped");
    expect(html).not.toContain("What I formed it from");
  });
});
