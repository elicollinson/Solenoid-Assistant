// Whether a write may happen, asked of whoever is standing behind the run.
//
// The Agent in ./rawAgent.ts must not know what a permission is, for the same
// reason it does not know what a database is: it is the provider-generic loop,
// and every safety property it enforces arrives as an injected function — see
// `promptInjectionScreening`, which struck this bargain first.
//
// So this file is the seam and nothing else. It holds one AsyncLocalStorage and
// the two types either side of it. ../workflows/permissions.ts builds the gate
// that reads `workflow_permissions`; ../workflows/runner.ts enters it around a
// run; ./rawAgent.ts consults it and has no idea which of those exists.
//
// ## Why ambient rather than a constructor option
//
// The obvious shape is `new Agent({ consent })`, and it was the first attempt.
// It is wrong here for one concrete reason: `okfManagerAgent` is a module-level
// singleton constructed at import, long before any run exists, and it is the
// agent that writes memory out of other people's text. An option every agent
// factory has to remember to pass is a hole in exactly the place a hole is
// least affordable — and it would have been invisible, because an agent built
// without one behaves identically until the day it writes something it should
// have asked about.
//
// Ambient means the RUN decides, not the construction site: inside
// `withConsent` every agent is gated, however and whenever it was built, and
// outside one there is no gate because there is no run to have a rule about.
// A chat is the other case entirely and gates itself — see ../agents/chat.ts,
// where a person is present and the answer is a button rather than a row.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolKind } from "./tools";

/** One write, put to whoever governs this run. */
export interface ConsentRequest {
  tool: string;
  /** Always "write" today: reads are never gated, because a read changes
   *  nothing a later read would see and there is nothing to authorise. */
  kind: ToolKind;
  /** Validated arguments, not the raw payload — a call that fails its own
   *  schema is refused before anybody is asked about it. */
  args: unknown;
  /** The tool's own first sentence, for whatever has to explain the ask. */
  description: string;
}

/**
 * Allowed, or refused with the sentence the model is given.
 *
 * `tell` is prose rather than a code because its only reader is a model, and
 * the useful thing to say differs: "you are not allowed to" and "I have put
 * this to them and it is waiting" call for different next moves.
 */
export type ConsentVerdict =
  | { allow: true }
  | { allow: false; tell: string };

export type ConsentGate = (
  request: ConsentRequest,
) => ConsentVerdict | Promise<ConsentVerdict>;

const storage = new AsyncLocalStorage<ConsentGate>();

/** The gate governing the work in progress, or undefined outside a run. */
export function currentConsent(): ConsentGate | undefined {
  return storage.getStore();
}

/** Run `fn` with `gate` governing every write it reaches, however deep. */
export function withConsent<T>(gate: ConsentGate, fn: () => Promise<T>): Promise<T> {
  return storage.run(gate, fn);
}
