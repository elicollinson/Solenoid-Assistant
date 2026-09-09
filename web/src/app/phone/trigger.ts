// Starting a run from the phone sheet, as a state machine.
//
// Kept apart from the screen because what went wrong the first time was a
// question of state and not of drawing: after a run had finished, the label
// of the run that had been accepted was still there, and the form — which
// closes itself once a run is on the record — read that as "on the record"
// and closed the moment it opened. A second parameterised run could not be
// started without leaving the tab.
//
// So a request begins clean, and everything here is scoped to the workflow
// it was made for: a sheet opened on another workflow in the same tab reads
// nothing of this one's, and a late answer for a workflow no longer open is
// not written over the one that is.
import type { WorkflowRunAccepted } from "../api";

export interface TriggerState {
  /** Which workflow the rest of this is about. */
  slug: string | null;
  pending: boolean;
  /** What the server said when it refused. Null while nothing is wrong. */
  error: string | null;
  /** "Run 3", once one has been started from here. Null before that. */
  started: string | null;
}

export const NO_TRIGGER: TriggerState = { slug: null, pending: false, error: null, started: null };

export type TriggerEvent =
  /** Run was pressed: the request that follows begins with nothing from the
   *  last one — no refusal, and no run on the record. */
  | { type: "clear"; slug: string }
  /** The request is on the wire. */
  | { type: "asked"; slug: string }
  | { type: "accepted"; slug: string; run: WorkflowRunAccepted }
  | { type: "refused"; slug: string; message: string };

export function triggerReducer(state: TriggerState, event: TriggerEvent): TriggerState {
  switch (event.type) {
    case "clear":
      return { slug: event.slug, pending: false, error: null, started: null };
    case "asked":
      return { slug: event.slug, pending: true, error: null, started: null };
    case "accepted":
      // An answer for a workflow that is no longer the one asked about is
      // the record's business, not this sheet's.
      if (state.slug !== event.slug) return state;
      return { ...state, pending: false, started: event.run.label };
    case "refused":
      if (state.slug !== event.slug) return state;
      return { ...state, pending: false, error: event.message };
    default:
      return state;
  }
}

/** What the sheet for `slug` should read off the state: its own request, or
 *  nothing at all when the last request was another workflow's. */
export function triggerFor(state: TriggerState, slug: string | null): Pick<TriggerState, "pending" | "error" | "started"> {
  if (slug == null || state.slug !== slug) return { pending: false, error: null, started: null };
  return { pending: state.pending, error: state.error, started: state.started };
}
