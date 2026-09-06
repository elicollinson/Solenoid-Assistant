// The five things that can happen to a commitment, and what the week reads
// back afterwards.
//
// Each test writes through the mutation and then asks either the table or the
// same query the screen asks, because the pair is the contract: an item
// cancelled here that the week still draws, or a hold released on paper and
// still occupying a window, is the bug worth catching. The same bargain
// ./recommendations.test.ts strikes with the recommendations table.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { createDb, runMigrations, ulid, type Db } from "../index";
import * as s from "../schema";
import { loadCalendar } from "../queries/calendar";
import { zonedTime } from "../seed/time";
import {
  CalendarItemCancelledError,
  NoSuchCalendarItemError,
  NoSuchParticipantError,
  cancelCalendarItem,
  createCalendarItem,
  offerCalendarHolds,
  rescheduleCalendarItem,
  setCalendarAttendees,
} from "./calendar";

let dir: string;
let db: Db;

// The same fixed Tuesday morning the other calendar tests use, so nothing here
// is right by accident of the week starting on a Monday.
const NOW = zonedTime(2026, 8, 25, 9, 20);
/** A wall clock on one of the seven days the week draws. */
const at = (day: number, hour: number, minute = 0) => zonedTime(2026, 8, day, hour, minute);

/** A person to invite. Every attendee is a participants row, so each test that
 *  needs one mints it rather than leaning on the seed. */
function participant(displayName: string): string {
  const id = ulid();
  db.insert(s.entities).values({ id, kind: "participant", createdAt: NOW, updatedAt: NOW }).run();
  db.insert(s.participants).values({ id, kind: "person", displayName, createdAt: NOW }).run();
  return id;
}

const create = (over: Partial<Parameters<typeof createCalendarItem>[1]> = {}) =>
  createCalendarItem(db, { title: "Latham review", startsAt: at(25, 14), endsAt: at(25, 15), ...over }, NOW);

const row = (id: string) => db.select().from(s.calendarItems).where(eq(s.calendarItems.id, id)).get();
const attendees = (id: string) =>
  db.select().from(s.calendarAttendees).where(eq(s.calendarAttendees.calendarItemId, id)).all();
const hold = (id: string) => db.select().from(s.calendarHolds).where(eq(s.calendarHolds.id, id)).get();
const history = (id: string) =>
  db.select().from(s.subjectEvents).where(eq(s.subjectEvents.subjectId, id)).all();
const onTheWeek = (id: string) => loadCalendar(db, NOW).items.some((i) => i.id === id);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-calendar-mutations-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("creating", () => {
  test("lands as a confirmed event in the one timezone the product runs in", () => {
    const id = create({ location: "Room 2", metaLabel: "Room 2 · four people" });
    const item = row(id);

    expect(item?.kind).toBe("event");
    expect(item?.status).toBe("confirmed");
    expect(item?.tz).toBe(s.APP_TZ);
    expect(item?.allDay).toBe(false);
    expect(item?.location).toBe("Room 2");
    expect(item?.startsAt.getTime()).toBe(at(25, 14).getTime());
    // The supertype comes first, or nothing can cite it, narrate it or link it.
    expect(db.select().from(s.entities).where(eq(s.entities.id, id)).get()?.kind).toBe("calendar_item");
    expect(onTheWeek(id)).toBe(true);
  });

  test("is set by the agent unless it is writing down something they arranged", () => {
    expect(row(create())?.setBy).toBe("agent");
    expect(row(create({ setBy: "user" }))?.setBy).toBe("user");
  });

  test("writes who is coming, how often it repeats and why it is there", () => {
    const marta = participant("Marta Reyes");
    const id = create({
      attendees: [{ participantId: marta, response: "accepted", isExternal: true }],
      recurrence: { rrule: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=14;BYMINUTE=0", untilAt: at(31, 14) },
      account: ["They asked for the morning back in July.", "  "],
    });

    expect(attendees(id)).toEqual([
      { calendarItemId: id, participantId: marta, response: "accepted", optional: false, isExternal: true },
    ]);
    const repeat = db.select().from(s.calendarRecurrences).where(eq(s.calendarRecurrences.itemId, id)).get();
    expect(repeat?.rrule).toBe("FREQ=WEEKLY;BYDAY=TU;BYHOUR=14;BYMINUTE=0");
    expect(repeat?.tz).toBe(s.APP_TZ);
    expect(repeat?.exdates).toEqual([]);
    // The blank paragraph is dropped rather than stored as an empty line.
    expect(
      db
        .select()
        .from(s.narratives)
        .where(and(eq(s.narratives.subjectId, id), eq(s.narratives.slot, "account")))
        .all()
        .map((n) => n.text),
    ).toEqual(["They asked for the morning back in July."]);
  });

  test("refuses a nameless item and one that ends before it starts", () => {
    expect(() => create({ title: "   " })).toThrow(/needs a title/);
    expect(() => create({ startsAt: at(25, 15), endsAt: at(25, 14) })).toThrow(/cannot end before it starts/);
  });

  test("an attendee who is nobody takes the whole item down with it", () => {
    expect(() => create({ attendees: [{ participantId: "nobody" }] })).toThrow(NoSuchParticipantError);
    // The insert and the attendee share one transaction, so a half-written
    // meeting with nobody at it is not a state this table can reach.
    expect(db.select().from(s.calendarItems).all()).toEqual([]);
  });
});

describe("rescheduling", () => {
  test("keeps the length it had when only the start moves", () => {
    const id = create();
    rescheduleCalendarItem(db, id, { startsAt: at(27, 8) }, NOW);
    const item = row(id);

    expect(item?.startsAt.getTime()).toBe(at(27, 8).getTime());
    expect(item?.endsAt?.getTime()).toBe(at(27, 9).getTime());
  });

  test("takes a new finish when the length changes too", () => {
    const id = create();
    rescheduleCalendarItem(db, id, { startsAt: at(27, 8), endsAt: at(27, 11) }, NOW);
    expect(row(id)?.endsAt?.getTime()).toBe(at(27, 11).getTime());
  });

  test("records where it came from, who moved it and why", () => {
    const id = create();
    rescheduleCalendarItem(db, id, { startsAt: at(27, 8), by: "user", because: "Latham asked for the morning" }, NOW);
    const item = row(id);

    expect(item?.movedFromAt?.getTime()).toBe(at(25, 14).getTime());
    expect(item?.movedBy).toBe("user");
    expect(item?.movedReason).toBe("Latham asked for the morning");
  });

  test("a second move overwrites the row's memory but not the trail", () => {
    const id = create();
    rescheduleCalendarItem(db, id, { startsAt: at(26, 14), because: "the boiler" }, NOW);
    rescheduleCalendarItem(db, id, { startsAt: at(27, 14), because: "and again" }, NOW);

    expect(row(id)?.movedFromAt?.getTime()).toBe(at(26, 14).getTime());
    expect(history(id).map((h) => h.text)).toEqual(["the boiler", "and again"]);
  });

  test("refuses a move that moves nothing, a cancelled item, and an id that is nobody's", () => {
    const id = create();
    expect(() => rescheduleCalendarItem(db, id, { startsAt: at(25, 14) }, NOW)).toThrow(/already starts then/);
    expect(() => rescheduleCalendarItem(db, "nothing", { startsAt: at(27, 8) }, NOW)).toThrow(NoSuchCalendarItemError);

    cancelCalendarItem(db, id, {}, NOW);
    expect(() => rescheduleCalendarItem(db, id, { startsAt: at(27, 8) }, NOW)).toThrow(CalendarItemCancelledError);
  });
});

describe("cancelling", () => {
  test("leaves the row on file and takes it off the week", () => {
    const id = create();
    expect(onTheWeek(id)).toBe(true);

    cancelCalendarItem(db, id, { by: "user", because: "They are away" }, NOW);

    expect(row(id)?.status).toBe("cancelled");
    expect(history(id).map((h) => [h.eventKind, h.text, h.actor])).toEqual([["cancelled", "They are away", "user"]]);
    expect(onTheWeek(id)).toBe(false);
  });

  test("will not cancel the same thing twice", () => {
    const id = create();
    cancelCalendarItem(db, id, {}, NOW);
    expect(() => cancelCalendarItem(db, id, {}, NOW)).toThrow(CalendarItemCancelledError);
  });
});

describe("who is coming", () => {
  test("is replaced wholesale, because anybody left out is uninvited", () => {
    const marta = participant("Marta Reyes");
    const fenwick = participant("Fenwick");
    const id = create({ attendees: [{ participantId: marta }] });

    setCalendarAttendees(db, id, [{ participantId: fenwick, response: "declined", optional: true }], NOW);

    expect(attendees(id).map((a) => [a.participantId, a.response, a.optional])).toEqual([
      [fenwick, "declined", true],
    ]);
  });

  test("named twice in one call is once, not a failed write", () => {
    const marta = participant("Marta Reyes");
    const id = create();
    setCalendarAttendees(db, id, [{ participantId: marta }, { participantId: marta, response: "accepted" }], NOW);
    expect(attendees(id).map((a) => a.response)).toEqual(["none"]);
  });

  test("one attendee who is nobody leaves the list that was there alone", () => {
    const marta = participant("Marta Reyes");
    const id = create({ attendees: [{ participantId: marta }] });

    expect(() => setCalendarAttendees(db, id, [{ participantId: "nobody" }], NOW)).toThrow(NoSuchParticipantError);
    expect(attendees(id).map((a) => a.participantId)).toEqual([marta]);
  });

  test("refuses an item that is off the grid", () => {
    const id = create();
    cancelCalendarItem(db, id, {}, NOW);
    expect(() => setCalendarAttendees(db, id, [], NOW)).toThrow(CalendarItemCancelledError);
  });
});

describe("holding time", () => {
  const offer = (over: Partial<Parameters<typeof offerCalendarHolds>[1]> = {}) =>
    offerCalendarHolds(
      db,
      {
        title: "Boiler service",
        windows: [
          { startsAt: at(27, 8), endsAt: at(27, 11) },
          { startsAt: at(28, 13), endsAt: at(28, 16), clashNote: "runs into the standup" },
        ],
        ...over,
      },
      NOW,
    );

  test("offers every window as one question with several answers", () => {
    const fenwick = participant("Fenwick");
    const { holdGroupId, ids } = offer({ offeredById: fenwick, expiresAt: at(26, 17) });

    expect(ids).toHaveLength(2);
    for (const id of ids) {
      const item = row(id);
      expect(item?.kind).toBe("hold");
      // Nothing is agreed until one of them is picked, and the column says so.
      expect(item?.status).toBe("tentative");
      expect(item?.holdGroupId).toBe(holdGroupId);
      expect(hold(id)?.holdGroupId).toBe(holdGroupId);
      expect(hold(id)?.offeredById).toBe(fenwick);
      expect(hold(id)?.offeredAt.getTime()).toBe(NOW.getTime());
      expect(hold(id)?.expiresAt?.getTime()).toBe(at(26, 17).getTime());
      expect(hold(id)?.acceptedAt).toBeNull();
    }
    expect(hold(ids[1] ?? "")?.clashNote).toBe("runs into the standup");
  });

  test("a window can be added to an offer already made", () => {
    const first = offer();
    const second = offer({ windows: [{ startsAt: at(29, 9) }], holdGroupId: first.holdGroupId });

    expect(second.holdGroupId).toBe(first.holdGroupId);
    expect(
      db.select().from(s.calendarHolds).where(eq(s.calendarHolds.holdGroupId, first.holdGroupId)).all(),
    ).toHaveLength(3);
  });

  test("taking one window is releasing the others, and only the others", () => {
    const { ids } = offer();
    const [taken, spare] = ids;

    cancelCalendarItem(db, spare ?? "", { because: "You took the Thursday" }, NOW);

    expect(hold(spare ?? "")?.releasedAt?.getTime()).toBe(NOW.getTime());
    expect(row(spare ?? "")?.status).toBe("cancelled");
    expect(hold(taken ?? "")?.releasedAt).toBeNull();
    expect(row(taken ?? "")?.status).toBe("tentative");
  });

  test("refuses an offer of nothing", () => {
    expect(() => offer({ windows: [] })).toThrow(/at least one window/);
    expect(() => offer({ title: " " })).toThrow(/needs a title/);
  });
});
