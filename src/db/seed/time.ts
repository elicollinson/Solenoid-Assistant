// Wall-clock helpers for the one timezone the product runs in.
//
// The seed anchors itself to whatever "today" is when it runs, so the home
// screen always reads as this morning rather than as a fixed date in the past.
// That means turning "today at 07:41, New York" into an instant, which needs
// the zone offset for that particular date — EST in January, EDT in July.
import { APP_TZ } from "../schema/_shared";

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: APP_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** The wall clock an instant shows in APP_TZ, re-read as if it were UTC. */
function wallClockAsUtc(instant: Date): number {
  const parts = new Map<string, string>(PARTS.formatToParts(instant).map((p) => [p.type as string, p.value]));
  const num = (key: string) => Number(parts.get(key));
  // Intl renders midnight as hour 24 rather than 0 in some ICU versions.
  const hour = num("hour") % 24;
  return Date.UTC(num("year"), num("month") - 1, num("day"), hour, num("minute"), num("second"));
}

/** The calendar date an instant falls on in APP_TZ. */
export function localDate(instant: Date): { year: number; month: number; day: number } {
  const shown = new Date(wallClockAsUtc(instant));
  return { year: shown.getUTCFullYear(), month: shown.getUTCMonth() + 1, day: shown.getUTCDate() };
}

/** "YYYY-MM-DD" in APP_TZ — the shape day_notes.onDate expects. */
export function localDateKey(instant: Date): string {
  const { year, month, day } = localDate(instant);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The instant at which the APP_TZ wall clock reads the given date and time.
 *
 * Solved rather than looked up: guess that the wall clock is UTC, measure how
 * far off that guess reads in the zone, and correct. Two passes, because a
 * correction can itself cross a DST boundary.
 */
export function zonedTime(year: number, month: number, day: number, hour: number, minute = 0): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let utc = target;
  for (let pass = 0; pass < 2; pass++) {
    // Always correct the original target, never the previous correction —
    // subtracting the offset twice lands two offsets away.
    utc = target - (wallClockAsUtc(new Date(utc)) - utc);
  }
  return new Date(utc);
}

/** The day of the week an instant falls on in APP_TZ. 0 is Sunday, the order
 *  Date.getUTCDay uses and the order the weekday tables here are written in. */
export function localWeekday(instant: Date): number {
  const { year, month, day } = localDate(instant);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * "07:41 today", "21:30 yesterday" — relative to the anchor's local date.
 * `dayOffset` is in local calendar days, so it survives a DST change.
 */
export function localTime(anchor: Date, dayOffset: number, hour: number, minute = 0): Date {
  const { year, month, day } = localDate(anchor);
  return zonedTime(year, month, day + dayOffset, hour, minute);
}
