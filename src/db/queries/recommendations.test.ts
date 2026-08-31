// The Recommendations surface, checked against the design it came from.
//
// The design stores each suggestion's shelf ("Waiting on you"), its mark, the
// word for how sure the agent is ("In force"), its when ("Aug 11") and the
// header's count as display strings. Every one of those falls out of two
// columns here — the status and the date you answered it — so what is worth
// guarding is that the derivation lands where the design says, and that it
// moves when the answer does.
//
// The rows are written through ../mutations/recommendations.ts rather than
// seeded, because that is how they arrive in the running product: the seed
// leaves this table empty on purpose. The suggestions below are transcribed
// from the design's own fixtures so the assertions can still be read against
// the boards, but they are built the way the agent builds them.
import { Elysia } from "elysia";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, type Db } from "../index";
import { createUiRoutes } from "../../http/routes/ui";
import { loadHome } from "./home";
import {
  loadRecommendation,
  loadRecommendations,
  type RecommendationDetailPayload,
  type RecommendationsPayload,
} from "./recommendations";
import { answerRecommendation, proposeRecommendation } from "../mutations/recommendations";
import { seedDesignFixtures } from "../seed/design";
import { zonedTime } from "../seed/time";

let dir: string;
let db: Db;
let list: RecommendationsPayload;

// The same fixed morning the home, workflow and reminder tests use.
const MORNING = zonedTime(2026, 8, 25, 9, 20);
const at = (day: number, hour: number, minute = 0) => zonedTime(2026, 8, day, hour, minute);

const row = (title: string) => list.rows.find((r) => r.title.startsWith(title));

const detail = (title: string): RecommendationDetailPayload => {
  const found = row(title);
  if (!found) throw new Error(`no recommendation starting "${title}"`);
  const one = loadRecommendation(db, found.id, MORNING);
  if (!one) throw new Error(`recommendation ${found.id} did not load`);
  return one;
};

/**
 * Six suggestions across the three shelves, written the way the agent writes
 * them: every one is proposed first, and the two settled ones are settled by
 * being answered. There is no way to insert a row that was born adopted, which
 * is the point — "Standing" means somebody said yes to it.
 */
function write(): void {
  proposeRecommendation(db, {
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
    basisCount: 14,
    basisRunCount: 6,
    scopeLabel: "Vendor reconciliation",
    scopeOkfUri: "okf:policy/spend-floor",
    from: "6 runs",
    effect: [
      ["Questions I'd stop asking", "roughly 12 a quarter"],
      ["Money in scope", "£50 per line, £600 seen"],
      ["What I'd still bring you", "anything Ferris, at any amount"],
    ],
    affirm: "Set the floor at £50",
    quiet: "Keep asking me",
    formedAt: at(25, 6, 40),
  });

  proposeRecommendation(db, {
    title: "Move inbox triage to 05:30 on Tuesdays",
    blurb: "Your Tuesday standup notes land at 05:45, so the six o'clock run reads them a week late.",
    confidence: "strong",
    basisLabel: "7 runs missed the notes",
    scopeLabel: "Scheduled workflow",
    scopeOkfUri: "okf:task/inbox-triage",
    from: "7 runs",
    affirm: "Shift Tuesdays to 05:30",
    quiet: "Leave the schedule",
    formedAt: at(25, 6, 12),
  });

  proposeRecommendation(db, {
    title: "Stop drafting replies to Ferrier Row",
    blurb: "You rewrote my last five drafts to that address almost entirely.",
    confidence: "worth_a_look",
    basisLabel: "5 drafts, 5 rewritten",
    scopeLabel: "One contact",
    scopeOkfUri: "okf:contact/ferrier-row",
    from: "5 drafts",
    affirm: "Hand me the thread instead",
    quiet: "Keep drafting",
    formedAt: at(24, 14, 20),
  });

  const adopted = proposeRecommendation(db, {
    title: "Group quarter-boundary differences rather than asking per invoice",
    blurb: "You took this one in August. I've held it since.",
    confidence: "strong",
    prose: ["You took this after a run that asked you nineteen separate questions about the same quarter boundary."],
    scopeLabel: "Vendor reconciliation",
    scopeOkfUri: "okf:policy/quarter-boundary",
    from: "4 runs",
    effect: [["Runs under it", "6"]],
    affirm: "Keep it",
    quiet: "Drop the rule",
    formedAt: at(9, 6, 12),
  });
  answerRecommendation(db, adopted, "adopted", { basisLabel: "6 runs since" }, at(12, 9, 2));

  const declined = proposeRecommendation(db, {
    title: "Send the weekly digest without waiting for the finance source",
    blurb: "You said no, and said why: a partial digest reads as a complete one.",
    confidence: "worth_a_look",
    scopeLabel: "Weekly digest",
    scopeOkfUri: "okf:task/weekly-digest",
    from: "3 runs",
    affirm: "Send it anyway",
    quiet: "Keep stopping",
    reRaiseCondition: "I won't raise this again unless the finance source starts failing every week.",
    formedAt: at(1, 21, 30),
  });
  answerRecommendation(db, declined, "declined", {}, at(4, 21, 14));

  // The newest, and so the one the Activity aside draws as its card.
  proposeRecommendation(db, {
    title: "Move the Thursday standup to Friday",
    blurb: "You've moved the Thursday standup three weeks running. Want me to shift it to Friday for good?",
    basisLabel: "three weeks of moves",
    basisCount: 3,
    affirm: "Do it",
    quiet: "Dismiss",
    formedAt: MORNING,
  });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-recommendations-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  // For the screen's lede and the rest of the home payload the last two tests
  // read. The seed writes no recommendations of its own.
  seedDesignFixtures(db, { now: MORNING });
  write();
  list = loadRecommendations(db, MORNING);
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the list", () => {
  test("the seed writes none of these — the table starts empty", () => {
    const empty = createDb(":memory:");
    runMigrations(empty);
    seedDesignFixtures(empty, { now: MORNING });
    expect(loadRecommendations(empty, MORNING).rows).toEqual([]);
    // The screen still has its opening sentence; only the rows under it are the
    // agent's to write.
    expect(loadRecommendations(empty, MORNING).lede).toBe(
      "Changes I'd make to how I work, drawn from what I've watched. Nothing is waiting on you right now.",
    );
    empty.$client.close();
  });

  test("is shelved by status and ordered newest movement first inside each shelf", () => {
    expect(list.rows.map((r) => [r.group, r.title])).toEqual([
      ["Waiting on you", "Move the Thursday standup to Friday"],
      ["Waiting on you", "Let me settle vendor differences under £50 myself"],
      ["Waiting on you", "Move inbox triage to 05:30 on Tuesdays"],
      ["Waiting on you", "Stop drafting replies to Ferrier Row"],
      ["Standing", "Group quarter-boundary differences rather than asking per invoice"],
      ["Set aside", "Send the weekly digest without waiting for the finance source"],
    ]);
  });

  test("the lede is the agent's line and then a count of what is yours to answer", () => {
    expect(list.lede).toBe(
      "Changes I'd make to how I work, drawn from what I've watched. Four are waiting on you, and I haven't acted on any of them.",
    );
  });

  test("the mark keeps apart what is in force, what you turned down and what is being asked", () => {
    expect(row("Let me settle")?.state).toBe("attention");
    expect(row("Group quarter")?.state).toBe("done");
    expect(row("Send the weekly")?.state).toBe("idle");
  });

  test("each row carries its line and what it rests on", () => {
    const spend = row("Let me settle");
    expect(spend?.blurb).toStartWith("I asked you about fourteen of these last quarter");
    expect(spend?.basis).toBe("14 approvals · 0 rejections");
  });

  test("an open one is dated to the minute; an answered one to the day", () => {
    expect(row("Let me settle")?.when).toBe("Today 06:40");
    expect(row("Group quarter")?.when).toBe("Aug 12");
    expect(row("Send the weekly")?.when).toBe("Aug 4");
  });

  test("what it rests on gains your answer and its date once you have given one", () => {
    expect(row("Group quarter")?.basis).toBe("adopted aug 12 · 6 runs since");
    // Nothing was counted for the declined one, so only the answer is said.
    expect(row("Send the weekly")?.basis).toBe("declined aug 4");
  });

  test("only what is still being asked carries buttons, and they are the agent's words", () => {
    expect(row("Let me settle")?.actions.map((a) => [a.label, a.stance])).toEqual([
      ["Set the floor at £50", "affirm"],
      ["Keep asking me", "quiet"],
    ]);
    // The words survive on the object; sending them to a settled row is how one
    // ends up offering to settle something already settled.
    expect(row("Group quarter")?.actions).toEqual([]);
    expect(row("Send the weekly")?.actions).toEqual([]);
  });

  test("a suggestion names the rule it would become", () => {
    expect(row("Let me settle")?.scope).toBe("okf:policy/spend-floor");
    expect(row("Stop drafting")?.scope).toBe("okf:contact/ferrier-row");
  });
});

describe("one suggestion", () => {
  test("the account is read as written, paragraph by paragraph", () => {
    const one = detail("Let me settle");
    expect(one.prose.length).toBe(2);
    expect(one.prose[0]).toStartWith("Every reconciliation run this quarter");
    expect(one.prose[1]).toStartWith("I could have inferred a threshold");
  });

  test("where it stopped short is the permission it is asking for", () => {
    expect(detail("Let me settle").restraint).toStartWith("I did not apply this while waiting.");
  });

  test("what would change is authored — it counts runs and pounds that have not happened", () => {
    expect(detail("Let me settle").effect).toEqual([
      { label: "Questions I'd stop asking", value: "roughly 12 a quarter" },
      { label: "Money in scope", value: "£50 per line, £600 seen" },
      { label: "What I'd still bring you", value: "anything Ferris, at any amount" },
    ]);
  });

  test("three of the four pairs are readings of columns; the fourth keeps its own unit", () => {
    expect(detail("Let me settle").meta).toEqual([
      { label: "Formed", value: "Today 06:40" },
      // Five drafts is not five runs, so this one is stored rather than derived.
      { label: "From", value: "6 runs" },
      { label: "Confidence", value: "Strong" },
      { label: "Scope", value: "Vendor reconciliation" },
    ]);
  });

  test("once you have answered, the first pair is your answer and so is the confidence", () => {
    const one = detail("Group quarter");
    expect(one.meta[0]).toEqual({ label: "Adopted", value: "Aug 12, 09:02" });
    // Not "Strong" any more: a suggestion you took is in force, whatever the
    // agent thought of its odds beforehand.
    expect(one.meta.find((p) => p.label === "Confidence")?.value).toBe("In force");
    expect(detail("Send the weekly").meta.find((p) => p.label === "Confidence")?.value).toBe("Declined");
  });

  test("a settled one has nothing left to ask for", () => {
    const one = detail("Send the weekly");
    expect(one.actions).toEqual([]);
    expect(one.state).toBe("idle");
  });

  test("one written with nothing but a title still loads, drawing only what it has", () => {
    // Formed before the standup one, so it does not displace it as the card the
    // Activity aside draws — that is the newest, and this is a test fixture.
    const bare = proposeRecommendation(db, {
      title: "Read the overnight mail before the six o'clock sweep",
      formedAt: at(25, 5, 0),
    });
    const one = loadRecommendation(db, bare, MORNING);
    expect(one?.prose).toEqual([]);
    expect(one?.restraint).toBeNull();
    expect(one?.effect).toEqual([]);
    expect(one?.actions).toEqual([]);
    expect(one?.blurb).toBe("");
    expect(one?.meta).toEqual([
      { label: "Formed", value: "Today 05:00" },
      { label: "Confidence", value: "Worth a look" },
    ]);
  });
});

describe("the home surface", () => {
  test("the rail counts what is still being asked, not what is held", () => {
    const { rail } = loadHome(db, MORNING);
    const item = rail.groups.flatMap((g) => g.items).find((i) => i.label === "Recommendations");
    // Four proposed, plus the bare one the test above wrote. The two answered
    // ones stopped counting the moment they were answered.
    expect(item?.count).toBe(5);
  });

  test("worth a look is the newest suggestion, with its two words", () => {
    const { aside } = loadHome(db, MORNING);
    expect(aside.worthALook?.body).toBe(
      "You've moved the Thursday standup three weeks running. Want me to shift it to Friday for good?",
    );
    expect(aside.worthALook?.actions.map((a) => a.label)).toEqual(["Do it", "Dismiss"]);
  });

  test("a recommendation is not also listed under what needs you", () => {
    // Home draws one as its own card, so its decision is filtered out of the
    // aside's list rather than being asked about in two places at once.
    const { aside } = loadHome(db, MORNING);
    expect(aside.waiting.every((w) => !w.title.startsWith("Move the Thursday"))).toBe(true);
  });
});

describe("the route", () => {
  test("GET /api/recommendations answers with the list", async () => {
    const app = new Elysia().use(createUiRoutes(() => db));
    const response = await app.handle(new Request("http://localhost/api/recommendations"));
    expect(response.status).toBe(200);
    expect((await response.json()) as RecommendationsPayload).toHaveProperty("rows");
  });

  test("GET /api/recommendations/:id answers 404 for one that isn't there", async () => {
    const app = new Elysia().use(createUiRoutes(() => db));
    const response = await app.handle(new Request("http://localhost/api/recommendations/nope"));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("No recommendation with id nope");
  });

  test("POST /api/recommendations/:id/answer writes it down and reads back settled", async () => {
    const app = new Elysia().use(createUiRoutes(() => db));
    const id = proposeRecommendation(db, { title: "Stop retrying the finance source twice" }, MORNING);
    const answer = (stance: string) =>
      app.handle(
        new Request(`http://localhost/api/recommendations/${id}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stance }),
        }),
      );

    const first = await answer("adopted");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "adopted" });
    expect(loadRecommendation(db, id, MORNING)?.group).toBe("Standing");

    // Answered in another tab, or withdrawn while the page was open. The
    // request was fine; the question is not open any more.
    const second = await answer("declined");
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toContain("already adopted");
  });

  test("POST .../answer refuses a stance that is not one of the two words", async () => {
    const app = new Elysia().use(createUiRoutes(() => db));
    const response = await app.handle(
      new Request("http://localhost/api/recommendations/anything/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stance: "maybe" }),
      }),
    );
    expect(response.status).toBe(422);
  });
});
