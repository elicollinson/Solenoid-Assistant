// The Recommendations surface: the list, and everything behind one suggestion.
//
// The design's fixtures store the shelf ("Waiting on you"), the mark, the word
// for how sure the agent is ("In force"), the when ("Aug 11") and the header's
// count as display strings. Every one of those is a reading of two columns —
// the status and the date you answered it — so every one is computed here. A
// stored "Waiting on you" is wrong the moment you answer.
//
// What is not derivable is the agent's writing: what it noticed, where it
// stopped, what it says would change, and the one pair that counts something
// the database holds no rows for. Those are read as written.
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../index";
import * as s from "../schema";
import type {
  RecommendationDetailPayload,
  RecommendationGroup,
  RecommendationPair,
  RecommendationRow,
  RecommendationsPayload,
} from "../../shared/recommendations";
import type { HomeAction, HomeState } from "../../shared/home";
import { capitalise, dayName, spell, stampLong } from "./_format";
import { surfaceNote } from "./_surface";
import { evidenceFor } from "./_evidence";

export type * from "../../shared/recommendations";

type Recommendation = typeof s.recommendations.$inferSelect;
type Status = (typeof s.RECOMMENDATION_STATUS)[number];

/** The order the list draws them in. */
export const GROUPS: readonly RecommendationGroup[] = ["Waiting on you", "Standing", "Set aside"];

/**
 * Which shelf a suggestion sits on.
 *
 * Three shelves for five statuses: from where you sit, a suggestion the agent
 * withdrew and one you turned down are both no longer being asked, however
 * differently they got there. The mark below is what keeps them apart.
 */
const SHELF: Record<Status, RecommendationGroup> = {
  proposed: "Waiting on you",
  adopted: "Standing",
  declined: "Set aside",
  withdrawn: "Set aside",
  superseded: "Set aside",
};

/** Something you turned down is quiet; something I took back is not. */
const MARK: Record<Status, HomeState> = {
  proposed: "attention",
  adopted: "done",
  declined: "idle",
  withdrawn: "failed",
  superseded: "idle",
};

/** The verb over the date in the aside's first pair, and in the basis. */
const VERB: Record<Status, string> = {
  proposed: "Formed",
  adopted: "Adopted",
  declined: "Declined",
  withdrawn: "Dropped",
  superseded: "Superseded",
};

/**
 * How sure the agent is — but only while it is still asking. Once you have
 * answered, the honest word is your answer: a declined suggestion is not
 * "worth a look", whatever the agent thought of it at the time.
 */
const CONFIDENCE: Record<(typeof s.CONFIDENCE)[number], string> = {
  strong: "Strong",
  worth_a_look: "Worth a look",
  weak: "Weak",
};

/** …and once you have, the word for where it stands. Not the same word as the
 *  verb above: you declined it once, and it has been in force ever since. */
const STANDING: Record<Exclude<Status, "proposed">, string> = {
  adopted: "In force",
  declined: "Declined",
  withdrawn: "Dropped",
  superseded: "Superseded",
};

function strengthOf(r: Recommendation): string {
  return r.status === "proposed" ? CONFIDENCE[r.confidence] : STANDING[r.status];
}

/**
 * When, said the way you would say it.
 *
 * Something formed this morning is dated to the minute, because you may well
 * remember the run it came out of. Something you answered a fortnight ago is
 * dated to the day: the clock on it stopped mattering the moment you answered.
 */
function whenOf(r: Recommendation, now: Date): string {
  return r.decidedAt ? dayName(r.decidedAt, now) : stampLong(r.formedAt, now);
}

/**
 * What the suggestion rests on.
 *
 * While it is open that is only the agent's count. Once you have answered it,
 * your answer and its date come first — "adopted aug 12 · 6 runs since" — and
 * both of those are columns, so only the clause after them is read as written.
 */
function basisOf(r: Recommendation, now: Date): string {
  const counted = r.basisLabel ?? "";
  if (r.status === "proposed" || !r.decidedAt) return counted;
  const answered = `${VERB[r.status].toLowerCase()} ${dayName(r.decidedAt, now).toLowerCase()}`;
  return [answered, counted].filter(Boolean).join(" · ");
}

/**
 * The buttons.
 *
 * Only a suggestion still waiting on you has any. A settled one keeps the two
 * words it was answered with in the fixture, and the design keeps them on the
 * object too — but sending a button the surface will never draw is how a row
 * ends up offering to settle something that is already settled.
 */
function actionsFor(bySubject: Map<string, HomeAction[]>, r: Recommendation): HomeAction[] {
  return r.status === "proposed" ? (bySubject.get(r.id) ?? []) : [];
}

function rowFor(r: Recommendation, blurb: string, actions: HomeAction[], now: Date): RecommendationRow {
  return {
    id: r.id,
    title: r.title,
    blurb,
    state: MARK[r.status],
    group: SHELF[r.status],
    basis: basisOf(r, now),
    when: whenOf(r, now),
    scope: r.scopeOkfUri,
    actions,
  };
}

/**
 * The row's one line.
 *
 * A suggestion with nothing but its account falls back to the first paragraph
 * of it rather than drawing an empty row: the standup one the Activity aside
 * draws is a single sentence that does both jobs, and writing it twice into two
 * slots would be two places for it to drift.
 */
function blurbs(db: Db): Map<string, string> {
  const bySubject = new Map<string, string>();
  for (const n of db
    .select()
    .from(s.narratives)
    .where(eq(s.narratives.slot, "account"))
    .orderBy(desc(s.narratives.ordinal))
    .all()) {
    bySubject.set(n.subjectId, n.text);
  }
  for (const n of db.select().from(s.narratives).where(eq(s.narratives.slot, "blurb")).all()) {
    bySubject.set(n.subjectId, n.text);
  }
  return bySubject;
}

function actionsBySubject(db: Db): Map<string, HomeAction[]> {
  const bySubject = new Map<string, HomeAction[]>();
  for (const a of db.select().from(s.actions).orderBy(asc(s.actions.ordinal)).all()) {
    const list = bySubject.get(a.subjectId) ?? [];
    list.push({ id: a.id, label: a.label, stance: a.stance, effectKind: a.effectKind, effect: a.effect });
    bySubject.set(a.subjectId, list);
  }
  return bySubject;
}

export function loadRecommendations(db: Db, now: Date = new Date()): RecommendationsPayload {
  const blurb = blurbs(db);
  const actions = actionsBySubject(db);

  const rows = db
    .select()
    .from(s.recommendations)
    .all()
    // Newest first inside a shelf: what I formed this morning is what you have
    // not seen, and what you settled longest ago is what you least need again.
    .map((r) => ({ row: rowFor(r, blurb.get(r.id) ?? "", actionsFor(actions, r), now), rank: rankOf(r) }))
    .sort((a, b) => GROUPS.indexOf(a.row.group) - GROUPS.indexOf(b.row.group) || b.rank - a.rank)
    .map((r) => r.row);

  return { lede: [surfaceNote(db, "recommendations"), waitingClause(rows)].filter(Boolean).join(" "), rows };
}

/** When it last moved: when you answered it, or when I formed it if you have
 *  not. */
function rankOf(r: Recommendation): number {
  return (r.decidedAt ?? r.formedAt).getTime();
}

/** The clause the design writes about how many are yours to answer. */
function waitingClause(rows: readonly RecommendationRow[]): string {
  const open = rows.filter((r) => r.group === "Waiting on you").length;
  if (open === 0) return "Nothing is waiting on you right now.";
  if (open === 1) return "One is waiting on you, and I haven't acted on it.";
  return `${capitalise(spell(open))} are waiting on you, and I haven't acted on any of them.`;
}

export function loadRecommendation(db: Db, id: string, now: Date = new Date()): RecommendationDetailPayload | null {
  const [rec] = db.select().from(s.recommendations).where(eq(s.recommendations.id, id)).limit(1).all();
  if (!rec) return null;

  const prose = db
    .select({ text: s.narratives.text })
    .from(s.narratives)
    .where(and(eq(s.narratives.subjectId, rec.id), eq(s.narratives.slot, "account")))
    .orderBy(asc(s.narratives.ordinal))
    .all()
    .map((n) => n.text);

  const [restraint] = db
    .select({ text: s.narratives.text })
    .from(s.narratives)
    .where(and(eq(s.narratives.subjectId, rec.id), eq(s.narratives.slot, "restraint")))
    .limit(1)
    .all();

  const [blurb] = db
    .select({ text: s.narratives.text })
    .from(s.narratives)
    .where(and(eq(s.narratives.subjectId, rec.id), eq(s.narratives.slot, "blurb")))
    .limit(1)
    .all();

  return {
    ...rowFor(rec, blurb?.text ?? prose[0] ?? "", actionsFor(actionsBySubject(db), rec), now),
    prose,
    restraint: restraint?.text ?? null,
    effect: pairs(db, rec.id, "effect"),
    meta: metaFor(db, rec, now),
    evidence: evidenceFor(db, rec.id, now),
  };
}

function pairs(db: Db, subjectId: string, group: (typeof s.ATTRIBUTE_GROUP)[number]): RecommendationPair[] {
  return db
    .select()
    .from(s.attributes)
    .where(and(eq(s.attributes.subjectId, subjectId), eq(s.attributes.groupSlot, group)))
    .orderBy(asc(s.attributes.ordinal))
    .all()
    .map((a) => ({ label: a.label, value: a.value }));
}

/**
 * The pairs under "This suggestion".
 *
 * Three of the four are readings of columns: when it was formed or answered and
 * which of the two that date is, how sure the agent is or what you said, and
 * what it reaches. The fourth counts what the suggestion was drawn from, in the
 * agent's own unit — five drafts is not five runs — so it is read as written,
 * and it sits second because that is where the design puts it.
 */
function metaFor(db: Db, r: Recommendation, now: Date): RecommendationPair[] {
  const meta: RecommendationPair[] = [
    { label: VERB[r.status], value: stampLong(r.decidedAt ?? r.formedAt, now) },
    ...pairs(db, r.id, "meta"),
    { label: "Confidence", value: strengthOf(r) },
  ];
  if (r.scopeLabel) meta.push({ label: "Scope", value: r.scopeLabel });
  return meta;
}
