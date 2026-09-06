// The six things that can happen to a suggestion, and what the surface reads
// back afterwards.
//
// Each test writes through the mutation and then asks the same query the screen
// asks, because the pair is the contract: a suggestion adopted here that the
// list still draws on "Waiting on you", or one withdrawn that still counts in
// the rail, is the bug worth catching. The same bargain ./workflows.test.ts
// strikes with the workflow table.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, type Db } from "../index";
import * as s from "../schema";
import { loadRecommendation, loadRecommendations } from "../queries/recommendations";
import { loadHome } from "../queries/home";
import {
  NoSuchRecommendationError,
  RecommendationSettledError,
  type RecommendationRevision,
  answerRecommendation,
  forgetRecommendation,
  proposeRecommendation,
  reviseRecommendation,
  supersedeRecommendation,
  withdrawRecommendation,
} from "./recommendations";

let dir: string;
let db: Db;

const NOW = new Date("2026-08-25T13:20:00Z");

/** A whole one, so each test can settle it without restating the draft. */
const propose = (over: RecommendationRevision = {}) =>
  proposeRecommendation(
    db,
    {
      title: "Let me settle vendor differences under £50 myself",
      blurb: "I asked you about fourteen of these last quarter and you approved every one.",
      confidence: "strong",
      prose: ["Every reconciliation run turned up a handful.", "I could have inferred a threshold."],
      restraint: "I did not apply this while waiting.",
      basisLabel: "14 approvals · 0 rejections",
      scopeLabel: "Vendor reconciliation",
      scopeOkfUri: "okf:policy/spend-floor",
      from: "6 runs",
      effect: [["Questions I'd stop asking", "roughly 12 a quarter"]],
      affirm: "Set the floor at £50",
      quiet: "Keep asking me",
      ...over,
    },
    NOW,
  );

const one = (id: string) => loadRecommendation(db, id, NOW);
const rows = () => loadRecommendations(db, NOW).rows;
const railCount = () =>
  loadHome(db, NOW)
    .rail.groups.flatMap((g) => g.items)
    .find((i) => i.label === "Recommendations")?.count ?? 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-rec-mutations-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("proposing", () => {
  test("lands on the shelf that is waiting on you, with everything it was given", () => {
    const id = propose();
    const rec = one(id);

    expect(rec?.group).toBe("Waiting on you");
    expect(rec?.state).toBe("attention");
    expect(rec?.blurb).toStartWith("I asked you about fourteen");
    expect(rec?.prose.length).toBe(2);
    expect(rec?.restraint).toBe("I did not apply this while waiting.");
    expect(rec?.basis).toBe("14 approvals · 0 rejections");
    expect(rec?.scope).toBe("okf:policy/spend-floor");
    expect(rec?.effect).toEqual([{ label: "Questions I'd stop asking", value: "roughly 12 a quarter" }]);
    expect(rec?.meta).toContainEqual({ label: "From", value: "6 runs" });
    expect(rec?.actions.map((a) => a.label)).toEqual(["Set the floor at £50", "Keep asking me"]);
  });

  test("opens the question behind it, so the rail and the aside both see it", () => {
    const id = propose();
    expect(railCount()).toBe(1);

    const [decision] = db.select().from(s.decisions).where(eq(s.decisions.subjectId, id)).all();
    expect(decision?.state).toBe("open");
    expect(decision?.blocking).toBe(false);
    // The aside's card is this sentence, not the whole account.
    expect(decision?.body).toStartWith("I asked you about fourteen");
    expect(loadHome(db, NOW).aside.worthALook?.id).toBe(id);
  });

  test("a title is the least it can be, and the surface draws only what it has", () => {
    const id = proposeRecommendation(db, { title: "Read the overnight mail first" }, NOW);
    const rec = one(id);
    expect(rec?.title).toBe("Read the overnight mail first");
    expect(rec?.actions).toEqual([]);
    expect(rec?.effect).toEqual([]);
    // With no blurb the aside falls back to the title rather than drawing blank.
    expect(loadHome(db, NOW).aside.worthALook?.body).toBe("Read the overnight mail first");
  });

  test("refuses one word without the other, and a title that is only whitespace", () => {
    expect(() => proposeRecommendation(db, { title: "t", affirm: "Do it" }, NOW)).toThrow(/both words/);
    expect(() => proposeRecommendation(db, { title: "t", quiet: "Leave it" }, NOW)).toThrow(/both words/);
    expect(() => proposeRecommendation(db, { title: "   " }, NOW)).toThrow(/needs a title/);
    expect(rows()).toEqual([]);
  });
});

describe("revising", () => {
  test("changes what it is given and leaves the rest alone", () => {
    const id = propose();
    reviseRecommendation(db, id, { blurb: "Fourteen approvals, no rejections.", confidence: "weak" }, NOW);

    const rec = one(id);
    expect(rec?.blurb).toBe("Fourteen approvals, no rejections.");
    expect(rec?.meta.find((p) => p.label === "Confidence")?.value).toBe("Weak");
    // Untouched.
    expect(rec?.prose.length).toBe(2);
    expect(rec?.basis).toBe("14 approvals · 0 rejections");
  });

  test("a list given replaces the list that was there rather than adding to it", () => {
    const id = propose();
    reviseRecommendation(db, id, { prose: ["One paragraph now."], effect: [["Runs affected", "Tuesdays only"]] }, NOW);

    const rec = one(id);
    expect(rec?.prose).toEqual(["One paragraph now."]);
    expect(rec?.effect).toEqual([{ label: "Runs affected", value: "Tuesdays only" }]);
  });

  test("rewriting the two words replaces the pair rather than colliding with it", () => {
    const id = propose();
    reviseRecommendation(db, id, { affirm: "Set the floor at £80", quiet: "Keep asking" }, NOW);
    expect(one(id)?.actions.map((a) => a.label)).toEqual(["Set the floor at £80", "Keep asking"]);
  });

  test("the aside's copy of the line moves with the line", () => {
    const id = propose();
    reviseRecommendation(db, id, { blurb: "Fourteen approvals, no rejections." }, NOW);
    expect(loadHome(db, NOW).aside.worthALook?.body).toBe("Fourteen approvals, no rejections.");
  });

  test("is refused once it has been answered", () => {
    const id = propose();
    answerRecommendation(db, id, "adopted", {}, NOW);
    expect(() => reviseRecommendation(db, id, { title: "something else" }, NOW)).toThrow(RecommendationSettledError);
  });
});

describe("answering", () => {
  test("adopting moves it to Standing, marks it in force and takes its buttons away", () => {
    const id = propose();
    answerRecommendation(db, id, "adopted", { basisLabel: "6 runs since" }, new Date("2026-08-26T13:00:00Z"));

    const rec = one(id);
    expect(rec?.group).toBe("Standing");
    expect(rec?.state).toBe("done");
    expect(rec?.actions).toEqual([]);
    expect(rec?.meta[0]).toEqual({ label: "Adopted", value: "Aug 26, 09:00" });
    expect(rec?.meta.find((p) => p.label === "Confidence")?.value).toBe("In force");
    // Your answer and its date come first; only the clause after them is stored.
    expect(rec?.basis).toBe("adopted aug 26 · 6 runs since");
  });

  test("declining sets it aside and stays quiet about it", () => {
    const id = propose();
    answerRecommendation(db, id, "declined", {}, NOW);

    const rec = one(id);
    expect(rec?.group).toBe("Set aside");
    // Something you turned down is quiet; it is not a failure.
    expect(rec?.state).toBe("idle");
    expect(rec?.meta.find((p) => p.label === "Confidence")?.value).toBe("Declined");
  });

  test("closes the question everywhere it was being asked", () => {
    const id = propose();
    expect(railCount()).toBe(1);
    answerRecommendation(db, id, "adopted", {}, NOW);

    expect(railCount()).toBe(0);
    expect(loadHome(db, NOW).aside.worthALook).toBeNull();
    const [decision] = db.select().from(s.decisions).where(eq(s.decisions.subjectId, id)).all();
    expect(decision?.state).toBe("resolved");
    expect(decision?.resolvedBy).toBe("user");
  });

  test("records which of the two words was pressed, long after the buttons are gone", () => {
    const id = propose();
    answerRecommendation(db, id, "declined", {}, NOW);

    const [decision] = db.select().from(s.decisions).where(eq(s.decisions.subjectId, id)).all();
    const [chosen] = db.select().from(s.actions).where(eq(s.actions.id, decision?.chosenActionId ?? "")).all();
    expect(chosen?.label).toBe("Keep asking me");
    expect(chosen?.stance).toBe("quiet");
    expect(chosen?.invokedBy).toBe("user");
  });

  test("keeps the rule it became, so the agent can say later what has used it", () => {
    const id = propose();
    answerRecommendation(db, id, "adopted", { outcome: "Six runs have used it." }, NOW);
    const [stored] = db.select().from(s.recommendations).where(eq(s.recommendations.id, id)).all();
    expect(stored?.decidedBy).toBe("user");
    const [outcome] = db.select().from(s.narratives).where(eq(s.narratives.slot, "outcome")).all();
    expect(outcome?.text).toBe("Six runs have used it.");
  });

  test("cannot be answered twice, or answered at all when it is not there", () => {
    const id = propose();
    answerRecommendation(db, id, "adopted", {}, NOW);
    expect(() => answerRecommendation(db, id, "declined", {}, NOW)).toThrow(RecommendationSettledError);
    expect(() => answerRecommendation(db, "nope", "adopted", {}, NOW)).toThrow(NoSuchRecommendationError);
  });
});

describe("withdrawing", () => {
  test("sets it aside as dropped rather than as something you turned down", () => {
    const id = propose();
    withdrawRecommendation(db, id, "The pattern broke: two of the fourteen came back.", NOW);

    const rec = one(id);
    expect(rec?.group).toBe("Set aside");
    // Not idle: something you declined is quiet, something I took back is not.
    expect(rec?.state).toBe("failed");
    expect(rec?.basis).toBe("dropped today · 14 approvals · 0 rejections");
    expect(railCount()).toBe(0);
  });

  test("dismisses the question rather than resolving it — nobody answered it", () => {
    const id = propose();
    withdrawRecommendation(db, id, undefined, NOW);
    const [decision] = db.select().from(s.decisions).where(eq(s.decisions.subjectId, id)).all();
    expect(decision?.state).toBe("dismissed");
    expect(decision?.resolvedBy).toBe("agent");
    expect(decision?.chosenActionId).toBeNull();
  });

  test("is refused once you have answered it — your answer is not the agent's to undo", () => {
    const id = propose();
    answerRecommendation(db, id, "declined", {}, NOW);
    expect(() => withdrawRecommendation(db, id, undefined, NOW)).toThrow(RecommendationSettledError);
  });
});

describe("superseding", () => {
  test("sets the old one aside and points the new one at what it grew out of", () => {
    const old = propose();
    const fresh = propose({ title: "Let me settle vendor differences under £80 myself" });
    supersedeRecommendation(db, old, fresh, "Folded into a wider floor.", NOW);

    expect(one(old)?.group).toBe("Set aside");
    expect(one(old)?.meta.find((p) => p.label === "Confidence")?.value).toBe("Superseded");
    expect(one(fresh)?.group).toBe("Waiting on you");

    const [edge] = db.select().from(s.links).where(eq(s.links.rel, "supersedes")).all();
    expect(edge?.fromId).toBe(fresh);
    expect(edge?.toId).toBe(old);
  });

  test("refuses to make one supersede itself, or to name one that is not there", () => {
    const id = propose();
    expect(() => supersedeRecommendation(db, id, id, undefined, NOW)).toThrow(/cannot supersede itself/);
    expect(() => supersedeRecommendation(db, id, "nope", undefined, NOW)).toThrow(NoSuchRecommendationError);
    expect(one(id)?.group).toBe("Waiting on you");
  });
});

describe("forgetting", () => {
  test("takes the account, the pairs, the buttons and the question with it", () => {
    const id = propose();
    const kept = propose({ title: "Move inbox triage to 05:30 on Tuesdays" });

    forgetRecommendation(db, id);

    expect(one(id)).toBeNull();
    expect(rows().map((r) => r.id)).toEqual([kept]);
    expect(db.select().from(s.narratives).where(eq(s.narratives.subjectId, id)).all()).toEqual([]);
    expect(db.select().from(s.attributes).where(eq(s.attributes.subjectId, id)).all()).toEqual([]);
    expect(db.select().from(s.actions).where(eq(s.actions.subjectId, id)).all()).toEqual([]);
    expect(db.select().from(s.decisions).where(eq(s.decisions.subjectId, id)).all()).toEqual([]);
  });

  test("leaves no orphan behind for the aside to keep asking about", () => {
    const id = propose();
    forgetRecommendation(db, id);

    // The decision is its own entity and does not cascade from the suggestion,
    // so an unhandled delete would leave its `entities` row alive and
    // `v_needs_you` drawing a question nothing can open.
    expect(db.select().from(s.entities).all()).toEqual([]);
    expect(loadHome(db, NOW).aside.waiting).toEqual([]);
    expect(railCount()).toBe(0);
  });

  test("an id this database has never heard of", () => {
    expect(() => forgetRecommendation(db, "nope")).toThrow(NoSuchRecommendationError);
  });
});
