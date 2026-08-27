// The Recommendations surface, checked against the design it came from.
//
// The design stores each suggestion's shelf ("Waiting on you"), its mark, the
// word for how sure the agent is ("In force"), its when ("Aug 11") and the
// header's count as display strings. Every one of those falls out of two
// columns here — the status and the date you answered it — so what is worth
// guarding is that the derivation lands where the design says, and that it
// moves when the answer does.
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
import { seedDesignFixtures } from "../seed/design";
import { zonedTime } from "../seed/time";

let dir: string;
let db: Db;
let list: RecommendationsPayload;

// The same fixed morning the home, workflow and reminder tests use.
const MORNING = zonedTime(2026, 8, 25, 9, 20);

const row = (title: string) => list.rows.find((r) => r.title.startsWith(title));

const detail = (title: string): RecommendationDetailPayload => {
  const found = row(title);
  if (!found) throw new Error(`no recommendation starting "${title}"`);
  const one = loadRecommendation(db, found.id, MORNING);
  if (!one) throw new Error(`recommendation ${found.id} did not load`);
  return one;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-recommendations-"));
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
  test("has every suggestion the design draws, shelved and ordered newest first", () => {
    expect(list.rows.map((r) => [r.group, r.title])).toEqual([
      // The standup one is the card the Activity aside draws. It is a
      // recommendation like the rest, so it is on the list like the rest.
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
      "Changes I'd make to how I work, drawn from what I've watched. " +
        "Four are waiting on you, and I haven't acted on any of them.",
    );
  });

  test("the mark keeps apart what is in force, what you turned down and what is being asked", () => {
    expect(row("Let me settle")?.state).toBe("attention");
    expect(row("Group quarter-boundary")?.state).toBe("done");
    expect(row("Send the weekly digest")?.state).toBe("idle");
  });

  test("an open one is dated to the minute; an answered one to the day", () => {
    expect(row("Let me settle")?.when).toBe("Today 06:40");
    expect(row("Stop drafting")?.when).toBe("Yesterday 14:20");
    expect(row("Group quarter-boundary")?.when).toBe("Aug 12");
  });

  test("what it rests on gains your answer and its date once you have given one", () => {
    expect(row("Let me settle")?.basis).toBe("14 approvals · 0 rejections");
    expect(row("Group quarter-boundary")?.basis).toBe("adopted aug 12 · 6 runs since");
    // Nothing was counted for this one beyond the fact that you said no.
    expect(row("Send the weekly digest")?.basis).toBe("declined aug 4");
  });

  test("only what is still being asked carries buttons, and they are the agent's words", () => {
    expect(row("Let me settle")?.actions.map((a) => a.label)).toEqual(["Set the floor at £50", "Keep asking me"]);
    expect(row("Let me settle")?.actions.map((a) => a.stance)).toEqual(["affirm", "quiet"]);
    expect(row("Group quarter-boundary")?.actions).toEqual([]);
    expect(row("Send the weekly digest")?.actions).toEqual([]);
  });

  test("a suggestion names the rule it would become", () => {
    expect(row("Move inbox triage")?.scope).toBe("okf:task/inbox-triage");
    // The standup card was never written up as a policy, and says nothing
    // rather than inventing a uri.
    expect(row("Move the Thursday")?.scope).toBeNull();
  });
});

describe("one suggestion", () => {
  test("the account is read as written, paragraph by paragraph", () => {
    const one = detail("Let me settle");
    expect(one.prose.length).toBe(2);
    expect(one.prose[0]).toContain("I brought fourteen of them to you and you approved fourteen.");
    expect(one.prose[1]).toContain("a spend rule is yours to write, not mine to assume");
  });

  test("where it stopped short is the permission it is asking for", () => {
    expect(detail("Let me settle").restraint).toBe(
      "I did not apply this while waiting. The four differences from this morning's run are still sitting unresolved.",
    );
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
      { label: "From", value: "6 runs" },
      { label: "Confidence", value: "Strong" },
      { label: "Scope", value: "Vendor reconciliation" },
    ]);
    // Five drafts is not five runs, so the pair says drafts.
    expect(detail("Stop drafting").meta[1]).toEqual({ label: "From", value: "5 drafts" });
  });

  test("once you have answered, the first pair is your answer and so is the confidence", () => {
    expect(detail("Group quarter-boundary").meta[0]).toEqual({ label: "Adopted", value: "Aug 12, 09:02" });
    expect(detail("Group quarter-boundary").meta[2]).toEqual({ label: "Confidence", value: "In force" });
    expect(detail("Send the weekly digest").meta[0]).toEqual({ label: "Declined", value: "Aug 4, 21:14" });
    expect(detail("Send the weekly digest").meta[2]).toEqual({ label: "Confidence", value: "Declined" });
  });

  test("the chat behind the spend floor is the message the agent refused to read a rule off", () => {
    const [chat, shot] = detail("Let me settle").evidence;
    expect(chat?.kind).toBe("chat");
    expect(chat?.who).toBe("direct chat with me");
    expect(chat?.ref).toBe("chat/0821");
    expect(chat?.support).toBe("3 messages · 1 pinned");
    expect(chat?.messages?.find((m) => m.pinned)?.text).toContain("anything under fifty just post it");
    expect(chat?.why).toBe("It's the clearest statement that the amount, not the vendor, is what you're deciding on.");

    expect(shot?.kind).toBe("screenshot");
    expect(shot?.who).toBe("my own record");
    expect(shot?.shot?.dims).toBe("1440 × 780");
    expect(shot?.shot?.regions.map((r) => r.label)).toEqual(["Column 3", "Column 5"]);
    expect(shot?.shot?.text).toContain("14 requests · 14 approved · 0 rejected");
  });

  test("the timestamp on the standup notes is the whole of the triage argument", () => {
    const [mail] = detail("Move inbox triage").evidence;
    expect(mail?.kind).toBe("email");
    expect(mail?.who).toBe("Marta Iyer");
    expect(mail?.email?.date).toBe("Aug 19, 2026, 05:45");
    expect(mail?.email?.pinned).toBe(1);
  });

  test("a thread with no other side is named for what it is", () => {
    const [thread] = detail("Stop drafting").evidence;
    expect(thread?.who).toBe("you, editing me");
    // The design labels the two turns "My draft" and "Your send"; here they are
    // named from who sent them, which is the same information.
    expect(thread?.messages?.map((m) => m.name)).toEqual(["Solenoid", "You"]);
    expect(thread?.messages?.filter((m) => m.pinned).length).toBe(1);
  });

  test("a settled one has nothing left to look at and no permission to ask for", () => {
    const settled = detail("Group quarter-boundary");
    expect(settled.evidence).toEqual([]);
    expect(settled.actions).toEqual([]);
    // What it held back from covering is still worth saying, and still says it.
    expect(settled.restraint).toContain("Anything else I still bring individually.");
  });

  test("the aside's card has one sentence and draws only the sections it has", () => {
    const thin = detail("Move the Thursday");
    // No blurb of its own: the row falls back to the first line of the account
    // rather than the same sentence being written into two slots.
    expect(thin.blurb).toBe(thin.prose[0] ?? "");
    expect(thin.effect).toEqual([]);
    expect(thin.restraint).toBeNull();
    expect(thin.meta.map((p) => p.label)).toEqual(["Formed", "Confidence"]);
  });
});

describe("the rail and the aside", () => {
  test("the rail counts what is still being asked, not what is held", () => {
    const rail = loadHome(db, MORNING).rail;
    const item = rail.groups.flatMap((g) => g.items).find((i) => i.label === "Recommendations");
    expect(item).toMatchObject({ count: 4, dot: null });
  });

  test("three more open suggestions do not change what the header says needs you", () => {
    // Home draws a recommendation as its own card, so it filters them out of
    // "what needs you". Seeding four of them must not double-count.
    expect(loadHome(db, MORNING).aside.waiting.length).toBe(2);
  });
});

describe("over HTTP", () => {
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
});
