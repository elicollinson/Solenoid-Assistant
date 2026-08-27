// Standing suggestions the agent has formed from watching the work.
//
// Waiting on you / Standing / Set aside is DERIVED from status.
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { check } from "drizzle-orm/sqlite-core";
import { AUTHOR, inList, ts, tsReq } from "./_shared";
import { entityId } from "./entities";
import { decisions } from "./decisions";
import { workflowInstructions, workflowPermissions, workflows } from "./workflows";

export const RECOMMENDATION_STATUS = ["proposed", "adopted", "declined", "withdrawn", "superseded"] as const;
export const CONFIDENCE = ["strong", "worth_a_look", "weak"] as const;

export const recommendations = sqliteTable("recommendations", {
  id: entityId(),
  title: text().notNull(),
  status: text({ enum: RECOMMENDATION_STATUS }).notNull().default("proposed"),
  confidence: text({ enum: CONFIDENCE }).notNull().default("worth_a_look"),
  formedAt: tsReq(),
  decidedAt: ts(),
  decidedBy: text({ enum: AUTHOR }),
  /** "14 approvals · 0 rejections" */
  basisLabel: text(),
  basisCount: integer(),
  basisRunCount: integer(),
  scopeLabel: text(),
  scopeOkfUri: text(),
  scopeWorkflowId: text().references(() => workflows.id, { onDelete: "set null" }),
  decisionId: text().references(() => decisions.id, { onDelete: "set null" }),
  /** "I won't raise this again unless the finance source starts failing weekly." */
  reRaiseCondition: text(),
  reRaiseAfter: ts(),
  /** Once adopted, the rule it actually became. This is what lets the agent
   *  later say "six runs have used it". */
  appliedPermissionId: text().references(() => workflowPermissions.id, { onDelete: "set null" }),
  appliedInstructionId: text().references(() => workflowInstructions.id, { onDelete: "set null" }),
}, (t) => [
  check("recommendations_status_check", inList(t.status, RECOMMENDATION_STATUS)),
  check("recommendations_confidence_check", inList(t.confidence, CONFIDENCE)),
  index("recommendations_status").on(t.status, t.formedAt),
]);
