// Workflows, their config, and every run.
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { APP_TZ, ACTOR, AUTHOR, LOG_LEVEL, RUN_STATE, STEP_STATE, inList, json, ts, tsReq } from "./_shared";
import { entityId, entityRefNull } from "./entities";
import { conversations } from "./conversations";

export const TRIGGER_KIND = ["schedule", "on_demand", "event"] as const;

export const workflows = sqliteTable("workflows", {
  id: entityId(),
  slug: text().notNull(),
  name: text().notNull(),
  triggerKind: text({ enum: TRIGGER_KIND }).notNull(),
  enabled: integer({ mode: "boolean" }).notNull().default(true),
  pausedAt: ts(),
  pausedBy: text({ enum: ACTOR }),
  pauseReason: text(),
  currentVersionId: text(),
  lastRunId: text(),
  createdAt: tsReq(),
}, (t) => [
  check("workflows_trigger_check", inList(t.triggerKind, TRIGGER_KIND)),
  uniqueIndex("workflows_slug").on(t.slug),
]);

/**
 * Config is JSON on purpose: the workflow *editor* is the one screen the design
 * explicitly has not drawn ("absent rather than invented"). Everything the UI
 * reads today is normalised around this column, so when the editor exists the
 * step shape lifts out of the JSON without touching another table.
 */
export const workflowVersions = sqliteTable("workflow_versions", {
  id: text().primaryKey(),
  workflowId: text().notNull().references(() => workflows.id, { onDelete: "cascade" }),
  version: integer().notNull(),
  config: json<Record<string, unknown>>().notNull().default(sql`'{}'`),
  stepTotal: integer(),
  note: text(),
  createdAt: tsReq(),
  createdBy: text({ enum: ACTOR }).notNull().default("user"),
}, (t) => [uniqueIndex("workflow_versions_number").on(t.workflowId, t.version)]);

/** RRULE, not a prose cadence. "Weekdays, 06:00" is rendered from this. */
export const workflowSchedules = sqliteTable("workflow_schedules", {
  id: text().primaryKey(),
  workflowId: text().notNull().references(() => workflows.id, { onDelete: "cascade" }),
  rrule: text().notNull(),
  tz: text().notNull().default(APP_TZ),
  enabled: integer({ mode: "boolean" }).notNull().default(true),
  jitterSecs: integer().notNull().default(0),
  /**
   * What to run it WITH.
   *
   * The column whose absence made a config file necessary. A schedule is
   * "this work, with these arguments, at this time", and without the middle
   * third the only place the arguments could live was outside the database —
   * which is how this service ended up with two schedulers, one of them
   * invisible to the screen that draws schedules.
   *
   * Validated against the workflow's own schema when the run starts, not here:
   * a schedule whose arguments have stopped matching the code should fail
   * loudly at its next firing rather than be silently unschedulable.
   */
  args: json<Record<string, unknown>>().notNull().default(sql`'{}'`),
  nextRunAt: ts(),
  lastRunAt: ts(),
  label: text(),
}, (t) => [
  index("workflow_schedules_due").on(t.nextRunAt).where(sql`${t.enabled} = 1`),
]);

/**
 * Standing instructions, versioned rather than edited in place. "I hold it in
 * your words" is only true if the words survive: the quarter-boundary rule
 * changed once, $25 to $50, and the design shows both the current rule and the
 * correction that produced it.
 */
export const workflowInstructions = sqliteTable("workflow_instructions", {
  id: text().primaryKey(),
  workflowId: text().references(() => workflows.id, { onDelete: "cascade" }),
  text: text().notNull(),
  /** When the rule lives in memory instead of here. */
  okfUri: text(),
  sourceMessageId: text(),
  authoredBy: text({ enum: AUTHOR }).notNull().default("user"),
  version: integer().notNull().default(1),
  effectiveFrom: tsReq(),
  retiredAt: ts(),
  supersedesId: text().references((): AnySQLiteColumn => workflowInstructions.id, { onDelete: "set null" }),
}, (t) => [
  index("workflow_instructions_active").on(t.workflowId).where(sql`${t.retiredAt} is null`),
]);

export const PERMISSION_MODE = ["allow", "ask", "deny"] as const;

/** "Anything that commits money waits for me" — the machine-readable half. */
export const workflowPermissions = sqliteTable("workflow_permissions", {
  id: text().primaryKey(),
  /** Null means global rather than per-workflow. */
  workflowId: text().references(() => workflows.id, { onDelete: "cascade" }),
  capability: text().notNull(),
  mode: text({ enum: PERMISSION_MODE }).notNull(),
  /** USD cents. There is no currency column; the app is USD-only. */
  limitAmountCents: integer(),
  limitJson: json<Record<string, unknown>>().notNull().default(sql`'{}'`),
  okfPolicyUri: text(),
  createdAt: tsReq(),
  createdBy: text({ enum: AUTHOR }).notNull().default("user"),
  retiredAt: ts(),
}, (t) => [
  check("workflow_permissions_mode_check", inList(t.mode, PERMISSION_MODE)),
  // NULLs are distinct in SQLite, so a plain UNIQUE(..., retired_at) would let
  // two live rows for one capability through. Partial index instead.
  uniqueIndex("workflow_permissions_active")
    .on(t.workflowId, t.capability).where(sql`${t.retiredAt} is null`),
]);

export const RUN_TRIGGER = ["schedule", "manual", "event", "retry"] as const;

export const workflowRuns = sqliteTable("workflow_runs", {
  id: entityId(),
  workflowId: text().notNull().references(() => workflows.id, { onDelete: "cascade" }),
  versionId: text().references(() => workflowVersions.id, { onDelete: "set null" }),
  /** "Run 14" */
  ordinal: integer().notNull(),
  trigger: text({ enum: RUN_TRIGGER }).notNull(),
  triggeredBy: text({ enum: ACTOR }),
  parentRunId: text().references((): AnySQLiteColumn => workflowRuns.id, { onDelete: "set null" }),
  state: text({ enum: RUN_STATE }).notNull(),
  stepIndex: integer(),
  stepTotal: integer(),
  startedAt: ts(),
  endedAt: ts(),
  durationMs: integer(),
  error: text(),
  haltedStepId: text(),
  /** Phoenix / OTEL correlation — what makes the Trace tab and the Phoenix
   *  span demonstrably the same run rather than two stories about it. */
  traceId: text(),
  spanId: text(),
  /** The Executions tab's Transcript toggle reads this. */
  transcriptConversationId: text().references(() => conversations.id, { onDelete: "set null" }),
  tokensIn: integer(),
  tokensOut: integer(),
  modelRoute: text(),
}, (t) => [
  check("workflow_runs_state_check", inList(t.state, RUN_STATE)),
  check("workflow_runs_trigger_check", inList(t.trigger, RUN_TRIGGER)),
  uniqueIndex("workflow_runs_ordinal").on(t.workflowId, t.ordinal),
  index("runs_by_workflow").on(t.workflowId, t.startedAt),
  index("runs_active").on(t.startedAt).where(sql`${t.state} in ('queued','running','attention')`),
  index("runs_trace").on(t.traceId).where(sql`${t.traceId} is not null`),
]);

/**
 * The trace tree and the inline tool-call list are the same rows at different
 * depths: TraceTree renders the tree, ToolCalls renders the leaves where
 * isTool = 1. Two tables would mean writing every gmail.draft twice.
 */
export const runSteps = sqliteTable("run_steps", {
  id: entityId(),
  runId: text().notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
  parentId: text().references((): AnySQLiteColumn => runSteps.id, { onDelete: "cascade" }),
  ordinal: integer().notNull(),
  depth: integer().notNull().default(0),
  /** Literal, machine-side: "reconcile.match_invoices". */
  name: text().notNull(),
  detail: text(),
  /** Short amber aside: "Ferris — held per instruction". */
  note: text(),
  state: text({ enum: STEP_STATE }).notNull().default("ok"),
  isTool: integer({ mode: "boolean" }).notNull().default(false),
  toolName: text(),
  toolArgs: json<Record<string, unknown>>(),
  /** Entity id, when the result is a row rather than a blob. */
  toolResultRef: text(),
  toolResult: json<unknown>(),
  startedAt: ts(),
  endedAt: ts(),
  durationMs: integer(),
  spanId: text(),
  retryOfId: text().references((): AnySQLiteColumn => runSteps.id, { onDelete: "set null" }),
}, (t) => [
  check("run_steps_state_check", inList(t.state, STEP_STATE)),
  uniqueIndex("run_steps_ordinal").on(t.runId, t.parentId, t.ordinal),
  index("run_steps_tree").on(t.runId, t.parentId, t.ordinal),
  index("run_steps_tools").on(t.runId).where(sql`${t.isTool} = 1`),
]);

export const runLogs = sqliteTable("run_logs", {
  id: integer().primaryKey({ autoIncrement: true }),
  runId: text().notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
  at: tsReq(),
  /** The design prints 06:12:04.221 — sub-millisecond lives here. */
  fracUs: integer().notNull().default(0),
  seq: integer().notNull(),
  level: text({ enum: LOG_LEVEL }).notNull(),
  text: text().notNull(),
  data: json<Record<string, unknown>>(),
  stepId: text().references(() => runSteps.id, { onDelete: "set null" }),
}, (t) => [
  check("run_logs_level_check", inList(t.level, LOG_LEVEL)),
  index("run_logs_run").on(t.runId, t.seq),
  index("run_logs_level").on(t.runId, t.level),
]);

export const EFFECT_KIND = ["created", "updated", "sent", "filed", "held", "moved", "skipped", "note"] as const;

/**
 * The `changed: [...]` list. A table rather than a text array so "2 events
 * moved" points at the actual calendar items, and so an effect can be reverted.
 */
export const runEffects = sqliteTable("run_effects", {
  id: text().primaryKey(),
  runId: text().notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
  ordinal: integer().notNull(),
  text: text().notNull(),
  effectKind: text({ enum: EFFECT_KIND }).notNull().default("note"),
  targetId: entityRefNull(),
  reversible: integer({ mode: "boolean" }).notNull().default(false),
  revertedAt: ts(),
}, (t) => [
  check("run_effects_kind_check", inList(t.effectKind, EFFECT_KIND)),
  uniqueIndex("run_effects_ordinal").on(t.runId, t.ordinal),
]);
