// The handful of argument shapes every group needs, agreed once.
//
// Ten groups were written in parallel, and each one independently invented a
// way to say "an instant", "how many", and "a date the model has no business
// reading as a wall clock". That is fine for a helper nobody sees. It is not
// fine here, because these are the ARGUMENTS A MODEL PASSES, and a model that
// learns one group's spelling carries it to the next.
//
// The case that made this a file rather than a note: `z.string().datetime()`
// refuses an offset, so `2026-08-25T10:00:00-04:00` was accepted by
// calendar_create and refused by reminders_create. This product runs in one
// timezone (APP_TZ, America/New_York), so an offset-bearing timestamp is the
// natural thing for a model to produce and the failure would have looked
// arbitrary from the inside: the same string, the same run, two answers.
//
// Prefix `_` like ../db/queries/_format.ts and its siblings: shared machinery
// for the directory it sits in, not a group of its own.
import { z } from "zod";

/**
 * An ISO 8601 instant, with the offset allowed.
 *
 * A bare wall clock is refused on purpose. "2026-08-25T10:00" does not say
 * which moment it means, and a product with one timezone is exactly where that
 * ambiguity goes unnoticed until it is an hour out.
 */
export const instant = z
  .string()
  .datetime({ offset: true })
  .describe(
    "An ISO 8601 instant, either in UTC ('2026-08-25T14:00:00Z') or with an explicit offset " +
      "('2026-08-25T10:00:00-04:00'). A bare wall clock is refused: it does not say which moment it means.",
  );

/**
 * How many rows to answer with.
 *
 * The caps differ between groups for real reasons — a log reads in hundreds of
 * lines, a search in tens — so they are arguments rather than a constant. What
 * does not differ is that the model deserves to be told which end of the list
 * the cap keeps, and six of the ten groups were shipping this parameter with no
 * description at all.
 */
export function limit(options: { max?: number; default?: number; keeps?: string } = {}) {
  const max = options.max ?? 200;
  const fallback = options.default ?? 50;
  return z
    .number()
    .int()
    .positive()
    .max(max)
    .default(fallback)
    .describe(
      `How many to answer with, at most ${max}. Defaults to ${fallback}. ` +
        `The cap keeps ${options.keeps ?? "the newest"} and drops the rest, so a full page means ` +
        `there is more behind it — narrow the filters rather than raising this.`,
    );
}

/**
 * A timestamp as a model should read it, or null.
 *
 * Three groups wrote this function under three names and six more inlined it.
 * No model reads a raw millisecond count, and every one of them reads an ISO
 * string, so the conversion belongs at the boundary and belongs once.
 */
export const iso = (at: Date | null | undefined): string | null => at?.toISOString() ?? null;

/** A `[label, value]` line, as the tools take it and the attributes table stores it. */
export type Pair = readonly [label: string, value: string];

/**
 * The label/value pairs a surface draws, with the examples that make them
 * concrete. Every group's are different, which is why the examples are
 * arguments and the shape is not.
 */
export function pairs(labelExample: string, valueExample: string) {
  return z.array(
    z.object({
      label: z.string().min(1).describe(`The left column, e.g. '${labelExample}'.`),
      value: z.string().min(1).describe(`The right column, e.g. '${valueExample}'.`),
    }),
  );
}

/** `[{label, value}]` as the mutations take it. */
export const toPairs = (given: ReadonlyArray<{ label: string; value: string }>): Pair[] =>
  given.map((pair) => [pair.label, pair.value] as const);
