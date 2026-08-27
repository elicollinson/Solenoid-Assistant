// The vocabularies the kit renders. These mirror src/db/schema/_shared.ts —
// the four Bauhaus states plus the quiet fifth, and the signal names used for
// left borders and dots. Keeping them here rather than importing from the
// server keeps the browser bundle free of Bun-only modules; the API contract
// in src/app/api.ts is what holds the two halves together.

/** needs you (amber triangle), running (green ring), done (blue square),
 *  failed (rust diamond), and idle (hollow outline). */
export type State = "attention" | "running" | "done" | "failed" | "idle";

/** The four signal hues, addressable as `var(--signal-${signal})`. */
export type Signal = "amber" | "green" | "rust" | "info";

/** What a thing on the calendar canvas is: a person's commitment, one of my
 *  runs, a point in time, or a slot I am only offering. */
export type CalendarKind = "event" | "run" | "reminder" | "hold";

/** Trace and log vocabularies. */
export type StepState = "ok" | "running" | "failed" | "waiting" | "skipped";
export type LogLevel = "info" | "ok" | "warn" | "error";

/** The five things the agent can cite. */
export type EvidenceKind = "thread" | "email" | "screenshot" | "chat" | "article";
