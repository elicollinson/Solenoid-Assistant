// The Reminders surface, checked against the design it came from.
//
// The design stores each reminder's bucket ("Overdue"), its when ("Thu 09:00")
// and the header's count as display strings. All three fall out of the due
// date against the clock here, so what is worth guarding is that the
// derivation lands where the design says — and that it moves when the clock
// does.
import { Elysia } from "elysia";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, type Db } from "../index";
import { createUiRoutes } from "../../http/routes/ui";
import { loadReminder, loadReminders, type ReminderDetailPayload, type RemindersPayload } from "./reminders";
import { seedDesignFixtures } from "../seed/design";
import { zonedTime } from "../seed/time";

let dir: string;
let db: Db;
let list: RemindersPayload;

// The same fixed morning the home and workflow tests use.
const MORNING = zonedTime(2026, 8, 25, 9, 20);

const row = (title: string) => list.rows.find((r) => r.title.startsWith(title));

const detail = (title: string): ReminderDetailPayload => {
  const found = row(title);
  if (!found) throw new Error(`no reminder starting "${title}"`);
  const one = loadReminder(db, found.id, MORNING);
  if (!one) throw new Error(`reminder ${found.id} did not load`);
  return one;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-reminders-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  seedDesignFixtures(db, { now: MORNING });
  list = loadReminders(db, MORNING);
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the list", () => {
  test("has every reminder the design draws, bucketed and ordered", () => {
    expect(list.rows.map((r) => [r.group, r.title])).toEqual([
      ["Overdue", "Tell Ferris whether the credit note stands"],
      ["Today", "Pick a slot for the boiler service"],
      ["Today", "Call Marta back"],
      // Drawn on the calendar and nowhere else in the design. It is a reminder,
      // so it is one, and it is on both screens rather than just the one.
      ["This week", "Send the review notes round"],
      ["This week", "Renew the parking permit"],
      ["Someday", "Follow up on the contract if Ferris hasn't replied"],
      ["Someday", "Look again at the job listings sweep"],
      ["Closed", "Send Priya the revised figures"],
    ]);
  });

  test("says when each one is due the way you would say it", () => {
    expect(row("Tell Ferris")?.when).toBe("Yesterday 17:00");
    expect(row("Pick a slot")?.when).toBe("Today 16:30");
    expect(row("Renew the parking")?.when).toBe("Sat 09:00");
    expect(row("Look again")?.when).toBe("No date");
  });

  test("carries the agent's one line and where it came from", () => {
    expect(row("Call Marta")?.note).toBe(
      "She prefers afternoon calls, so I set this for the end of the day rather than the morning.",
    );
    expect(row("Call Marta")?.source).toBe("from okf:contact/marta");
  });

  test("the lede counts what is genuinely late rather than storing a number", () => {
    expect(list.lede).toBe(
      "Things I'm holding for you rather than acting on. One of them is past when you asked to hear about it.",
    );
  });

  test("marks only the one with an open decision as a gate", () => {
    expect(list.rows.filter((r) => r.gated).map((r) => r.title)).toEqual(["Pick a slot for the boiler service"]);
  });

  test("the buckets and the lede both move with the clock", () => {
    // Seven hours later the boiler slot is past, so it leaves Today and the
    // sentence counts two. Nothing was written for either to happen.
    const evening = zonedTime(2026, 8, 25, 17, 0);
    const later = loadReminders(db, evening);
    expect(later.rows.find((r) => r.title.startsWith("Pick a slot"))?.group).toBe("Overdue");
    expect(later.lede).toBe(
      "Things I'm holding for you rather than acting on. Two of them are past when you asked to hear about them.",
    );
  });

  test("something closed is closed, however long ago it was due", () => {
    expect(row("Send Priya")?.group).toBe("Closed");
    expect(row("Send Priya")?.state).toBe("done");
  });
});

describe("one reminder", () => {
  test("reads back the agent's account, unabridged", () => {
    const one = detail("Tell Ferris");
    expect(one.prose.length).toBe(3);
    expect(one.prose[0]).toBe(
      "You told me to leave anything Ferris alone until the credit note was settled, so that is what I have been doing. It has now held two invoices for ten days.",
    );
  });

  test("derives who set it, when, and what it holds up; reads the rest as written", () => {
    expect(detail("Tell Ferris").meta).toEqual([
      { label: "Set by", value: "me · Aug 15, 09:20" },
      { label: "Due", value: "Yesterday 17:00" },
      { label: "Source", value: "okf:vendor/ferris-terms" },
      { label: "Blocks", value: "Q3 vendor reconciliation" },
      { label: "Holding", value: "2 invoices" },
    ]);
  });

  test("a closed one says when it closed rather than when it was due", () => {
    const meta = detail("Send Priya").meta.map((m) => m.label);
    expect(meta).toContain("Closed");
    expect(meta).not.toContain("Due");
  });

  test("carries the trail in the order it happened", () => {
    expect(detail("Tell Ferris").history.map((h) => h.t)).toEqual([
      "Aug 15, 09:20",
      "Aug 19, 06:12",
      "Yesterday 17:00",
      "Today 06:14",
    ]);
  });

  test("names the standing rule it is an instance of", () => {
    expect(detail("Renew the parking").instruction).toBe("Anything that commits money waits for me.");
    expect(detail("Call Marta").instruction).toBeNull();
  });

  test("a gate carries its buttons; a nag carries loose affordances", () => {
    const gated = detail("Pick a slot");
    expect(gated.gate?.title).toBe("Pick a slot for the boiler service");
    expect(gated.gate?.actions.map((a) => a.label)).toEqual(["Take Friday", "Show me the thread"]);
    expect(gated.actions).toEqual([]);

    const nag = detail("Tell Ferris");
    expect(nag.gate).toBeNull();
    expect(nag.actions.map((a) => a.label)).toEqual(["Settle it now", "Keep holding"]);
  });
});

describe("the evidence behind one", () => {
  test("an email comes back with its headers, its pin and what was attached", () => {
    const [email] = detail("Tell Ferris").evidence;
    expect(email?.kind).toBe("email");
    expect(email?.title).toBe("Credit note CN-0117 — for your records");
    expect(email?.who).toBe("Ferris Supply Co.");
    expect(email?.ref).toBe("thread/4c02");
    expect(email?.email?.date).toBe("Aug 12, 2026, 16:41");
    // The pin is the quote, re-found in the body — not a stored index.
    expect(email?.email?.pinned).toBe(1);
    expect(email?.email?.quoted).toEqual(["> Raised following the review of Q2 supply charges discussed on 4 August."]);
    expect(email?.email?.attachments).toEqual(["CN-0117.pdf · 84 KB"]);
  });

  test("a capture comes back with the analysis that read it", () => {
    const shot = detail("Tell Ferris").evidence[1];
    expect(shot?.kind).toBe("screenshot");
    expect(shot?.who).toBe("captured by me from the accounts portal");
    expect(shot?.shot?.dims).toBe("1440 × 900");
    expect(shot?.shot?.regions.map((r) => r.label)).toEqual(["Row 14", "Row 15", "Header"]);
    expect(shot?.shot?.text).toContain("UNMATCHED");
    // It was taken during a run, so it says which.
    expect(shot?.ref).toBe("run 14");
  });

  test("a text names the person and the number; a chat names neither", () => {
    const [thread, chat] = detail("Pick a slot").evidence;
    expect(thread?.who).toBe("Fenwick Heating · +44 7700 900412");
    expect(thread?.support).toBe("3 messages · 1 pinned");
    expect(thread?.messages?.map((m) => m.name)).toEqual(["Fenwick Heating", "You", "Fenwick Heating"]);
    expect(thread?.messages?.filter((m) => m.pinned).length).toBe(1);
    expect(chat?.who).toBe("direct chat with me");
    expect(chat?.messages?.map((m) => m.name)).toEqual(["Solenoid", "You", "Solenoid"]);
  });

  test("a fetched page keeps its own headline under the name the citation gave it", () => {
    const article = detail("Renew the parking").evidence[1];
    expect(article?.title).toBe("Council renewal window and late penalties");
    expect(article?.article?.headline).toBe("Renewing a resident parking permit");
    expect(article?.article?.words).toBe(540);
    expect(article?.article?.pinned).toBe(2);
  });

  test("why a source was kept is written on the link, not on the source", () => {
    expect(detail("Tell Ferris").evidence[0]?.why).toBe(
      "This is the note itself. It never says which invoices it covers, which is the whole reason I stopped.",
    );
  });

  test("the contract follow-up cites a draft, because nothing has gone out", () => {
    const [draft] = detail("Follow up on the contract").evidence;
    expect(draft?.who).toBe("drafted by me for Ferris Supply Co.");
    expect(draft?.support).toBe("held as a draft");
  });
});

describe("over HTTP", () => {
  test("GET /api/reminders answers with the list", async () => {
    const app = new Elysia().use(createUiRoutes(() => db));
    const response = await app.handle(new Request("http://localhost/api/reminders"));
    expect(response.status).toBe(200);
    expect((await response.json()) as RemindersPayload).toHaveProperty("rows");
  });

  test("GET /api/reminders/:id answers 404 for one that isn't there", async () => {
    const app = new Elysia().use(createUiRoutes(() => db));
    const response = await app.handle(new Request("http://localhost/api/reminders/nope"));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("No reminder with id nope");
  });
});
