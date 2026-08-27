// The wire shape of GET /api/recommendations and GET /api/recommendations/:id.
//
// Pure types and nothing else, for the same reason src/shared/home.ts is: the
// browser half compiles against this file and has no Bun types.
import type { HomeAction, HomeState } from "./home";
import type { ReminderEvidence } from "./reminders";

/**
 * What the agent has already agreed with you, what it is asking about, and
 * what you turned down.
 *
 * Derived from status, never stored: a suggestion moves between these three
 * shelves by being answered, and the shelf is only ever a reading of that
 * answer.
 */
export type RecommendationGroup = "Waiting on you" | "Standing" | "Set aside";

export interface RecommendationRow {
  id: string;
  title: string;
  /** The agent's one line about what it noticed. */
  blurb: string;
  state: HomeState;
  group: RecommendationGroup;
  /** What it rests on: "14 approvals · 0 rejections", "adopted aug 12 · 6 runs
   *  since". The half before the separator is derived once it is answered. */
  basis: string;
  /** "Today 06:40" while it is open, "Aug 12" once it is settled — a decision
   *  a fortnight old does not need a clock. */
  when: string;
  /** "okf:policy/spend-floor" — the rule it would become. */
  scope: string | null;
  /** The two words that settle it. Empty once it is settled. */
  actions: HomeAction[];
}

export interface RecommendationsPayload {
  /** The agent's own line, plus what is true of the list right now. */
  lede: string;
  rows: RecommendationRow[];
}

/** A pair under "This suggestion", or a line of "What changes if you say yes". */
export interface RecommendationPair {
  label: string;
  value: string;
}

export interface RecommendationDetailPayload extends RecommendationRow {
  /** "What I noticed", in the agent's voice. */
  prose: string[];
  /** Where it stopped short — the permission it is actually asking for. Null
   *  when it never had to hold back, which is every settled one. */
  restraint: string | null;
  /** What would change if you said yes. Authored: these count runs and pounds
   *  that have not happened yet. */
  effect: RecommendationPair[];
  meta: RecommendationPair[];
  /** Evidence has one shape across the product; the type is named for the
   *  surface that needed it first. */
  evidence: ReminderEvidence[];
}
