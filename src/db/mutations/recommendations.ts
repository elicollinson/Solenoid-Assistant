// The Recommendations surface, written to.
//
// ../queries/recommendations.ts answers "what does this screen draw". This is
// the other half, and until now there was no other half: every column in the
// table was seeded and nothing in the running product could write one. These
// are the six things that can happen to a suggestion.
//
//   propose    the agent forms one from what it has watched
//   revise     the agent sharpens the same suggestion before it is answered
//   answer     you adopt it or decline it
//   withdraw   the agent takes it back — what it noticed stopped being true
//   supersede  a newer suggestion replaces it
//   forget     it should never have been written; remove it outright
//
// Plus one that is not a status change: `cite`, which points a suggestion at
// what the agent read before it formed it. That is what fills "What I formed it
// from" on the detail pane, and a suggestion with a count in its basis and
// nothing behind it is asking to be taken on trust.
//
// Five of the six are status changes, because status is the only thing the
// three shelves are read from. None of them writes a shelf, a mark, a "when" or
// a "Waiting on you", for the reason the query file gives: a stored shelf is
// wrong the moment you answer.
//
// Every one of them answers with nothing (except `propose`, which answers with
// the id it minted) and leaves the caller to re-read. A mutation that returned
// its own idea of the new row would be a second answer to a question the next
// read settles anyway — the same bargain ./workflows.ts strikes.
import { asc, eq } from "drizzle-orm";
import { ulid, type Db } from "../index";
import {
  narrate,
  touch,
  writePairs as writeAttributePairs,
  writeProse as writeSlots,
  type Tx,
} from "./_shared";
import * as s from "../schema";

/** Thrown when the id names nothing this database knows — HTTP 404. */
export class NoSuchRecommendationError extends Error {
  constructor(id: string) {
    super(`No recommendation with id ${id}`);
    this.name = "NoSuchRecommendationError";
  }
}

/**
 * Thrown when something is asked of a suggestion its status does not allow —
 * answering one you already answered, rewriting the words on a settled one.
 * HTTP 409: the request is well formed and the row is simply not there any more.
 */
export class RecommendationSettledError extends Error {
  constructor(id: string, status: string, wanted: string) {
    super(`Cannot ${wanted} ${id}: it is already ${status}`);
    this.name = "RecommendationSettledError";
  }
}


type Row = typeof s.recommendations.$inferSelect;
type Confidence = (typeof s.CONFIDENCE)[number];
/** A `[label, value]` line of "What changes if you say yes". */
export type EffectPair = readonly [label: string, value: string];

/** What the agent knows when it forms a suggestion. */
export interface RecommendationDraft {
  /** The suggestion itself, in the agent's voice and as a thing it would do:
   *  "Let me settle vendor differences under £50 myself". */
  title: string;
  /** The one line the list row carries under the title. */
  blurb?: string;
  /** How sure the agent is while it is still asking. Defaults to worth_a_look. */
  confidence?: Confidence;
  /** "What I noticed", one string per paragraph. */
  prose?: readonly string[];
  /** Where the agent stopped short — the permission it is actually asking for. */
  restraint?: string;
  /** What it rests on, in the agent's own count: "14 approvals · 0 rejections". */
  basisLabel?: string;
  basisCount?: number;
  basisRunCount?: number;
  /** What it reaches — "Vendor reconciliation", "One contact". */
  scopeLabel?: string;
  /** The rule it would become: "okf:policy/spend-floor". */
  scopeOkfUri?: string;
  /** The workflow it would change, when it would change one. */
  scopeWorkflowId?: string;
  /** The "From" pair, in the agent's own unit: "6 runs", "5 drafts". */
  from?: string;
  /** "What changes if you say yes", in order. */
  effect?: readonly EffectPair[];
  /** The two words that settle it, both or neither. The affirm carries the
   *  specific thing being agreed to; the quiet one says what happens instead. */
  affirm?: string;
  quiet?: string;
  /** "I won't raise this again unless the finance source starts failing weekly." */
  reRaiseCondition?: string;
  reRaiseAfter?: Date;
  /** When it was formed, if that is not now — a suggestion drawn from a run
   *  that finished an hour ago was formed then. */
  formedAt?: Date;
}

/**
 * Anything a draft holds can be sharpened, including the title. Every field is
 * optional: one left out is left alone, and one given replaces what was there.
 * Pass an empty string to clear a field that has a value — there is no separate
 * null, because "" and null mean the same thing to every reader of this table.
 */
export type RecommendationRevision = Partial<Omit<RecommendationDraft, "formedAt">>;

function require_(db: Db, id: string): Row {
  const [row] = db.select().from(s.recommendations).where(eq(s.recommendations.id, id)).limit(1).all();
  if (!row) throw new NoSuchRecommendationError(id);
  return row;
}


/** Both or neither: a row with an affirm and no quiet answer offers you one
 *  way out of a question it is holding you to. */
function checkWords(draft: { affirm?: string; quiet?: string }): void {
  if ((draft.affirm == null) !== (draft.quiet == null)) {
    throw new Error("A suggestion needs both words that settle it, or neither: give affirm and quiet together");
  }
}

/* ── the writes ─────────────────────────────────────────────────────────── */

/**
 * Form a new suggestion. Answers with the id it minted.
 *
 * It lands `proposed`, which is what puts it on "Waiting on you", counts it in
 * the rail and makes it eligible for the Activity aside's card. An open
 * decision is written alongside it, because the affirm/quiet pair is a decision
 * like any other and the aside counts open decisions rather than statuses.
 */
export function proposeRecommendation(db: Db, draft: RecommendationDraft, now: Date = new Date()): string {
  checkWords(draft);
  const title = draft.title.trim();
  if (!title) throw new Error("A suggestion needs a title: it is the thing you are being asked");

  const formedAt = draft.formedAt ?? now;
  const blurb = draft.blurb?.trim() || undefined;
  const prose = (draft.prose ?? []).map((p) => p.trim()).filter(Boolean);
  const restraint = draft.restraint?.trim() || undefined;

  return db.transaction((t) => {
    const id = ulid(formedAt.getTime());
    t.insert(s.entities).values({ id, kind: "recommendation", createdAt: formedAt, updatedAt: now }).run();

    // Write order: the decision before the recommendation that names it, because
    // foreign keys here are not deferrable.
    const decisionId = ulid(formedAt.getTime());
    t.insert(s.entities).values({ id: decisionId, kind: "decision", createdAt: formedAt, updatedAt: now }).run();
    t.insert(s.decisions)
      .values({
        id: decisionId,
        subjectId: id,
        title,
        // The aside draws this sentence, falling back to the title. Its one line
        // is the blurb, not the whole account: the card is four lines tall.
        body: blurb ?? prose[0] ?? null,
        state: "open",
        blocking: false,
        openedAt: formedAt,
      })
      .run();

    t.insert(s.recommendations)
      .values({
        id,
        title,
        status: "proposed",
        confidence: draft.confidence ?? "worth_a_look",
        formedAt,
        basisLabel: draft.basisLabel?.trim() || null,
        basisCount: draft.basisCount ?? null,
        basisRunCount: draft.basisRunCount ?? null,
        scopeLabel: draft.scopeLabel?.trim() || null,
        scopeOkfUri: draft.scopeOkfUri?.trim() || null,
        scopeWorkflowId: draft.scopeWorkflowId ?? null,
        decisionId,
        reRaiseCondition: draft.reRaiseCondition?.trim() || null,
        reRaiseAfter: draft.reRaiseAfter ?? null,
      })
      .run();

    writeProse(t, id, { blurb, prose, restraint }, formedAt);
    writePairs(t, id, { from: draft.from, effect: draft.effect });
    if (draft.affirm && draft.quiet) {
      writeWords(t, id, decisionId, draft.affirm, draft.quiet, formedAt);
    }
    return id;
  });
}

/**
 * Sharpen a suggestion that has not been answered yet.
 *
 * Only while it is `proposed`. Once you have answered it, what it said is part
 * of why you answered the way you did, and rewriting it afterwards would leave
 * your answer attached to a different question.
 *
 * Fields left out are left alone; a field given replaces what was there. Prose,
 * effect pairs and the two words are lists, so each is replaced wholesale
 * rather than merged — there is no sensible way to patch the third paragraph of
 * an argument in place.
 */
export function reviseRecommendation(
  db: Db,
  id: string,
  patch: RecommendationRevision,
  now: Date = new Date(),
): void {
  checkWords(patch);
  const row = require_(db, id);
  if (row.status !== "proposed") throw new RecommendationSettledError(id, row.status, "revise");

  const title = patch.title?.trim();
  if (patch.title != null && !title) throw new Error("A suggestion needs a title");

  db.transaction((t) => {
    const set: Partial<typeof s.recommendations.$inferInsert> = {};
    if (title) set.title = title;
    if (patch.confidence) set.confidence = patch.confidence;
    if (patch.basisLabel !== undefined) set.basisLabel = patch.basisLabel.trim() || null;
    if (patch.basisCount !== undefined) set.basisCount = patch.basisCount;
    if (patch.basisRunCount !== undefined) set.basisRunCount = patch.basisRunCount;
    if (patch.scopeLabel !== undefined) set.scopeLabel = patch.scopeLabel.trim() || null;
    if (patch.scopeOkfUri !== undefined) set.scopeOkfUri = patch.scopeOkfUri.trim() || null;
    if (patch.scopeWorkflowId !== undefined) set.scopeWorkflowId = patch.scopeWorkflowId;
    if (patch.reRaiseCondition !== undefined) set.reRaiseCondition = patch.reRaiseCondition.trim() || null;
    if (patch.reRaiseAfter !== undefined) set.reRaiseAfter = patch.reRaiseAfter;
    if (Object.keys(set).length > 0) {
      t.update(s.recommendations).set(set).where(eq(s.recommendations.id, id)).run();
    }

    const blurb = patch.blurb?.trim();
    const prose = patch.prose?.map((p) => p.trim()).filter(Boolean);
    const restraint = patch.restraint?.trim();
    if (blurb !== undefined || prose !== undefined || restraint !== undefined) {
      writeProse(t, id, { blurb, prose, restraint }, now, { only: true });
    }
    if (patch.from !== undefined || patch.effect !== undefined) {
      writePairs(t, id, { from: patch.from, effect: patch.effect }, { only: true });
    }

    // The decision's body is the aside's copy of the blurb, so it moves with it.
    if (blurb !== undefined && row.decisionId) {
      t.update(s.decisions).set({ title: title ?? row.title, body: blurb || null }).where(eq(s.decisions.id, row.decisionId)).run();
    } else if (title && row.decisionId) {
      t.update(s.decisions).set({ title }).where(eq(s.decisions.id, row.decisionId)).run();
    }

    if (patch.affirm && patch.quiet && row.decisionId) {
      writeWords(t, id, row.decisionId, patch.affirm, patch.quiet, now);
    }
    touch(t, id, now);
  });
}

/** Who settled it. The agent may record an answer you gave it in conversation;
 *  it may not give one on your behalf. */
export interface Answer {
  by?: (typeof s.AUTHOR)[number];
  /** What it rests on now that it is settled — "6 runs since". The half before
   *  the separator ("adopted aug 12") is derived, so this is only the count. */
  basisLabel?: string;
  /** What followed, in the agent's words. Shown as the object's outcome. */
  outcome?: string;
  /** For an adopted one: the standing rule it actually became. This is what
   *  lets the agent later say "six runs have used it". */
  appliedPermissionId?: string;
  appliedInstructionId?: string;
}

/**
 * Adopt it or decline it.
 *
 * Both are the same write with a different word, because from the table's point
 * of view they are: a status, the date you said it, and a decision that stops
 * being open. The three shelves and the two marks fall out of that.
 *
 * The decision is resolved rather than deleted, and `chosenActionId` records
 * which of the two words you pressed — so the object can still say what you were
 * offered and what you picked, long after the buttons are gone from the screen.
 */
export function answerRecommendation(
  db: Db,
  id: string,
  stance: "adopted" | "declined",
  answer: Answer = {},
  now: Date = new Date(),
): void {
  const row = require_(db, id);
  if (row.status !== "proposed") throw new RecommendationSettledError(id, row.status, "answer");

  db.transaction((t) => {
    t.update(s.recommendations)
      .set({
        status: stance,
        decidedAt: now,
        decidedBy: answer.by ?? "user",
        ...(answer.basisLabel !== undefined ? { basisLabel: answer.basisLabel.trim() || null } : {}),
        ...(stance === "adopted"
          ? {
              appliedPermissionId: answer.appliedPermissionId ?? null,
              appliedInstructionId: answer.appliedInstructionId ?? null,
            }
          : {}),
      })
      .where(eq(s.recommendations.id, id))
      .run();

    if (row.decisionId) {
      // The word you pressed: the affirm one adopts, the quiet one declines.
      // They are ordinal 0 and 1 on the subject, written as a pair.
      const words = t
        .select({ id: s.actions.id, stance: s.actions.stance })
        .from(s.actions)
        .where(eq(s.actions.decisionId, row.decisionId))
        .orderBy(asc(s.actions.ordinal))
        .all();
      const chosen = words.find((w) => (stance === "adopted" ? w.stance === "affirm" : w.stance !== "affirm"));

      t.update(s.decisions)
        .set({
          state: "resolved",
          resolvedAt: now,
          resolvedBy: answer.by === "agent" ? "agent" : "user",
          chosenActionId: chosen?.id ?? null,
        })
        .where(eq(s.decisions.id, row.decisionId))
        .run();

      if (chosen) {
        t.update(s.actions)
          .set({ invokedAt: now, invokedBy: answer.by === "agent" ? "agent" : "user", invokeState: "ok" })
          .where(eq(s.actions.id, chosen.id))
          .run();
      }
    }

    if (answer.outcome?.trim()) narrate(t, id, "outcome", answer.outcome.trim(), now);
    touch(t, id, now);
  });
}

/**
 * Take it back.
 *
 * The agent's own move, not yours, and the mark says so: a withdrawn suggestion
 * sits on "Set aside" alongside the ones you declined but draws the failed mark
 * rather than the idle one. Something you turned down is quiet; something the
 * agent took back is not, because what it thought it had noticed turned out not
 * to be there.
 *
 * The decision is dismissed rather than resolved — nobody answered it.
 */
export function withdrawRecommendation(
  db: Db,
  id: string,
  because?: string,
  now: Date = new Date(),
): void {
  const row = require_(db, id);
  if (row.status !== "proposed") throw new RecommendationSettledError(id, row.status, "withdraw");
  db.transaction((t) => settle(t, row, "withdrawn", because, now));
}

/**
 * Replace it with a newer one.
 *
 * Both rows stay. The old one moves to "Set aside" reading "Superseded", and a
 * `supersedes` edge points from the new one at it, so the newer suggestion can
 * show what it grew out of instead of appearing from nowhere.
 */
export function supersedeRecommendation(
  db: Db,
  id: string,
  byId: string,
  because?: string,
  now: Date = new Date(),
): void {
  if (id === byId) throw new Error("A suggestion cannot supersede itself");
  const row = require_(db, id);
  const successor = require_(db, byId);
  if (row.status !== "proposed") throw new RecommendationSettledError(id, row.status, "supersede");

  db.transaction((t) => {
    settle(t, row, "superseded", because, now);
    t.insert(s.links)
      .values({
        id: ulid(now.getTime()),
        fromId: successor.id,
        toId: row.id,
        rel: "supersedes",
        createdAt: now,
        createdBy: "agent",
      })
      .onConflictDoNothing()
      .run();
  });
}

/** Shared tail of withdraw and supersede: the agent closing its own question. */
function settle(t: Tx, row: Row, status: "withdrawn" | "superseded", because: string | undefined, now: Date): void {
  t.update(s.recommendations)
    .set({ status, decidedAt: now, decidedBy: "agent" })
    .where(eq(s.recommendations.id, row.id))
    .run();

  if (row.decisionId) {
    t.update(s.decisions)
      .set({ state: "dismissed", resolvedAt: now, resolvedBy: "agent" })
      .where(eq(s.decisions.id, row.decisionId))
      .run();
  }
  if (because?.trim()) narrate(t, row.id, "outcome", because.trim(), now);
  touch(t, row.id, now);
}

/**
 * Remove it outright.
 *
 * The only one of the six that loses information, and it is here for the case
 * the other five do not cover: a suggestion that should never have been written
 * — a duplicate, or one formed from a misreading — where leaving it on "Set
 * aside" as withdrawn would be filing a mistake rather than fixing it. Prefer
 * `withdrawRecommendation` for anything the agent genuinely offered and then
 * thought better of; that is the history worth keeping.
 *
 * `entities` cascades into the narratives, pairs, buttons, evidence and edges.
 * The decision behind it is a separate entity and does not cascade from this
 * one, so it is deleted by name — otherwise its `entities` row survives as an
 * orphan and `v_needs_you` keeps drawing an open question about a suggestion
 * nothing can open.
 */
export function forgetRecommendation(db: Db, id: string): void {
  const row = require_(db, id);
  db.transaction((t) => {
    const decisions = t
      .select({ id: s.decisions.id })
      .from(s.decisions)
      .where(eq(s.decisions.subjectId, id))
      .all();
    for (const d of decisions) t.delete(s.entities).where(eq(s.entities.id, d.id)).run();
    if (row.decisionId && !decisions.some((d) => d.id === row.decisionId)) {
      t.delete(s.entities).where(eq(s.entities.id, row.decisionId)).run();
    }
    t.delete(s.entities).where(eq(s.entities.id, id)).run();
  });
}

/** One thing the agent read, and what it took from it. */
export interface Citation {
  /** The entity being cited: a conversation, a screenshot, a fetched page.
   *  It has to exist already — evidence points at what was actually read. */
  sourceId: string;
  /** What this citation calls the source. Null keeps the source's own name.
   *  The two differ on purpose: a page headed "Renewing a resident parking
   *  permit" is cited as the part of it that mattered. */
  title?: string;
  /** Why it was kept. The same email cited from two places earns two sentences. */
  why?: string;
  /** The clause that mattered, quoted. Stored rather than indexed, so a
   *  re-fetch can re-anchor instead of silently highlighting the wrong line. */
  quote?: string;
}

/**
 * Point a suggestion at what it was formed from.
 *
 * Appends by default, because evidence arrives as the agent finds it. Pass
 * `replace` to swap the whole list — the same rule the prose and the effect
 * pairs follow.
 *
 * Citing the same source twice with the same pin is a no-op rather than an
 * error: two runs noticing the same email is exactly what a standing suggestion
 * is made of, and it should not be the second one that fails.
 *
 * Answers with how many citations are now on the suggestion.
 */
export function citeForRecommendation(
  db: Db,
  id: string,
  citations: readonly Citation[],
  opts: { replace?: boolean } = {},
  now: Date = new Date(),
): number {
  require_(db, id);

  return db.transaction((t) => {
    if (opts.replace) t.delete(s.evidenceLinks).where(eq(s.evidenceLinks.subjectId, id)).run();

    const existing = t
      .select({ ordinal: s.evidenceLinks.ordinal })
      .from(s.evidenceLinks)
      .where(eq(s.evidenceLinks.subjectId, id))
      .all();
    let ordinal = existing.reduce((high, e) => Math.max(high, e.ordinal + 1), 0);

    for (const citation of citations) {
      const [source] = t.select({ id: s.entities.id }).from(s.entities).where(eq(s.entities.id, citation.sourceId)).limit(1).all();
      if (!source) throw new Error(`Nothing to cite with id ${citation.sourceId}: evidence points at what was read`);

      t.insert(s.evidenceLinks)
        .values({
          id: ulid(now.getTime()),
          subjectId: id,
          sourceId: citation.sourceId,
          ordinal: ordinal++,
          title: citation.title?.trim() || null,
          why: citation.why?.trim() || null,
          pinKind: citation.quote?.trim() ? "range" : "whole",
          pinQuote: citation.quote?.trim() || null,
          addedBy: "agent",
          addedAt: now,
        })
        .onConflictDoNothing()
        .run();
    }
    touch(t, id, now);

    return t.select({ id: s.evidenceLinks.id }).from(s.evidenceLinks).where(eq(s.evidenceLinks.subjectId, id)).all().length;
  });
}

/* ── the pieces each write shares ───────────────────────────────────────── */


/**
 * The blurb, the account and the restraint.
 *
 * Each slot is rewritten whole. `only` says the caller is patching, so a slot
 * it did not mention keeps what it had; without it every slot is written, which
 * is what a fresh suggestion wants.
 */
function writeProse(
  t: Tx,
  id: string,
  text: { blurb?: string; prose?: readonly string[]; restraint?: string },
  now: Date,
  opts: { only?: boolean } = {},
): void {
  writeSlots(t, id, { blurb: text.blurb, account: text.prose, restraint: text.restraint }, now, opts);
}

/**
 * The "From" pair and the "What changes if you say yes" lines.
 *
 * "From" is the one pair under "This suggestion" that is not a reading of a
 * column — five drafts is not five runs — so it is stored, at meta ordinal 0.
 * The other three are derived at query time and nothing here writes them.
 */
function writePairs(
  t: Tx,
  id: string,
  pairs: { from?: string; effect?: readonly EffectPair[] },
  opts: { only?: boolean } = {},
): void {
  if (!opts.only || pairs.from !== undefined) {
    writeAttributePairs(t, id, "meta", pairs.from?.trim() ? [["From", pairs.from]] : []);
  }
  if (!opts.only || pairs.effect !== undefined) {
    writeAttributePairs(t, id, "effect", pairs.effect ?? []);
  }
}

/**
 * The two words that settle it.
 *
 * Written as a pair and replaced as a pair: `actions_subject_ordinal` is unique
 * on (subject, ordinal), so rewriting one word without clearing the old row
 * fails rather than replacing it.
 *
 * The affirm is `set_policy` because saying yes is what turns the suggestion
 * into a standing rule; the quiet one is `resolve`, because saying no is only
 * the closing of the question.
 */
function writeWords(t: Tx, id: string, decisionId: string, affirm: string, quiet: string, now: Date): void {
  t.delete(s.actions).where(eq(s.actions.subjectId, id)).run();
  const words = [
    { label: affirm.trim(), stance: "affirm" as const, effectKind: "set_policy" as const },
    { label: quiet.trim(), stance: "quiet" as const, effectKind: "resolve" as const },
  ];
  words.forEach((w, i) => {
    t.insert(s.actions)
      .values({
        id: ulid(),
        subjectId: id,
        decisionId,
        ordinal: i,
        label: w.label,
        stance: w.stance,
        effectKind: w.effectKind,
        effect: {},
        createdAt: now,
      })
      .run();
  });
}
