// The whole path in one test: the mutations → SQLite → the recommendation
// queries → the components the design specifies. It renders the real payload,
// so a column renamed on the server or a prop dropped in the kit fails here
// rather than in a browser.
//
// The rows are written rather than seeded, because the seed writes none: the
// Recommendations table is the agent's to fill at runtime. What is transcribed
// from the design is the content, so the assertions can still be read against
// the boards.
//
// Evidence is only checked as far as the wiring goes. Its rendering has one
// shape across the product and reminders.render.test.tsx already draws it
// through every branch; what belongs here is that a suggestion's citations
// reach the section under it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createDb, runMigrations, type Db } from "../../../src/db";
import * as s from "../../../src/db/schema";
import {
  loadRecommendation,
  loadRecommendations,
  type RecommendationDetailPayload,
  type RecommendationsPayload,
} from "../../../src/db/queries/recommendations";
import {
  answerRecommendation,
  citeForRecommendation,
  proposeRecommendation,
} from "../../../src/db/mutations/recommendations";
import { seedDesignFixtures } from "../../../src/db/seed/design";
import { zonedTime } from "../../../src/db/seed/time";
import { RecommendationDetail } from "./RecommendationDetail";
import { RecommendationsView, type LocalStance } from "./RecommendationsView";

let dir: string;
let db: Db;
let list: RecommendationsPayload;

const MORNING = zonedTime(2026, 8, 25, 9, 20);
const at = (day: number, hour: number, minute = 0) => zonedTime(2026, 8, day, hour, minute);
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
  // For the screen's own line above the list, and for a conversation to cite.
  seedDesignFixtures(db, { now: MORNING });

  const spendFloor = proposeRecommendation(db, {
    title: "Let me settle vendor differences under £50 myself",
    blurb:
      "I asked you about fourteen of these last quarter and you approved every one. I stopped short of a rule because you never gave me one.",
    confidence: "strong",
    prose: [
      "Every reconciliation run this quarter turned up a handful of differences small enough that the answer never changed. I brought fourteen of them to you and you approved fourteen.",
      "I could have inferred a threshold from that and started acting on it. I didn't, because a spend rule is yours to write, not mine to assume.",
    ],
    restraint:
      "I did not apply this while waiting. The four differences from this morning's run are still sitting unresolved.",
    basisLabel: "14 approvals · 0 rejections",
    scopeLabel: "Vendor reconciliation",
    scopeOkfUri: "okf:policy/spend-floor",
    from: "6 runs",
    effect: [
      ["Questions I'd stop asking", "roughly 12 a quarter"],
      ["Money in scope", "£50 per line, £600 seen"],
    ],
    affirm: "Set the floor at £50",
    quiet: "Keep asking me",
    formedAt: at(25, 6, 40),
  });

  // Any conversation will do: what this checks is that the citation reaches the
  // section, and that the words on the link win over the source's own name.
  const [conversation] = db.select({ id: s.conversations.id }).from(s.conversations).limit(1).all();
  citeForRecommendation(
    db,
    spendFloor,
    [
      {
        sourceId: conversation?.id ?? "",
        title: "The fourteenth approval",
        why: "It's the clearest statement that the amount, not the vendor, is what you're deciding on.",
      },
    ],
    {},
    MORNING,
  );

  proposeRecommendation(db, {
    title: "Move inbox triage to 05:30 on Tuesdays",
    blurb: "Your Tuesday standup notes land at 05:45, so the six o'clock run reads them a week late.",
    confidence: "strong",
    basisLabel: "7 runs missed the notes",
    scopeOkfUri: "okf:task/inbox-triage",
    affirm: "Shift Tuesdays to 05:30",
    quiet: "Leave the schedule",
    formedAt: at(25, 6, 12),
  });

  proposeRecommendation(db, {
    title: "Stop drafting replies to Ferrier Row",
    blurb: "You rewrote my last five drafts to that address almost entirely.",
    basisLabel: "5 drafts, 5 rewritten",
    scopeOkfUri: "okf:contact/ferrier-row",
    affirm: "Hand me the thread instead",
    quiet: "Keep drafting",
    formedAt: at(24, 14, 20),
  });

  const adopted = proposeRecommendation(db, {
    title: "Group quarter-boundary differences rather than asking per invoice",
    blurb: "You took this one in August. I've held it since.",
    confidence: "strong",
    prose: ["You took this after a run that asked you nineteen separate questions about the same quarter boundary."],
    effect: [["Runs under it", "6"]],
    affirm: "Keep it",
    quiet: "Drop the rule",
    formedAt: at(9, 6, 12),
  });
  answerRecommendation(db, adopted, "adopted", { basisLabel: "6 runs since" }, at(12, 9, 2));

  const declined = proposeRecommendation(db, {
    title: "Send the weekly digest without waiting for the finance source",
    blurb: "You said no, and said why: a partial digest reads as a complete one.",
    affirm: "Send it anyway",
    quiet: "Keep stopping",
    formedAt: at(1, 21, 30),
  });
  answerRecommendation(db, declined, "declined", {}, at(4, 21, 14));

  // One sentence and no account of itself, so the detail draws the sections it
  // has and nothing else.
  proposeRecommendation(db, {
    title: "Move the Thursday standup to Friday",
    blurb: "You've moved the Thursday standup three weeks running. Want me to shift it to Friday for good?",
    basisLabel: "three weeks of moves",
    affirm: "Do it",
    quiet: "Dismiss",
    formedAt: MORNING,
  });

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

  test("what it was formed from is titled by the citation, not by the source", () => {
    const html = detailMarkup("Let me settle");
    expect(html).toContain("What I formed it from");
    // The link's own title wins: a source is cited as the part of it that
    // mattered, which is usually not what the source calls itself.
    expect(html).toContain("The fourteenth approval");
    // …and the row still describes the source it points at.
    expect(html).toContain("direct chat with me");
    // Why it was kept is drawn when the row is opened, which static markup does
    // not reach; reminders.render.test.tsx opens one.
    expect(detail("Let me settle").evidence[0]?.why).toStartWith("It's the clearest statement");
  });

  test("a suggestion with nothing cited draws no evidence section at all", () => {
    expect(detailMarkup("Move inbox triage")).not.toContain("What I formed it from");
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

  test("the aside's card has one sentence and draws only the sections it has", () => {
    const html = detailMarkup("Move the Thursday");
    expect(html).toContain("Move the Thursday standup to Friday");
    expect(html).not.toContain("What changes if you say yes");
    expect(html).not.toContain("Where I stopped");
    expect(html).not.toContain("What I formed it from");
  });
});
