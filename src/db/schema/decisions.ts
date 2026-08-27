// Everything waiting on you, and every button the model writes.
//
// The design shows this object six ways — a workflow gate, a reminder's
// affirm/quiet pair, adopt-or-decline on a recommendation, "take this one /
// take Friday instead" across two calendar holds, "Send it / Read the draft /
// Not this one" in the feed, and the two-billing-address conflict in memory.
// They are the same object, so they are one table.
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { ACTOR, inList, json, ts, tsReq } from "./_shared";
import { entityId, entityRef, entityRefOwned } from "./entities";

export const DECISION_STATE = ["open", "resolved", "dismissed", "expired", "superseded"] as const;
export const RESOLVED_BY = ["user", "agent", "timeout", "system"] as const;

export const decisions = sqliteTable("decisions", {
  id: entityId(),
  /** What it is about: a run, a reminder, a recommendation, an OKF conflict. */
  subjectId: entityRefOwned(),
  title: text().notNull(),
  body: text(),
  state: text({ enum: DECISION_STATE }).notNull().default("open"),
  /** Does the run sit stopped on this, or is it merely waiting. */
  blocking: integer({ mode: "boolean" }).notNull().default(false),
  openedAt: tsReq(),
  dueAt: ts(),
  resolvedAt: ts(),
  resolvedBy: text({ enum: RESOLVED_BY }),
  /** Set by UPDATE after the options exist. See the write-order note below. */
  chosenActionId: text(),
  supersededById: text().references((): AnySQLiteColumn => decisions.id, { onDelete: "set null" }),
}, (t) => [
  check("decisions_state_check", inList(t.state, DECISION_STATE)),
  // The hot path for every "needs you" count in the product.
  index("decisions_open").on(t.blocking, t.openedAt).where(sql`${t.state} = 'open'`),
  index("decisions_subject").on(t.subjectId),
  index("decisions_chosen").on(t.chosenActionId),
]);

export const ACTION_STANCE = ["affirm", "neutral", "quiet", "danger", "bare"] as const;
export const ACTION_EFFECT_KIND = [
  "tool_call",    // effect = { tool, args }
  "navigate",     // effect = { view, id, tab }
  "resolve",      // close the decision, no side effect
  "set_policy",   // write a workflow_permission or instruction
  "run_workflow",
  "snooze",
  "custom",
] as const;

export type ActionEffect =
  | { tool: string; args?: Record<string, unknown> }
  | { view: string; id?: string; tab?: string }
  | Record<string, unknown>;

/**
 * Buttons. An action with a `decisionId` resolves that decision — "Settle it
 * now", "Keep holding". An action without one is a plain affordance — "Open
 * workflow", "Trace", "Retry that step". Same table, so the feed renders one
 * row type and the model authors both the same way.
 */
export const actions = sqliteTable("actions", {
  id: text().primaryKey(),
  subjectId: entityRef(),
  decisionId: text().references(() => decisions.id, { onDelete: "cascade" }),
  ordinal: integer().notNull(),
  /** The agent's own words. Never "Submit", "Confirm", "OK". */
  label: text().notNull(),
  stance: text({ enum: ACTION_STANCE }).notNull().default("neutral"),
  effectKind: text({ enum: ACTION_EFFECT_KIND }).notNull(),
  effect: json<ActionEffect>().notNull().default(sql`'{}'`),
  enabled: integer({ mode: "boolean" }).notNull().default(true),
  destructive: integer({ mode: "boolean" }).notNull().default(false),
  requiresConfirmation: integer({ mode: "boolean" }).notNull().default(false),
  /**
   * A model-authored action whose effect is gmail.send must not fire twice
   * because a row re-rendered or a tap double-fired. The unique index below is
   * the only layer that reliably sees both attempts.
   */
  idempotencyKey: text(),
  authoredBy: text({ enum: ACTOR }).notNull().default("agent"),
  createdAt: tsReq(),
  invokedAt: ts(),
  invokedBy: text({ enum: ["user", "agent", "system"] as const }),
  invokeState: text({ enum: ["pending", "ok", "failed"] as const }),
  invokeResult: json<Record<string, unknown>>(),
  invokeError: text(),
}, (t) => [
  check("actions_stance_check", inList(t.stance, ACTION_STANCE)),
  check("actions_effect_kind_check", inList(t.effectKind, ACTION_EFFECT_KIND)),
  uniqueIndex("actions_subject_ordinal").on(t.subjectId, t.ordinal),
  uniqueIndex("actions_idempotency").on(t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
  index("actions_decision").on(t.decisionId, t.ordinal),
]);
