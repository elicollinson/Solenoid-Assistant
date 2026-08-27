// The Calendar surface: the week, and everything behind one thing on it.
//
// Four kinds sit on the canvas and only two of them are rows. An event and a
// hold own their content, because nothing else in the database knows that
// Fenwick offered two windows. A run and a reminder own nothing: they are
// projections, built here from workflow_runs, workflow_schedules and reminders,
// which is the only way "Call Marta back" can be prevented from saying one
// thing on Reminders and another here.
//
// Everything positional is derived. Which column something falls in, how tall
// it is, what the week is called, how many of each kind are on a day and what
// the line above the grid says are all readings of the clock against the rows
// underneath — a stored "Mon 24" is wrong by Tuesday, and a stored "four of my
// runs" is wrong the moment a fifth one starts.
import { and, asc, eq, gte, isNotNull, lte, ne } from "drizzle-orm";
import type { Db } from "../index";
import * as s from "../schema";
import type {
  CalendarDay,
  CalendarDetailPayload,
  CalendarItem,
  CalendarMark,
  CalendarPair,
  CalendarPayload,
} from "../../shared/calendar";
import type { HomeAction } from "../../shared/home";
import type { Surface } from "../../shared/surface";
import { capitalise, clock, dayKey, duration, localHour, shortDay, spell, stampLong, weekday } from "./_format";
import { surfaceDayNotes, surfaceNote } from "./_surface";

export type * from "../../shared/calendar";

/**
 * Seven columns and the hours they run between.
 *
 * The design's canvas ends at 22:00, which is also when the nightly tidy runs,
 * so the design draws that one hanging half off the bottom of its own grid. An
 * hour more of canvas costs nothing and puts it inside. Anything outside these
 * hours is left off rather than positioned off it.
 */
const DAYS = 7;
const START_HOUR = 6;
const END_HOUR = 23;

/** How long a reminder occupies. It is a point in time, not a span, and the
 *  grid needs something to draw; twenty minutes is what the design gives it. */
const REMINDER_MINUTES = 20;

/** When a workflow has never finished a run, the guess for how long the next
 *  one takes. Only the block's height turns on it. */
const ASSUMED_RUN_MS = 30 * 60_000;

const minutesOf = (d: Date) => Number(clock(d).slice(0, 2)) * 60 + Number(clock(d).slice(3, 5));

/**
 * The instant at which one of the window's days reads `hour:minute`.
 *
 * Walked from that day's local noon, then corrected once — on the two days a
 * year the clocks move, the walk lands an hour off and the second pass puts it
 * back. This is the only place a wall clock has to be turned into an instant,
 * so it is here rather than in a second copy of the zone solver.
 */
function atLocal(dayNoon: Date, hour: number, minute: number): Date {
  const target = hour * 60 + minute;
  const walked = new Date(dayNoon.getTime() + (target - minutesOf(dayNoon)) * 60_000);
  const drift = target - minutesOf(walked);
  return drift === 0 ? walked : new Date(walked.getTime() + drift * 60_000);
}
const dayOfMonth = (d: Date) => String(Number(dayKey(d).slice(8, 10)));
const yearOf = (d: Date) => dayKey(d).slice(0, 4);
const monthOf = (d: Date) => shortDay(d).split(" ")[0] ?? "";

/**
 * The seven days the window covers.
 *
 * Walked from local noon rather than from now: an hour of daylight saving
 * applied to a time near midnight steps over a day boundary, and the whole
 * grid would then be off by one for a week twice a year. Nothing is within
 * eleven hours of midnight at noon.
 */
function windowDays(now: Date): Date[] {
  const noon = new Date(now.getTime() + (12 - localHour(now)) * 3_600_000);
  return Array.from({ length: DAYS }, (_, i) => new Date(noon.getTime() + i * 86_400_000));
}

/** A run's state, in the vocabulary a calendar mark has. Queued and cancelled
 *  are not marks: neither is a thing that happened. */
function markOfRun(state: (typeof s.RUN_STATE)[number]): CalendarMark | null {
  return state === "queued" || state === "cancelled" ? null : state;
}

export function loadCalendar(db: Db, now: Date = new Date(), surface: Surface = "desktop"): CalendarPayload {
  const days = windowDays(now);
  const keys = days.map(dayKey);
  const column = new Map(keys.map((key, i) => [key, `d${i}`]));

  const items = [
    ...ownedItems(db, column),
    ...runItems(db, column, days, now),
    ...scheduledItems(db, column, days, now),
    ...reminderItems(db, column),
  ]
    .filter(inWindow)
    .sort((a, b) => a.day.localeCompare(b.day) || a.start.localeCompare(b.start));

  const held = surfaceDayNotes(db, "calendar", "restraint", surface);
  // The phone draws one day at a time, so it wants a line per day where the
  // desktop wants one about the week. Nothing is written for the desktop, so
  // every `lede` below is null there and the week's line does the work.
  const dayLines = surfaceDayNotes(db, "calendar", "line", surface);

  const shown: CalendarDay[] = days.map((d, i) => ({
    key: `d${i}`,
    label: weekday(d),
    date: dayOfMonth(d),
    today: i === 0,
    counts: countsFor(items, `d${i}`),
    // The same two halves every lede in the product has: what I wrote about
    // the day, then a count of what is on it. Only the first half is stored,
    // because a tally stored is a tally wrong by morning — which is why the
    // design's own day lines are transcribed here with their counts removed.
    lede: [dayLines.get(keys[i] ?? "") ?? "", ledeFor(items, `d${i}`)].filter(Boolean).join(" "),
    restraint: held.get(keys[i] ?? "") ?? null,
  }));

  return {
    range: rangeOf(days),
    lede: ledeFor(items),
    // What I held back from across the whole week, as opposed to on one day of
    // it. The phone keeps this under the agenda whichever day is showing.
    restraint: surfaceNote(db, "calendar", "restraint", surface) || null,
    now: minutesOf(now),
    startHour: START_HOUR,
    endHour: END_HOUR,
    days: shown,
    items,
  };
}

/**
 * The hours the grid draws, and nothing else.
 *
 * A run at three in the morning is real and is on the Workflows screen; drawing
 * it here would mean positioning it above the canvas, on top of the day
 * headers. The window is the design's, and what falls outside it is left out
 * rather than drawn wrong.
 */
function inWindow(item: CalendarItem): boolean {
  return item.end > `${String(START_HOUR).padStart(2, "0")}:00` && item.start < `${String(END_HOUR).padStart(2, "0")}:59`;
}

// ── events and holds, which own themselves ──────────────────────────────

function ownedItems(db: Db, column: Map<string, string>): CalendarItem[] {
  return db
    .select()
    .from(s.calendarItems)
    .where(ne(s.calendarItems.status, "cancelled"))
    .orderBy(asc(s.calendarItems.startsAt))
    .all()
    .flatMap((row) => {
      const day = column.get(dayKey(row.startsAt));
      if (!day) return [];
      const end = row.endsAt ?? new Date(row.startsAt.getTime() + 3_600_000);
      return [
        {
          id: row.id,
          day,
          start: clock(row.startsAt),
          end: clock(end),
          kind: row.kind,
          state: row.state ?? null,
          title: row.title,
          meta: row.metaLabel,
        } satisfies CalendarItem,
      ];
    });
}

// ── runs, which belong to the workflow that ran them ────────────────────

/** The middle of what this workflow's finished runs took. Two of the three
 *  places a run's height comes from read this, so it is counted once. */
function medians(db: Db): Map<string, number> {
  const byWorkflow = new Map<string, number[]>();
  for (const run of db
    .select({ workflowId: s.workflowRuns.workflowId, durationMs: s.workflowRuns.durationMs })
    .from(s.workflowRuns)
    .where(isNotNull(s.workflowRuns.durationMs))
    .all()) {
    if (run.durationMs == null) continue;
    const list = byWorkflow.get(run.workflowId) ?? [];
    list.push(run.durationMs);
    byWorkflow.set(run.workflowId, list);
  }
  const out = new Map<string, number>();
  for (const [id, list] of byWorkflow) {
    list.sort((a, b) => a - b);
    out.set(id, list[Math.floor(list.length / 2)] ?? ASSUMED_RUN_MS);
  }
  return out;
}

/** What a run's line says, in the state it is in. A finished run is told by how
 *  long it took; anything unfinished is told by where it stopped. */
function runMeta(run: typeof s.workflowRuns.$inferSelect): string {
  const n = `run ${run.ordinal}`;
  const step = `${run.stepIndex ?? 0}/${run.stepTotal ?? 0}`;
  if (run.state === "running") return `${n} · step ${step}`;
  if (run.state === "attention") return `${n} · waiting at ${step}`;
  if (run.state === "failed") return `${n} · stopped at ${step}`;
  return [n, duration(run.durationMs)].filter(Boolean).join(" · ");
}

function runItems(db: Db, column: Map<string, string>, days: Date[], now: Date): CalendarItem[] {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return [];

  const median = medians(db);
  return db
    .select({ run: s.workflowRuns, slug: s.workflows.slug })
    .from(s.workflowRuns)
    .innerJoin(s.workflows, eq(s.workflows.id, s.workflowRuns.workflowId))
    .where(
      and(
        gte(s.workflowRuns.startedAt, new Date(first.getTime() - 43_200_000)),
        lte(s.workflowRuns.startedAt, new Date(last.getTime() + 43_200_000)),
      ),
    )
    .all()
    .flatMap(({ run, slug }) => {
      // A queued run has no clock yet, so there is nowhere to draw it.
      const startedAt = run.startedAt;
      if (!startedAt) return [];
      const day = column.get(dayKey(startedAt));
      if (!day) return [];
      // A run still going ends at the clock, not at a guess: the block grows
      // through the morning, which is the only honest way to draw it.
      const end =
        run.endedAt ??
        (run.state === "running" ? now : new Date(startedAt.getTime() + (median.get(run.workflowId) ?? ASSUMED_RUN_MS)));
      return [
        {
          id: run.id,
          day,
          start: clock(startedAt),
          end: clock(end),
          kind: "run" as const,
          state: markOfRun(run.state),
          title: slug,
          meta: runMeta(run),
        } satisfies CalendarItem,
      ];
    });
}

// ── runs that have not happened yet ─────────────────────────────────────

/** The id a run with no row is addressed by. Nothing is written for a future
 *  occurrence — materialising one forks it from the schedule it came from — so
 *  it is named by the schedule and the minute instead. */
const scheduleId = (slug: string, at: Date) => `schedule:${slug}:${at.getTime()}`;

interface Rule {
  freq: string;
  days: string[];
  hour: number;
  minute: number;
}

/** Enough of an RRULE for the schedules this product writes: a frequency, the
 *  weekdays it applies to, and the time of day. No library, because everything
 *  past this is a rule nothing here has ever set. */
function parseRule(rrule: string): Rule | null {
  const parts = new Map(rrule.split(";").map((p) => p.split("=") as [string, string]));
  const freq = parts.get("FREQ");
  if (!freq) return null;
  return {
    freq,
    days: (parts.get("BYDAY") ?? "").split(",").filter(Boolean),
    hour: Number(parts.get("BYHOUR") ?? 0),
    minute: Number(parts.get("BYMINUTE") ?? 0),
  };
}

const RRULE_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function scheduledItems(db: Db, column: Map<string, string>, days: Date[], now: Date): CalendarItem[] {
  const median = medians(db);
  const out: CalendarItem[] = [];

  for (const row of db
    .select({ schedule: s.workflowSchedules, slug: s.workflows.slug, workflowId: s.workflows.id })
    .from(s.workflowSchedules)
    .innerJoin(s.workflows, eq(s.workflows.id, s.workflowSchedules.workflowId))
    .where(eq(s.workflowSchedules.enabled, true))
    .all()) {
    const rule = parseRule(row.schedule.rrule);
    // An hourly check is not a commitment. Sixteen of them a day would bury
    // everything you actually have to be somewhere for, and the run that
    // matters — the one that failed this morning — is already drawn as a run.
    if (!rule || (rule.freq !== "DAILY" && rule.freq !== "WEEKLY")) continue;

    for (const [i, d] of days.entries()) {
      const key = dayKey(d);
      const dow = RRULE_DAY[new Date(`${key}T12:00:00Z`).getUTCDay()] ?? "";
      if (rule.freq === "WEEKLY" && !rule.days.includes(dow)) continue;

      const at = atLocal(d, rule.hour, rule.minute);
      const start = clock(at);
      // Only ahead of the clock. A firing already in the past either ran — and
      // is then a run, with a row — or did not, and the schedule is no record
      // of that either way.
      if (i === 0 && start <= clock(now)) continue;

      const span = median.get(row.workflowId) ?? ASSUMED_RUN_MS;
      out.push({
        id: scheduleId(row.slug, at),
        day: column.get(key) ?? `d${i}`,
        start,
        end: clock(new Date(at.getTime() + span)),
        kind: "run",
        state: null,
        title: row.slug,
        meta: cadenceMeta(row.schedule.label, start),
      });
    }
  }
  return out;
}

/** "weekdays · 06:00" — the cadence in the agent's own words, then the minute
 *  it lands on. The cadence already carries the time; the column does not. */
function cadenceMeta(label: string | null, start: string): string {
  const word = (label ?? "").split(",")[0]?.trim().toLowerCase();
  return [word, start].filter(Boolean).join(" · ");
}

// ── reminders, which belong to Reminders ────────────────────────────────

function reminderItems(db: Db, column: Map<string, string>): CalendarItem[] {
  return db
    .select()
    .from(s.reminders)
    .where(and(isNotNull(s.reminders.dueAt), ne(s.reminders.state, "cancelled"), ne(s.reminders.state, "done")))
    .all()
    .flatMap((r) => {
      if (!r.dueAt) return [];
      const day = column.get(dayKey(r.dueAt));
      if (!day) return [];
      return [
        {
          id: r.id,
          day,
          start: clock(r.dueAt),
          end: clock(new Date(r.dueAt.getTime() + REMINDER_MINUTES * 60_000)),
          kind: "reminder" as const,
          // A reminder has five states and a mark has four. Only one of them
          // is a thing the day is asking about.
          state: r.state === "attention" ? ("attention" as const) : null,
          title: r.title,
          meta: clock(r.dueAt),
        } satisfies CalendarItem,
      ];
    });
}

// ── what the week and the day are called ────────────────────────────────

function rangeOf(days: Date[]): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return "";
  const tail = monthOf(first) === monthOf(last) ? dayOfMonth(last) : shortDay(last);
  return `${shortDay(first)} – ${tail}, ${yearOf(last)}`;
}

const COUNT_LABELS: [string, CalendarItem["kind"]][] = [
  ["Your events", "event"],
  ["My runs", "run"],
  ["Reminders", "reminder"],
  ["Held slots", "hold"],
];

function countsFor(items: readonly CalendarItem[], day: string): CalendarPair[] {
  return COUNT_LABELS.map(([label, kind]) => ({
    label,
    value: String(items.filter((i) => i.day === day && i.kind === kind).length),
  }));
}

/**
 * What I would say about today.
 *
 * Both halves are counted. The design stores the sentence, and the sentence it
 * stores says three commitments over a day holding two — which is what happens
 * when a number that changes is written down once.
 */
function ledeFor(items: readonly CalendarItem[], key = "d0"): string {
  const today = items.filter((i) => i.day === key);
  const runs = today.filter((i) => i.kind === "run").length;
  const events = today.filter((i) => i.kind === "event").length;
  const running = today.filter((i) => i.kind === "run" && i.state === "running").length;
  const asked = today.find((i) => i.kind === "run" && i.state === "attention");

  const mine = runs === 0 ? "None of my runs" : runs === 1 ? "One run of mine" : `${capitalise(spell(runs))} of my runs`;
  const yours = events === 0 ? "nothing of yours" : events === 1 ? "one commitment of yours" : `${spell(events)} of your commitments`;

  const clauses: string[] = [];
  if (running > 0) clauses.push(running === 1 ? "One run is still going" : `${capitalise(spell(running))} runs are still going`);
  if (asked) clauses.push(`${clauses.length ? "one" : "One"} asked for you at ${asked.start}`);

  return [`${mine} and ${yours}.`, clauses.length ? `${clauses.join(" and ")}.` : ""].filter(Boolean).join(" ");
}

// ── one thing on the canvas ─────────────────────────────────────────────

/** "Today, 10:00 – 11:30", "Thu 27, 08:00 – 11:00" — near days by name, the
 *  rest by weekday and date, which is how the week reads on the grid above. */
function spanName(start: Date, end: Date | null, now: Date, running: boolean): string {
  const away = Math.round(
    (Date.parse(`${dayKey(start)}T00:00:00Z`) - Date.parse(`${dayKey(now)}T00:00:00Z`)) / 86_400_000,
  );
  const day =
    away === 0 ? "Today" : away === 1 ? "Tomorrow" : away === -1 ? "Yesterday" : away > 1 && away <= 6 ? `${weekday(start)} ${dayOfMonth(start)}` : shortDay(start);
  if (running) return `${day}, from ${clock(start)}`;
  return end ? `${day}, ${clock(start)} – ${clock(end)}` : `${day}, ${clock(start)}`;
}

function narrative(db: Db, subjectId: string, slot: "account" | "summary"): string[] {
  return db
    .select({ text: s.narratives.text })
    .from(s.narratives)
    .where(and(eq(s.narratives.subjectId, subjectId), eq(s.narratives.slot, slot)))
    .orderBy(asc(s.narratives.ordinal))
    .all()
    .map((n) => n.text);
}

function actionsFor(db: Db, subjectId: string): HomeAction[] {
  return db
    .select()
    .from(s.actions)
    .where(eq(s.actions.subjectId, subjectId))
    .orderBy(asc(s.actions.ordinal))
    .all()
    .map((a) => ({ id: a.id, label: a.label, stance: a.stance, effectKind: a.effectKind, effect: a.effect }));
}

/** The way through to whatever this is a projection of. Not a button — it is
 *  the same object seen from somewhere else, so it reads as a link. */
function wayThrough(label: string, view: string, id: string): HomeAction {
  return { id: `link:${view}:${id}`, label, stance: "bare", effectKind: "navigate", effect: { view, id } };
}

export function loadCalendarItem(db: Db, id: string, now: Date = new Date()): CalendarDetailPayload | null {
  if (id.startsWith("schedule:")) return scheduledDetail(db, id, now);
  return ownedDetail(db, id, now) ?? runDetail(db, id, now) ?? reminderDetail(db, id, now);
}

function ownedDetail(db: Db, id: string, now: Date): CalendarDetailPayload | null {
  const [row] = db.select().from(s.calendarItems).where(eq(s.calendarItems.id, id)).limit(1).all();
  if (!row) return null;
  const column = new Map(windowDays(now).map((d, i) => [dayKey(d), `d${i}`]));
  const end = row.endsAt ?? null;

  const pairs: CalendarPair[] = [{ label: "Kind", value: row.kind }];
  if (row.location) pairs.push({ label: "Where", value: row.location });
  pairs.push({ label: "Set by", value: row.setBy === "agent" ? "me" : "you" });

  const [repeat] = db.select().from(s.calendarRecurrences).where(eq(s.calendarRecurrences.itemId, id)).limit(1).all();
  if (repeat) {
    const rule = parseRule(repeat.rrule);
    if (rule) pairs.push({ label: "Repeats", value: rule.freq.toLowerCase() === "weekly" ? "weekly" : rule.freq.toLowerCase() });
  }
  if (row.movedFromAt) pairs.push({ label: "Moved", value: `from ${shortDay(row.movedFromAt)}` });

  for (const pair of db
    .select()
    .from(s.attributes)
    .where(and(eq(s.attributes.subjectId, id), eq(s.attributes.groupSlot, "meta")))
    .orderBy(asc(s.attributes.ordinal))
    .all()) {
    pairs.push({ label: pair.label, value: pair.value });
  }

  return {
    id: row.id,
    day: column.get(dayKey(row.startsAt)) ?? "d0",
    start: clock(row.startsAt),
    end: clock(end ?? new Date(row.startsAt.getTime() + 3_600_000)),
    kind: row.kind,
    state: row.state ?? null,
    title: row.title,
    meta: row.metaLabel,
    when: spanName(row.startsAt, end, now, false),
    account: narrative(db, id, "account"),
    pairs,
    actions: actionsFor(db, id),
    link: null,
  };
}

function runDetail(db: Db, id: string, now: Date): CalendarDetailPayload | null {
  const [found] = db
    .select({ run: s.workflowRuns, slug: s.workflows.slug, name: s.workflows.name })
    .from(s.workflowRuns)
    .innerJoin(s.workflows, eq(s.workflows.id, s.workflowRuns.workflowId))
    .where(eq(s.workflowRuns.id, id))
    .limit(1)
    .all();
  if (!found) return null;
  const { run, slug, name } = found;
  // A queued run has no clock yet, so there is nothing on the canvas to open.
  const startedAt = run.startedAt;
  if (!startedAt) return null;

  const column = new Map(windowDays(now).map((d, i) => [dayKey(d), `d${i}`]));
  const median = medians(db).get(run.workflowId);
  const end = run.endedAt ?? (run.state === "running" ? now : new Date(startedAt.getTime() + (median ?? ASSUMED_RUN_MS)));

  const pairs: CalendarPair[] = [
    { label: "Kind", value: "workflow run" },
    { label: "Trigger", value: run.trigger },
  ];
  if (run.durationMs != null) pairs.push({ label: "Duration", value: duration(run.durationMs) ?? "" });
  else pairs.push({ label: "Step", value: `${run.stepIndex ?? 0}/${run.stepTotal ?? 0}` });
  if (median != null) pairs.push({ label: "Median", value: duration(median) ?? "" });

  return {
    id: run.id,
    day: column.get(dayKey(startedAt)) ?? "d0",
    start: clock(startedAt),
    end: clock(end),
    kind: "run",
    state: markOfRun(run.state),
    title: slug,
    meta: runMeta(run),
    when: spanName(startedAt, run.endedAt, now, run.state === "running"),
    // A run's account is the one it wrote about itself, not a second one
    // written for this screen.
    account: narrative(db, run.id, "summary"),
    pairs,
    actions: [],
    link: wayThrough(`Workflow · ${name}`, "Workflows", slug),
  };
}

function scheduledDetail(db: Db, id: string, now: Date): CalendarDetailPayload | null {
  const slug = id.slice("schedule:".length, id.lastIndexOf(":"));
  const at = new Date(Number(id.slice(id.lastIndexOf(":") + 1)));
  if (!slug || Number.isNaN(at.getTime())) return null;

  const [found] = db
    .select({ workflow: s.workflows, schedule: s.workflowSchedules })
    .from(s.workflows)
    .innerJoin(s.workflowSchedules, eq(s.workflowSchedules.workflowId, s.workflows.id))
    .where(eq(s.workflows.slug, slug))
    .limit(1)
    .all();
  if (!found) return null;
  const { workflow, schedule } = found;

  const column = new Map(windowDays(now).map((d, i) => [dayKey(d), `d${i}`]));
  const median = medians(db).get(workflow.id) ?? ASSUMED_RUN_MS;
  const end = new Date(at.getTime() + median);

  return {
    id,
    day: column.get(dayKey(at)) ?? "d0",
    start: clock(at),
    end: clock(end),
    kind: "run",
    state: null,
    title: slug,
    meta: cadenceMeta(schedule.label, clock(at)),
    when: spanName(at, null, now, false),
    // Nothing has run yet, so what it says about itself is what it says about
    // every time it runs.
    account: narrative(db, workflow.id, "summary"),
    pairs: [
      { label: "Kind", value: "scheduled run" },
      { label: "Trigger", value: "schedule" },
      { label: "Cadence", value: schedule.label ?? "" },
      { label: "Median", value: duration(median) ?? "" },
    ],
    actions: [],
    link: wayThrough(`Workflow · ${workflow.name}`, "Workflows", slug),
  };
}

function reminderDetail(db: Db, id: string, now: Date): CalendarDetailPayload | null {
  const [r] = db.select().from(s.reminders).where(eq(s.reminders.id, id)).limit(1).all();
  if (!r?.dueAt) return null;

  const column = new Map(windowDays(now).map((d, i) => [dayKey(d), `d${i}`]));
  const pairs: CalendarPair[] = [
    { label: "Kind", value: "reminder" },
    { label: "Set by", value: `${r.setBy === "agent" ? "me" : "you"} · ${stampLong(r.setAt, now)}` },
  ];
  if (r.originLabel) pairs.push({ label: "Source", value: r.originLabel.replace(/^from /, "") });

  return {
    id: r.id,
    day: column.get(dayKey(r.dueAt)) ?? "d0",
    start: clock(r.dueAt),
    end: clock(new Date(r.dueAt.getTime() + REMINDER_MINUTES * 60_000)),
    kind: "reminder",
    state: r.state === "attention" ? "attention" : null,
    title: r.title,
    meta: clock(r.dueAt),
    when: spanName(r.dueAt, null, now, false),
    account: narrative(db, r.id, "account"),
    pairs,
    actions: actionsFor(db, r.id),
    link: wayThrough(`Reminder · ${r.title}`, "Reminders", r.id),
  };
}
