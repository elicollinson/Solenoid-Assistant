// The Workflows surface, written to.
//
// Everything under ../queries answers "what does this screen draw". This is the
// other half: what can be changed about a workflow that already exists —
// whether it is paused, what standing rule it runs under, what it says about
// itself, when it fires, and what it is allowed to do unaccompanied.
//
// What is deliberately NOT here is the workflow itself. A workflow exists
// because src/workflows/catalog.ts names it and src/workflows/registry.ts has
// code behind it; src/workflows/sync.ts copies that list into the table. There
// is no createWorkflow and no deleteWorkflow, because a row written here with
// no entry behind it would be a list line whose Run control is a lie, and a row
// deleted here would come back on the next boot.
//
// Starting and stopping a run are not here either: those are the runner's, in
// src/workflows/runner.ts, because both of them are the process rather than the
// record.
//
// Each one answers with nothing and leaves the caller to re-read. The screen is
// already re-reading on a timer while a run is going, and a mutation that
// returns its own idea of the new state is a second answer to a question the
// next read settles anyway.
import { and, desc, eq, isNull } from "drizzle-orm";
import { ulid, type Db } from "../index";
import * as s from "../schema";
import { clearSlot, narrate, touch, writePairs, type Pair } from "./_shared";

/** Thrown when the slug names nothing this database knows — HTTP 404. */
export class NoSuchWorkflowError extends Error {
  constructor(slug: string) {
    super(`No workflow called ${slug}`);
    this.name = "NoSuchWorkflowError";
  }
}

/** Thrown when a capability is revoked that nothing currently grants — HTTP 404.
 *  Distinct from "no such workflow": the workflow is real and the rule is not. */
export class NoSuchWorkflowPermissionError extends Error {
  constructor(slug: string, capability: string) {
    super(`Workflow ${slug} has no live permission for ${capability}`);
    this.name = "NoSuchWorkflowPermissionError";
  }
}

/**
 * Who is making the change.
 *
 * Written down rather than assumed because these columns are read back as
 * provenance: "paused by you" and "paused by me" are different sentences, and
 * only one of them is true. An agent recording its own act as the user's is
 * forging a decision nobody made.
 */
export interface Authorship {
  by?: (typeof s.AUTHOR)[number];
}

function require_(db: Db, slug: string): typeof s.workflows.$inferSelect {
  const [workflow] = db.select().from(s.workflows).where(eq(s.workflows.slug, slug)).limit(1).all();
  if (!workflow) throw new NoSuchWorkflowError(slug);
  return workflow;
}

/** Why it was stopped, on top of who stopped it. */
export interface PauseOptions extends Authorship {
  /** In the pauser's own words: "the finance source has failed four mornings
   *  running". Kept only while it is paused; resuming clears it, because a
   *  reason for a pause that is over is a reason for nothing. */
  reason?: string;
}

/**
 * Pause or resume, and say who did it.
 *
 * Pausing is the product's decision rather than the catalog's, which is why
 * src/workflows/sync.ts never touches these three columns: a restart must not
 * quietly resume something you stopped.
 *
 * Pausing what is already paused is a no-op rather than a re-stamp. The
 * timestamp is the answer to "since when", and answering it again with today's
 * date would lose the only fact it carries.
 */
export function setWorkflowPaused(
  db: Db,
  slug: string,
  paused: boolean,
  now: Date = new Date(),
  options: PauseOptions = {},
): void {
  const workflow = require_(db, slug);
  if ((workflow.pausedAt != null) === paused) return;

  db.update(s.workflows)
    .set(
      paused
        ? { pausedAt: now, pausedBy: options.by ?? "user", pauseReason: options.reason?.trim() || null }
        : { pausedAt: null, pausedBy: null, pauseReason: null },
    )
    .where(eq(s.workflows.id, workflow.id))
    .run();
}

/**
 * Replace the standing instruction, keeping the one it replaced.
 *
 * A new row rather than an UPDATE: the table is versioned, and a rule you gave
 * a workflow in June is part of why a run in June did what it did. The old one
 * is retired and pointed at from the new one, so the chain reads backwards.
 *
 * Empty text retires the current rule without writing a replacement — "run it
 * the way it was set up" is the absence of an instruction, not an instruction
 * saying so.
 */
export function setWorkflowInstructions(
  db: Db,
  slug: string,
  text: string,
  now: Date = new Date(),
  options: Authorship = {},
): void {
  const workflow = require_(db, slug);
  const trimmed = text.trim();

  const [active] = db
    .select()
    .from(s.workflowInstructions)
    .where(and(eq(s.workflowInstructions.workflowId, workflow.id), isNull(s.workflowInstructions.retiredAt)))
    .orderBy(desc(s.workflowInstructions.version))
    .limit(1)
    .all();

  if (active?.text === trimmed) return;

  db.transaction((t) => {
    if (active) {
      t.update(s.workflowInstructions)
        .set({ retiredAt: now })
        .where(eq(s.workflowInstructions.id, active.id))
        .run();
    }
    if (!trimmed) return;

    t.insert(s.workflowInstructions)
      .values({
        id: ulid(now.getTime()),
        workflowId: workflow.id,
        text: trimmed,
        authoredBy: options.by ?? "user",
        version: (active?.version ?? 0) + 1,
        effectiveFrom: now,
        supersedesId: active?.id ?? null,
      })
      .run();
  });
}

/**
 * Rewrite the agent's account of where this workflow stands.
 *
 * Not the same thing as what the workflow is FOR: that is the catalog entry's
 * `description`, which lives in code and is nobody's to edit from here. This is
 * the sentence under the name on the detail pane — what has been happening, in
 * the agent's voice, and therefore true only until the next run changes it.
 *
 * One row per workflow, replaced rather than versioned: unlike an instruction,
 * a superseded summary is not part of why any run did anything. Empty text
 * removes it, and the pane draws nothing rather than a stale line.
 */
export function setWorkflowSummary(db: Db, slug: string, text: string, now: Date = new Date()): void {
  const workflow = require_(db, slug);
  const trimmed = text.trim();

  db.transaction((t) => {
    // Delete then insert rather than upsert: `narratives_slot_unique` is on
    // (subject, slot, surface, ordinal), so a row already written for one
    // surface would collide with the "any" copy this writes instead of being
    // replaced by it. Clearing the slot outright is the only way to end up with
    // exactly one summary.
    t.delete(s.narratives)
      .where(and(eq(s.narratives.subjectId, workflow.id), eq(s.narratives.slot, "summary")))
      .run();
    if (!trimmed) return;

    t.insert(s.narratives)
      .values({
        id: ulid(now.getTime()),
        subjectId: workflow.id,
        slot: "summary",
        surface: "any",
        ordinal: 0,
        text: trimmed,
        authoredBy: "agent",
        generatedAt: now,
      })
      .run();
  });
}

/** When a workflow fires, and the words the table shows for it. */
export interface ScheduleChange {
  /** An RRULE, not a prose cadence: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6". */
  rrule: string;
  /** What the cadence column reads: "Weekdays, 06:00". Rendered from nothing —
   *  the rule is not turned into English anywhere, so this is written. */
  cadence: string;
  /** IANA zone. Defaults to the app's on a schedule that has none yet. */
  tz?: string;
  /** Seconds of random delay, so a dozen 06:00 schedules do not all fire at
   *  once. Left alone when omitted. */
  jitterSecs?: number;
}

/**
 * Set when a workflow fires, creating its schedule row if it had none.
 *
 * `nextRunAt` is cleared whenever the rule or the zone moves, because it was
 * computed from the old one: a stale next-fire is worse than an absent one,
 * since the Home screen draws it as a promise. The cron worker owns filling it
 * back in, and this file does not guess.
 *
 * There is no unschedule. Dropping the row would make the workflow read
 * "Unscheduled" while the reason it stopped running went unrecorded; the way to
 * stop a workflow is `setWorkflowPaused`, which says who did it and when.
 */
export function setWorkflowSchedule(db: Db, slug: string, change: ScheduleChange, now: Date = new Date()): void {
  const workflow = require_(db, slug);
  const rrule = change.rrule.trim();
  const cadence = change.cadence.trim();
  if (!rrule) throw new Error("A schedule needs an rrule: pause the workflow rather than emptying its rule");
  if (!cadence) throw new Error("A schedule needs a cadence in words: it is what the table shows instead of the rule");

  const [existing] = db
    .select()
    .from(s.workflowSchedules)
    .where(eq(s.workflowSchedules.workflowId, workflow.id))
    .limit(1)
    .all();

  if (!existing) {
    db.insert(s.workflowSchedules)
      .values({
        id: ulid(now.getTime()),
        workflowId: workflow.id,
        rrule,
        label: cadence,
        ...(change.tz ? { tz: change.tz } : {}),
        ...(change.jitterSecs === undefined ? {} : { jitterSecs: change.jitterSecs }),
      })
      .run();
    return;
  }

  const moved = existing.rrule !== rrule || (change.tz !== undefined && change.tz !== existing.tz);
  db.update(s.workflowSchedules)
    .set({
      rrule,
      label: cadence,
      ...(change.tz ? { tz: change.tz } : {}),
      ...(change.jitterSecs === undefined ? {} : { jitterSecs: change.jitterSecs }),
      ...(moved ? { nextRunAt: null } : {}),
    })
    .where(eq(s.workflowSchedules.id, existing.id))
    .run();
}

/** One thing a workflow may do, and how far it may go doing it. */
export interface PermissionGrant extends Authorship {
  /** What it covers, in the vocabulary the rest of the app already uses:
   *  "spend", "calendar.write", "email.send". One live rule per capability. */
  capability: string;
  /** "allow" runs it unaccompanied; "ask" opens a gate the run waits on;
   *  "deny" refuses outright. */
  mode: (typeof s.PERMISSION_MODE)[number];
  /** The ceiling, in USD cents, where the capability is one with a number on
   *  it. Meaningless on one that has none, and left null there. */
  limitAmountCents?: number;
  /** The rule in memory this came from: "okf:policy/spend-floor". */
  okfPolicyUri?: string;
}

/**
 * Write the live rule for one capability, retiring the rule it replaces.
 *
 * Versioned like the instructions and for the same reason: a run in June ran
 * under June's permissions, and an UPDATE would leave the record saying it ran
 * under today's. `workflow_permissions_active` is a partial unique index over
 * the un-retired rows, so retiring first is not tidiness — an insert alongside
 * a live row for the same capability fails.
 *
 * Per-workflow only. The table's null `workflowId` means a rule that governs
 * everything at once, which is not a thing to reach through a tool pointed at
 * one workflow.
 */
export function grantWorkflowPermission(
  db: Db,
  slug: string,
  grant: PermissionGrant,
  now: Date = new Date(),
): void {
  const workflow = require_(db, slug);
  const capability = grant.capability.trim();
  if (!capability) throw new Error("A permission needs a capability: it is the thing being allowed or refused");

  db.transaction((t) => {
    t.update(s.workflowPermissions)
      .set({ retiredAt: now })
      .where(livePermission(workflow.id, capability))
      .run();

    t.insert(s.workflowPermissions)
      .values({
        id: ulid(now.getTime()),
        workflowId: workflow.id,
        capability,
        mode: grant.mode,
        limitAmountCents: grant.limitAmountCents ?? null,
        okfPolicyUri: grant.okfPolicyUri?.trim() || null,
        createdAt: now,
        createdBy: grant.by ?? "user",
      })
      .run();
  });
}

/**
 * Retire the live rule for one capability without writing a replacement.
 *
 * The workflow then falls back to whatever governs it globally, which is not
 * the same as denying it — a `deny` is a standing answer and this is the
 * absence of one. Use `grantWorkflowPermission` with mode "deny" to refuse
 * something outright.
 */
export function revokeWorkflowPermission(db: Db, slug: string, capability: string, now: Date = new Date()): void {
  const workflow = require_(db, slug);
  const wanted = capability.trim();

  const [live] = db.select().from(s.workflowPermissions).where(livePermission(workflow.id, wanted)).limit(1).all();
  if (!live) throw new NoSuchWorkflowPermissionError(slug, wanted);

  db.update(s.workflowPermissions).set({ retiredAt: now }).where(eq(s.workflowPermissions.id, live.id)).run();
}

/** The one un-retired rule for a capability, if there is one. */
function livePermission(workflowId: string, capability: string) {
  return and(
    eq(s.workflowPermissions.workflowId, workflowId),
    eq(s.workflowPermissions.capability, capability),
    isNull(s.workflowPermissions.retiredAt),
  );
}

// ---------------------------------------------------------------------------
// A write that waited
// ---------------------------------------------------------------------------

/** What a deferred write needs recorded so a person can answer it later. */
export interface DeferredWrite {
  workflowId: string;
  runId: string;
  /** The tool the run wanted to call, and what it wanted to call it with. */
  tool: string;
  args: unknown;
  /** The capability whose rule said to ask — `okf.write`. Shown as a fact, so
   *  the answer to "why am I being asked this" is on the card. */
  capability: string;
  /** The tool's own first sentence: what the act is, in its own words. */
  why: string;
}

/**
 * Write down a change a run wanted to make and did not.
 *
 * The other half of `ask`. A run at three in the morning has nobody to put a
 * question to, so the question is written down instead and joins everything
 * else waiting on the person — `blocking: false`, because unlike a chat
 * approval no run is sitting stopped on this one. The run carried on without
 * the write and finished.
 *
 * The affirm action carries `effectKind: "tool_call"` and the call itself, so
 * the record says exactly what would happen rather than "approve this", and
 * `answerDeferredWrite` is what actually runs it when you say yes.
 *
 * ## The feed entry is not decoration
 *
 * A `decisions` row on its own is INVISIBLE in this product, and the first
 * version of this function wrote one and stopped. Three surfaces read a gate
 * and all three reach it through `activity_items`: the home feed selects from
 * that table, the rail counts it, and `openGates` in ../queries/workflows.ts
 * joins `decisions` to it to find the gate a run is sitting on — its own
 * comment says so ("a run does not own its decision; the feed entry about the
 * run does"). Writing the decision without the feed entry is writing a record
 * nothing reads, which is the failure this whole area was rebuilt to end.
 */
export function deferWorkflowWrite(
  db: Db,
  write: DeferredWrite,
  now: Date = new Date(),
): string {
  return db.transaction((t) => {
    const decisionId = ulid(now.getTime());
    t.insert(s.entities)
      .values({ id: decisionId, kind: "decision", createdAt: now, updatedAt: now })
      .run();
    t.insert(s.decisions)
      .values({
        id: decisionId,
        // The run is what it is about, so the decision hangs off it the way a
        // recommendation's hangs off the recommendation.
        subjectId: write.runId,
        title: `I wanted to run ${write.tool}, and stopped to ask.`,
        body: write.why,
        state: "open",
        // Nothing is held. The run did not wait and has already finished.
        blocking: false,
        openedAt: now,
      })
      .run();

    // The facts under the ask, in the slot every other gate in the product
    // uses for them. The capability first: it is the answer to "why is this
    // being put to me at all", and it names the rule you would edit.
    writePairs(t, decisionId, "effect", [
      ["Governed by", write.capability],
      ["Call", write.tool],
      ...argumentPairs(write.args),
    ]);

    // What is true while it waits, which for a deferred write is everything:
    // it did not happen, and the run it belonged to is over.
    narrate(
      t,
      decisionId,
      "restraint",
      "Nothing was written. The run finished without it.",
      now,
    );

    // The feed entry, without which none of the above is visible anywhere —
    // and it comes BEFORE the buttons, because the buttons hang off it.
    const activityId = ulid(now.getTime());
    t.insert(s.entities)
      .values({ id: activityId, kind: "activity_item", createdAt: now, updatedAt: now })
      .run();
    t.insert(s.activityItems)
      .values({
        id: activityId,
        occurredAt: now,
        // It wants you specifically, which is what the loud mark is for.
        state: "attention",
        title: `${write.tool} is waiting on you`,
        badge: write.capability,
        prominence: "prominent",
        framed: true,
        workflowId: write.workflowId,
        runId: write.runId,
        decisionId,
      })
      .run();

    // `subjectId` is the FEED ROW, not the decision — ../queries/home.ts reads
    // buttons by the id of the item they are drawn under, and the seed writes
    // them the same way. The decision is carried separately, in `decisionId`,
    // which is what says pressing one settles a question. Hanging these off the
    // decision instead put them in the database and on no screen.
    const button = (
      ordinal: number,
      label: string,
      stance: (typeof s.ACTION_STANCE)[number],
      effectKind: (typeof s.ACTION_EFFECT_KIND)[number],
      effect: Record<string, unknown>,
    ) =>
      t.insert(s.actions)
        .values({
          id: ulid(now.getTime()),
          subjectId: activityId,
          decisionId,
          ordinal,
          label,
          stance,
          effectKind,
          effect,
          destructive: false,
          createdAt: now,
        })
        .run();

    button(0, "Write it", "affirm", "tool_call", { tool: write.tool, args: write.args });
    button(1, "Leave it", "quiet", "resolve", {});

    return decisionId;
  });
}

/**
 * Do the thing a deferred write was asking about, or let it go.
 *
 * The other end of `deferWorkflowWrite`, and the reason its affirm action
 * carries a real `{ tool, args }` rather than a flag. `run` is handed in rather
 * than imported: this module writes rows and does not execute tools, and the
 * caller (../../http/routes/workflows.ts) is what knows how to rebuild one.
 *
 * The write order is the one that survives a crash between two statements: the
 * call happens first and its outcome is recorded second, so the worst case is a
 * decision that stays open over a write that happened — which a person re-reads
 * and can act on — rather than a decision marked done over a write that never
 * did.
 */
export function settleDeferredWrite(
  db: Db,
  settlement: {
    decisionId: string;
    actionId: string;
    /** True when the call was made. False when they left it. */
    ran: boolean;
    /** What happened, in one sentence. Null when they simply declined. */
    outcome: string | null;
    failed?: boolean;
  },
  now: Date = new Date(),
): void {
  db.transaction((t) => {
    const [open] = t
      .select({ id: s.decisions.id })
      .from(s.decisions)
      .where(and(eq(s.decisions.id, settlement.decisionId), eq(s.decisions.state, "open")))
      .limit(1)
      .all();
    if (!open) throw new NoSuchWorkflowDecisionError(settlement.decisionId);

    t.update(s.decisions)
      .set({
        // A decline is an answer and resolves. Only the clock leaves one
        // unanswered, and nothing here is on a clock.
        state: "resolved",
        resolvedAt: now,
        resolvedBy: "user",
        chosenActionId: settlement.actionId,
      })
      .where(eq(s.decisions.id, settlement.decisionId))
      .run();

    t.update(s.actions)
      .set({
        invokedAt: now,
        invokedBy: "user",
        invokeState: settlement.failed ? "failed" : "ok",
      })
      .where(eq(s.actions.id, settlement.actionId))
      .run();

    if (settlement.outcome) {
      clearSlot(t, settlement.decisionId, "outcome");
      narrate(t, settlement.decisionId, "outcome", settlement.outcome, now);
    }

    // The feed entry stops asking. It stays in the feed rather than being
    // dismissed, because what the agent wanted and what you said about it is
    // the record, and a feed that deletes its own history answers nothing.
    t.update(s.activityItems)
      .set({
        state: settlement.failed ? "failed" : settlement.ran ? "done" : "idle",
        title: settlement.outcome ?? "You left it.",
        prominence: "quiet",
        framed: false,
      })
      .where(eq(s.activityItems.decisionId, settlement.decisionId))
      .run();

    touch(t, settlement.decisionId, now);
  });
}

/** Thrown when an action names no open deferred write — HTTP 404 or 409. */
export class NoSuchWorkflowDecisionError extends Error {
  constructor(id: string) {
    super(`No open decision with id ${id}. It may already have been answered.`);
    this.name = "NoSuchWorkflowDecisionError";
  }
}

/** What one of a deferred write's two buttons means, and whether it still can. */
export interface DeferredWriteButton {
  decisionId: string;
  runId: string;
  tool: string;
  args: unknown;
  /** True for "Write it", false for "Leave it". */
  approves: boolean;
  /** False once the question has been answered. The call MUST NOT be made
   *  again on a false: `settleDeferredWrite` would refuse the second settle,
   *  but only after the write had already happened twice. */
  open: boolean;
}

/**
 * The affirm button's payload, the decision it belongs to, and whether that
 * decision is still open.
 *
 * `open` is not a nicety. The route runs the call BEFORE recording the outcome
 * — deliberately, so a crash between the two leaves a question open over a
 * write that happened rather than a record claiming a write that did not. That
 * ordering makes a replayed `actionId` a second real write: the tool runs
 * again, and only then does `settleDeferredWrite` notice the decision is closed
 * and throw. So the state is read here, with the call, and checked before it.
 */
export function readDeferredWrite(
  db: Db,
  actionId: string,
): DeferredWriteButton | undefined {
  const [row] = db
    .select({
      decisionId: s.actions.decisionId,
      effectKind: s.actions.effectKind,
      effect: s.actions.effect,
      runId: s.activityItems.runId,
      state: s.decisions.state,
    })
    .from(s.actions)
    .innerJoin(s.activityItems, eq(s.activityItems.decisionId, s.actions.decisionId))
    .innerJoin(s.decisions, eq(s.decisions.id, s.actions.decisionId))
    .where(eq(s.actions.id, actionId))
    .limit(1)
    .all();
  if (!row?.decisionId || !row.runId) return undefined;
  const open = row.state === "open";

  // "Leave it" is a `resolve`, which has no call in it. Both buttons come
  // through here so the route has one shape to handle.
  if (row.effectKind !== "tool_call") {
    return { decisionId: row.decisionId, runId: row.runId, tool: "", args: undefined, approves: false, open };
  }
  const effect = row.effect as { tool?: unknown; args?: unknown };
  if (typeof effect.tool !== "string") return undefined;
  return { decisionId: row.decisionId, runId: row.runId, tool: effect.tool, args: effect.args, approves: true, open };
}

/** The arguments as `[label, value]` lines, capped the way an approval's are —
 *  a person checks an id against one they know, they do not read a payload. */
function argumentPairs(args: unknown): Pair[] {
  if (!args || typeof args !== "object") return [];
  const pairs: Pair[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") continue;
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    pairs.push([key, rendered.length > 120 ? `${rendered.slice(0, 119)}…` : rendered]);
    if (pairs.length >= 6) break;
  }
  return pairs;
}
