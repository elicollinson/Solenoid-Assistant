// The activity feed — a real table, not a union view over runs and decisions.
//
// The design's four feed items come from four different sources, and each
// one's narration is bespoke: the feed says "I drafted a reply agreeing to the
// March 1 start but pushing back on the handling fee, since you did that
// yourself last year", where the workflow's own summary says something else
// about the same event. That is authored text, so it is stored.
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { STATE, inList, ts, tsReq } from "./_shared";
import { entityId, entityRefNull } from "./entities";
import { decisions } from "./decisions";
import { workflowRuns, workflows } from "./workflows";

export const PROMINENCE = ["prominent", "quiet"] as const;

export const activityItems = sqliteTable("activity_items", {
  id: entityId(),
  occurredAt: tsReq(),
  state: text({ enum: STATE }).notNull(),
  title: text().notNull(),
  /** "running · step 6/11" */
  badge: text(),
  /** The phone shows at most two prominent entries; everything else collapses
   *  to a title and a mono time. An editorial call, not a derivable rank. */
  prominence: text({ enum: PROMINENCE }).notNull().default("quiet"),
  /** Desktop: tinted card vs bare row in the flow. */
  framed: integer({ mode: "boolean" }).notNull().default(false),
  sourceId: entityRefNull(),
  workflowId: text().references(() => workflows.id, { onDelete: "set null" }),
  runId: text().references(() => workflowRuns.id, { onDelete: "set null" }),
  decisionId: text().references(() => decisions.id, { onDelete: "set null" }),
  /** "4 tool calls · gmail.draft, memory.read ×2, calendar.check". Derivable
   *  from run_steps, but the agent phrases it — note the ×2 collapse. */
  toolSummary: text(),
  progressValue: integer(),
  progressTotal: integer(),
  readAt: ts(),
  dismissedAt: ts(),
}, (t) => [
  check("activity_items_state_check", inList(t.state, STATE)),
  check("activity_items_prominence_check", inList(t.prominence, PROMINENCE)),
  index("activity_feed").on(t.occurredAt).where(sql`${t.dismissedAt} is null`),
  index("activity_by_state").on(t.state, t.occurredAt),
]);
