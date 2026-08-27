// What an agent turn adds to a message.
//
// A chat with the agent is a conversation like any other — the design renders a
// text from Fenwick Heating and a turn from the agent with the same stamp, the
// same body, the same order — so it stays in `messages` rather than growing a
// third stack. Three things a turn from the agent carries have no counterpart
// in a text message, and they are sparse: most turns are prose and nothing else.
//
// A separate file rather than four nullable columns on `messages`, because two
// of the three point at rows that already point back — `workflow_runs` names the
// conversation that transcribes it — and a module that imports both is cleaner
// than two modules importing each other.
import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { decisions } from "./decisions";
import { messages } from "./conversations";
import { workflowRuns } from "./workflows";

/**
 * 1:1 extension of `messages`. Only turns the agent authored have a row, and
 * only when the turn does more than speak.
 */
export const agentTurns = sqliteTable("agent_turns", {
  messageId: text().primaryKey().references(() => messages.id, { onDelete: "cascade" }),
  /**
   * The turn where the agent put something to you and stopped. The bubble's
   * ask, its machine facts, its two buttons and what followed all hang off the
   * decision — this column is only what fixes it at a point in the transcript,
   * which `decisions` alone cannot say. An approval read out of `openedAt`
   * would drift out of order the moment two land in the same second.
   *
   * Nulls rather than cascades. If the reminder the agent asked about is
   * deleted its decision goes with it, but the turn where it asked is a record
   * of something that was said, and the transcript does not get to lose it. The
   * ask itself is in `messages.body`, so the turn still reads.
   */
  decisionId: text().references(() => decisions.id, { onDelete: "set null" }),
  /**
   * The run behind the turn. The inline tool calls are its `run_steps` where
   * isTool = 1 and the meter is its stepIndex/stepTotal, so "six of eleven"
   * moves when the run does instead of freezing at whatever it said when the
   * message was written.
   */
  runId: text().references(() => workflowRuns.id, { onDelete: "set null" }),
  /**
   * "4 tool calls · docs.read, web.form_walk, calendar.check". Derivable from
   * run_steps, but the agent phrases it — note the ×2 collapse in "archive.read
   * ×2". Same column, same reason, as activity_items.toolSummary.
   */
  toolSummary: text(),
  /** The mono line under the prose: "written to okf:policy/ferris-hold · rev 1". */
  note: text(),
}, (t) => [
  // One approval bubble per decision. A decision re-asked is a new decision,
  // which is what `supersededById` is for.
  uniqueIndex("agent_turns_decision").on(t.decisionId).where(sql`${t.decisionId} is not null`),
  index("agent_turns_run").on(t.runId),
]);
