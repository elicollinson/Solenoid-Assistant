// What the database says should run, and when.
//
// This file exists because this service had two schedulers. `workflow_schedules`
// held the rules the Workflows screen drew, the calendar canvas laid out and the
// agent could edit — and nothing read it. The cron worker read `tasks.yaml`, a
// file the screen could not see and the agent could not write. So the agent
// could be asked for a 3am daily run, write it, show it on three surfaces, and
// have nothing fire, with no error anywhere: both halves were behaving exactly
// as built.
//
// One scheduler now, and its source of truth is the row.
//
// ## Why a translation rather than an RRULE engine
//
// The rules are stored as RFC 5545 because that is what the schema says and
// what the agent writes. The runner is `croner`, which takes cron. Rather than
// add an RRULE library for the four shapes this product actually uses, the
// translation below handles those four exactly and REFUSES everything else.
//
// Refusing matters more than covering. A rule this cannot read becomes a
// logged, visible "I cannot schedule that" — which is a bug report — where a
// best-effort guess becomes a job firing at the wrong time, which is not.
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db";
import * as s from "../db/schema";
import { isRunnable } from "./runner";

/** A schedule the worker can actually act on. */
export interface DueSchedule {
  scheduleId: string;
  slug: string;
  name: string;
  /** Cron, translated from the stored rule. */
  cron: string;
  /** The zone its wall-clock times mean. */
  tz: string;
  /** Seconds of random delay, so several rules on one minute do not go at once. */
  jitterSecs: number;
  /** What to run it with. */
  args: Record<string, unknown>;
}

/** A schedule that exists and cannot be run, and why not. */
export interface UnusableSchedule {
  /** Carried so the caller can clear its `nextRunAt`: a rule that will never
   *  fire must not sit in the home screen's "NEXT UP" promising a time. */
  scheduleId: string;
  slug: string;
  reason: string;
}

export interface ScheduleReading {
  due: DueSchedule[];
  unusable: UnusableSchedule[];
}

const DAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/**
 * `FREQ=DAILY;BYHOUR=3;BYMINUTE=0` → `0 3 * * *`.
 *
 * Null for anything outside the supported four — daily, weekly by day, hourly,
 * and minutely — rather than an approximation. See the header.
 */
export function rruleToCron(rrule: string): string | null {
  const parts = new Map<string, string>();
  for (const piece of rrule.split(";")) {
    const [key, value] = piece.split("=");
    if (key && value) parts.set(key.trim().toUpperCase(), value.trim().toUpperCase());
  }

  const freq = parts.get("FREQ");
  if (!freq) return null;
  // An interval other than 1 does not survive translation: cron's `*/n` counts
  // from the top of the unit, RRULE's counts from the rule's start date, and
  // the two only agree by luck.
  if (parts.has("INTERVAL") && parts.get("INTERVAL") !== "1") return null;
  // COUNT and UNTIL bound a rule; cron has no way to say "and then stop", so a
  // job built from one would keep firing forever after it should have ceased.
  if (parts.has("COUNT") || parts.has("UNTIL")) return null;

  const minute = numberIn(parts.get("BYMINUTE"), 0, 59);
  const hour = numberIn(parts.get("BYHOUR"), 0, 23);

  switch (freq) {
    case "MINUTELY":
      return "* * * * *";
    case "HOURLY":
      return `${minute ?? 0} * * * *`;
    case "DAILY":
      if (hour === null) return null;
      return `${minute ?? 0} ${hour} * * *`;
    case "WEEKLY": {
      if (hour === null) return null;
      const byDay = parts.get("BYDAY");
      if (!byDay) return null;
      const days = byDay.split(",").map((day) => DAYS[day.trim()]);
      if (!days.length || days.some((day) => day === undefined)) return null;
      return `${minute ?? 0} ${hour} * * ${days.join(",")}`;
    }
    default:
      return null;
  }
}

/** One numeric RRULE part, or null when it is absent or not a number in range. */
function numberIn(raw: string | undefined, low: number, high: number): number | null {
  if (raw === undefined) return null;
  // BYHOUR=3,15 is legal RRULE and has no single cron hour. Refuse rather than
  // silently take the first.
  if (raw.includes(",")) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= low && value <= high ? value : null;
}

/**
 * Everything the worker should be running, read fresh.
 *
 * Four things disqualify a schedule and each is reported rather than dropped:
 * the rule is disabled, the workflow is paused, there is no code behind the
 * slug, or the rule does not translate. A schedule that silently does nothing
 * is the failure this whole file exists to correct, so nothing here is allowed
 * to fail silently.
 */
export function readSchedules(db: Db): ScheduleReading {
  const rows = db
    .select({
      scheduleId: s.workflowSchedules.id,
      rrule: s.workflowSchedules.rrule,
      tz: s.workflowSchedules.tz,
      jitterSecs: s.workflowSchedules.jitterSecs,
      args: s.workflowSchedules.args,
      slug: s.workflows.slug,
      name: s.workflows.name,
    })
    .from(s.workflowSchedules)
    .innerJoin(s.workflows, eq(s.workflows.id, s.workflowSchedules.workflowId))
    .where(and(eq(s.workflowSchedules.enabled, true), isNull(s.workflows.pausedAt)))
    .all();

  const due: DueSchedule[] = [];
  const unusable: UnusableSchedule[] = [];

  for (const row of rows) {
    if (!isRunnable(row.slug)) {
      unusable.push({ scheduleId: row.scheduleId, slug: row.slug, reason: "there is no code behind it" });
      continue;
    }
    const cron = rruleToCron(row.rrule);
    if (!cron) {
      unusable.push({
        scheduleId: row.scheduleId,
        slug: row.slug,
        reason: `this rule does not translate to cron: ${row.rrule}`,
      });
      continue;
    }
    due.push({
      scheduleId: row.scheduleId,
      slug: row.slug,
      name: row.name,
      cron,
      tz: row.tz,
      jitterSecs: row.jitterSecs,
      args: row.args ?? {},
    });
  }

  return { due, unusable };
}

/**
 * A stable summary of what the worker is running, for noticing a change.
 *
 * The worker re-reads on a timer and only rebuilds its jobs when this string
 * moves, so an unchanged database costs one query rather than a teardown and
 * rebuild of every job — and a job in flight is not cancelled by a poll that
 * found nothing new.
 */
export function scheduleFingerprint(reading: ScheduleReading): string {
  return reading.due
    .map((entry) => `${entry.scheduleId}:${entry.cron}:${entry.tz}:${JSON.stringify(entry.args)}`)
    .sort()
    .join("|");
}

/** Record that a schedule fired, and when it is next due. */
export function noteFiring(db: Db, scheduleId: string, at: Date, next: Date | null): void {
  db.update(s.workflowSchedules)
    .set({ lastRunAt: at, nextRunAt: next })
    .where(eq(s.workflowSchedules.id, scheduleId))
    .run();
}

/**
 * Write when each schedule is next due.
 *
 * Derived state, owned by the only process that can know it. Worth storing
 * because the home screen's "NEXT UP" reads it — it was null for every row
 * until now, so that list has been drawing whatever the seed happened to say.
 */
export function noteNextRuns(db: Db, next: ReadonlyMap<string, Date | null>): void {
  for (const [scheduleId, at] of next) {
    db.update(s.workflowSchedules)
      .set({ nextRunAt: at })
      .where(eq(s.workflowSchedules.id, scheduleId))
      .run();
  }
}
