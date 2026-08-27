// How the product renders a moment, a span and a small number.
//
// Shared because two surfaces must agree: the feed's "since 06:12" and the
// workflow list's "Running since 06:12" are the same clock, and a second copy
// of the timezone handling is a second place for it to be wrong.
import { APP_TZ } from "../schema/_shared";

const HHMM = new Intl.DateTimeFormat("en-GB", { timeZone: APP_TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const DAY_LABEL = new Intl.DateTimeFormat("en-GB", { timeZone: APP_TZ, weekday: "short", day: "numeric", month: "short" });
const SHORT_DAY = new Intl.DateTimeFormat("en-US", { timeZone: APP_TZ, month: "short", day: "numeric" });
const DAY_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: APP_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** "06:12" in the app's timezone. */
export const clock = (d: Date) => HHMM.format(d);
/** "2026-08-25" — comparable as a string, which is the point. */
export const dayKey = (d: Date) => DAY_KEY.format(d);
export const localHour = (d: Date) => Number(clock(d).slice(0, 2));
/** "Tue, 25 Aug" */
export const dayLabel = (d: Date) => DAY_LABEL.format(d);
/** "Aug 9" */
export const shortDay = (d: Date) => SHORT_DAY.format(d);

/** Numbers are spelled out in prose when small and conversational. */
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
export const spell = (n: number) => WORDS[n] ?? String(n);
export const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** "0.4s", "1.9s", "2m 04s" — mono metadata stays numeric. */
export function duration(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  // Under a tenth of a second, "0.0s" reads as "nothing happened" — which is a
  // real thing for a run to have done, and the wrong thing to say when a step
  // genuinely took 40ms. Say the milliseconds instead.
  if (ms < 100) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

/** "Today", "Yesterday", "17 Aug" — the day something happened, relative. */
export function dayName(d: Date, now: Date): string {
  const key = dayKey(d);
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  return shortDay(d);
}

/**
 * Mid-sentence: "06:12" when it is today, "yesterday, 21:04" when it is not.
 * The clause it lands in already carries the verb — "Halted yesterday, 21:04".
 */
export function stamp(d: Date, now: Date): string {
  const day = dayName(d, now);
  return day === "Today" ? clock(d) : `${day.toLowerCase()}, ${clock(d)}`;
}

/** Standalone, as a row label: "Today 06:12", "Aug 17, 06:12". */
export function stampLong(d: Date, now: Date): string {
  const day = dayName(d, now);
  return day === "Today" || day === "Yesterday" ? `${day} ${clock(d)}` : `${day}, ${clock(d)}`;
}

/** "12 min ago", or null when it is further away than that reads well. */
export function minutesAgo(d: Date, now: Date): string | null {
  const mins = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (mins < 0 || mins >= 60) return null;
  return mins <= 1 ? "just now" : `${mins} min ago`;
}

/** "06:12:04.221" — the log stream prints to the millisecond. */
export function logStamp(d: Date): string {
  const secs = String(d.getUTCSeconds()).padStart(2, "0");
  const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
  return `${clock(d)}:${secs}.${ms}`;
}

const LONG_DAY = new Intl.DateTimeFormat("en-US", { timeZone: APP_TZ, month: "short", day: "numeric", year: "numeric" });
const WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: APP_TZ, weekday: "short" });

/** "Aug 12, 2026, 16:41" — an email header carries its year. */
export const stampYear = (d: Date) => `${LONG_DAY.format(d)}, ${clock(d)}`;

/** "Thu" */
export const weekday = (d: Date) => WEEKDAY.format(d);

/** Whole days from `now` to `d`, counted by calendar day rather than by hours:
 *  something due at 09:00 tomorrow is one day away at 23:00 tonight. */
export function daysAway(d: Date, now: Date): number {
  const a = Date.parse(`${dayKey(now)}T00:00:00Z`);
  const b = Date.parse(`${dayKey(d)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * When a reminder is due, said the way you would say it: by name inside the
 * week either side of today, by date beyond it, and "No date" when the thing
 * has no date at all rather than a date of zero.
 */
export function dueStamp(d: Date | null, now: Date): string {
  if (!d) return "No date";
  const away = daysAway(d, now);
  if (away === 0) return `Today ${clock(d)}`;
  if (away === -1) return `Yesterday ${clock(d)}`;
  if (away === 1) return `Tomorrow ${clock(d)}`;
  if (away > 1 && away <= 6) return `${weekday(d)} ${clock(d)}`;
  return `${shortDay(d)}, ${clock(d)}`;
}
