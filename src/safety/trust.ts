// Where a piece of text came from, and what a flag on it means.
//
// The injection screen's question is "did somebody other than us put an
// instruction here", and that is a question about provenance, not wording. Two
// files answer it between them:
//
//   ./authoredText.ts  what THIS REPOSITORY wrote. Subtracted before the screen
//                      looks, so our own imperative tool descriptions are never
//                      mistaken for an attack on them.
//   this file          what everything else is, and what to do when it flags.
//
// The one hard-won rule here: origin is DECLARED BY THE CALLER, never inferred
// from where the text turns up in the loop. The obvious-looking shortcut — "the
// opening transcript is the user talking, so treat it leniently" — is wrong in
// this codebase, because the iMessage and screenshot workflows put a stranger's
// text into exactly that position. Inferring origin from position would have
// quietly stopped quarantining malicious messages. Default to `external` and
// make anything gentler opt in, so a caller that forgets gets the safe answer.
export type TextOrigin =
  /**
   * The person operating this assistant, typing to it. Not "the first message"
   * — actually them.
   *
   * They are the principal: they can already ask for anything the agent can do,
   * so there is no privilege here for an injection to escalate to. A flag on
   * their text means "this person may have pasted something", which is worth
   * recording and is not worth refusing to work over.
   */
  | "operator"
  /**
   * Read from the world: messages, screenshots, pages, email, a database row
   * holding text somebody else wrote. The default, and the reason the screen
   * exists.
   */
  | "external";

/** What a caller who says nothing gets. The safe one, deliberately. */
export const DEFAULT_ORIGIN: TextOrigin = "external";

/**
 * "abort" — stop the run. "observe" — record it on the span, log it, continue.
 */
export type ScreenAction = "abort" | "observe";

export const ORIGIN_ACTION: Record<TextOrigin, ScreenAction> = {
  operator: "observe",
  external: "abort",
};

export function actionFor(origin: TextOrigin | undefined): ScreenAction {
  return ORIGIN_ACTION[origin ?? DEFAULT_ORIGIN];
}
