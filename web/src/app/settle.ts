// What a click changes, on either frame.
//
// Nothing writes to the database yet, so settling something settles it in the
// browser: the entry turns done, the aside clears, and the header recounts.
// That is the whole of what a gate button does today, and both shells do it the
// same way — which is why it lives here rather than inside the desktop's.
//
// Only the clause after the first full stop was ever a count, so only the
// clause is rewritten; the agent's own line is left exactly as written.
import { recount, spell } from "./lede";
import type { HomeAction, HomePayload } from "./api";

/**
 * What the given action closes, keyed the way the thing it closes is filtered
 * out again: a feed entry drops out by its decision id, the standing suggestion
 * by its own id.
 *
 * Looked up in the payload rather than read off the action, because the effect
 * a button carries says where to go, not what it settles. An action nothing in
 * the feed claims settles nothing, which is the right answer for a button that
 * only navigates.
 */
export function pendingDecisionFor(home: HomePayload, actionId: string): string | null {
  for (const section of home.sections) {
    for (const item of section.items) {
      if (item.decisionId && item.actions.some((a) => a.id === actionId)) return item.decisionId;
    }
  }
  const worth = home.aside.worthALook;
  if (worth?.actions.some((a) => a.id === actionId)) return worth.id;
  return null;
}

/** The header sentence and the aside both count what is still open, so a
 *  locally resolved decision has to drop out of both. */
export function withoutResolved(data: HomePayload, resolved: ReadonlySet<string>): HomePayload {
  if (resolved.size === 0) return data;
  const waiting = data.aside.waiting.filter((w) => !resolved.has(w.id));
  const worthALook = data.aside.worthALook && resolved.has(data.aside.worthALook.id) ? null : data.aside.worthALook;
  return {
    ...data,
    header: { ...data.header, lede: recount(data.header.lede, needsClause(waiting.length)) },
    aside: { ...data.aside, waiting, worthALook },
  };
}

/** How much is still stopped on you, said the way the server said it. */
export function needsClause(open: number): string {
  if (open === 0) return "Nothing needs you right now.";
  return `${spell(open)} need${open === 1 ? "s" : ""} a word from you before I go further.`;
}

/** Re-exported so a caller settling a gate does not have to know both modules. */
export type { HomeAction };
