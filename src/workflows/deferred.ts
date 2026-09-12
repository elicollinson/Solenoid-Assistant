import { withConsent } from "../core/consent";
import { newWriteCall, withWriteCall } from "../core/writeExecution";
// Doing, hours later, the thing a run stopped to ask about.
//
// `ask` defers rather than blocks — see ./permissions.ts for why a 3am run has
// nobody to hold for. That leaves a real question: the run is over, its agent
// is gone, and the call it wanted to make is a `{ tool, args }` pair in an
// `actions` row. Something has to be able to make that call.
//
// This is that something, and the whole of its difficulty is the first half:
// turning a tool NAME back into a callable tool, with its bindings, outside the
// run that built it.
//
// ## Where a tool comes back from
//
// Local tools live in ../tools/groups.ts. Rebuild the group against the current
// handles and find the tool by name. A tool no longer in this build cannot run;
// a historical deferred action must never reconnect a retired integration.
//
// ## What is checked before it runs
//
// The rule, again. A permission can have been narrowed to `deny` between the
// run asking and you answering, and the answer to "may this happen" is the rule
// NOW, not the rule when the question was written. Anything else would make a
// stale bubble a way around a standing refusal.
import type { Db } from "../db";
import * as s from "../db/schema";
import { and, eq } from "drizzle-orm";
import type { AgentTool } from "../core/tools";
import { readDeferredWrite, settleDeferredWrite } from "../db/mutations/workflows";
import { TOOL_GROUP_CATALOG, type ToolGroupContext } from "../tools/groups";
import { capabilityFor, resolvePermission } from "./permissions";

/** Why a deferred call could not be made. Each is a different sentence to a
 *  person, which is why they are not one boolean. */
export type RefusalReason = "denied" | "unknown_tool";

/** `summary` is the feed entry's TITLE, so it is one short sentence and never
 *  the payload: the title is Space Grotesk prose in a single row beside a badge
 *  and a time, and a 200-character blob of JSON in it does not merely look
 *  wrong — it has no space to break on, so it sets the feed's min-content width
 *  and pushes the aside and the filter chips out of the frame. What the call
 *  actually returned goes in `detail`, which is drawn as the entry's body. */
export type DeferredOutcome =
  | { ran: true; summary: string; detail?: string | null; durationMs?: number }
  | { ran: false; reason: RefusalReason; summary: string; detail?: string | null; durationMs?: number };

/**
 * Find the tool a deferred call names.
 *
 * A group factory is a closure over handles the caller already has.
 */
export async function resolveDeferredTool(
  context: ToolGroupContext,
  name: string,
): Promise<AgentTool | undefined> {
  for (const factory of Object.values(TOOL_GROUP_CATALOG)) {
    const found = factory(context).tools.find((tool) => tool.definition.function.name === name);
    if (found) return found;
  }

  return undefined;
}

/**
 * Make the call, or say why not.
 *
 * Never throws for an ordinary refusal: "the rule now says deny" and "that
 * tool is no longer available" are answers a person needs to read, not exceptions.
 * A tool that throws while running is caught and reported as a failure, exactly
 * as ../core/rawAgent.ts does for a live one — the record has to say the write
 * was attempted and did not land.
 */
export async function runDeferredWrite(
  db: Db,
  call: { runId: string; tool: string; args: unknown; requestId?: string },
  context: ToolGroupContext,
  /** Where a tool comes back from. The current tool catalog, everywhere
   *  but a test — what is worth checking here is the bookkeeping around a call,
   *  not the ten factories that build one. Same bargain as `lookup` in
   *  ./runner.ts. */
  resolve: (name: string) => Promise<AgentTool | undefined> =
    (name) => resolveDeferredTool(context, name),
): Promise<DeferredOutcome> {
  const [run] = db
    .select({ workflowId: s.workflowRuns.workflowId })
    .from(s.workflowRuns)
    .where(eq(s.workflowRuns.id, call.runId))
    .limit(1)
    .all();
  if (!run) {
    return { ran: false, reason: "unknown_tool", summary: "The run this belonged to is gone." };
  }

  // The rule NOW. A question written at 3am does not carry an authorisation
  // through a narrowing made at 9.
  const capability = capabilityFor(call.tool);
  const { mode } = resolvePermission(db, run.workflowId, capability);
  if (mode === "deny") {
    return {
      ran: false,
      reason: "denied",
      summary: `Not done: "${capability}" has since been set to deny.`,
    };
  }

  const tool = await resolve(call.tool);
  if (!tool) {
    return {
      ran: false,
      reason: "unknown_tool",
      summary: `Not done: this build has no tool called ${call.tool}.`,
    };
  }

  try {
    // Validated again rather than trusted. The arguments have been sitting in a
    // row since the run, and the tool's schema is the only thing that says they
    // are still a legal call.
    const args = tool.schema.parse(call.args);
    // Timed, because the step this becomes claims a duration and "0ms" is a
    // claim about the call rather than an absence of one.
    const startedAt = Date.now();
    const audit = newWriteCall({ origin: "deferred-review", actor: "user", runId: call.runId, workflowId: run.workflowId, ...(call.requestId ? { idempotencyKey: `deferred:${call.requestId}` } : {}) });
    const result = await withConsent(() => ({ allow: true }), async () => withWriteCall(audit, () => tool.execute(args)));
    const rendered = typeof result === "string" ? result : JSON.stringify(result);
    return {
      ran: true,
      summary: `${call.tool} ran and finished.`,
      detail: cap(rendered, 400),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ran: false,
      reason: "unknown_tool",
      summary: `${call.tool} was allowed and failed.`,
      detail: cap(error instanceof Error ? error.message : String(error), 400),
    };
  }
}

const cap = (text: string, at: number) => (text.length > at ? `${text.slice(0, at - 1)}…` : text);

/**
 * Auto-settle any open deferred writes for a workflow that match a newly pre-approved capability.
 */
export async function autoSettleWorkflowWrites(
  db: Db,
  slug: string,
  capability: string,
  context: ToolGroupContext = { db },
): Promise<number> {
  const [wf] = db.select().from(s.workflows).where(eq(s.workflows.slug, slug)).limit(1).all();
  if (!wf) return 0;

  const openDecisions = db
    .select({ decisionId: s.decisions.id })
    .from(s.decisions)
    .innerJoin(s.activityItems, eq(s.activityItems.decisionId, s.decisions.id))
    .where(and(eq(s.decisions.state, "open"), eq(s.activityItems.workflowId, wf.id)))
    .all();

  let settledCount = 0;
  for (const item of openDecisions) {
    const [action] = db
      .select()
      .from(s.actions)
      .where(and(eq(s.actions.decisionId, item.decisionId), eq(s.actions.effectKind, "tool_call")))
      .all();
    if (!action) continue;

    const call = readDeferredWrite(db, action.id);
    if (!call || !call.open || !call.approves) continue;

    const toolCap = capabilityFor(call.tool);
    if (toolCap !== capability) continue;

    const result = await runDeferredWrite(db, { runId: call.runId, tool: call.tool, args: call.args, requestId: action.id }, context);
    settleDeferredWrite(db, {
      decisionId: call.decisionId,
      actionId: action.id,
      ran: result.ran,
      outcome: result.summary,
      detail: result.detail ?? null,
      tool: call.tool,
      args: call.args,
      durationMs: result.durationMs,
      failed: !result.ran,
    });
    settledCount++;
  }

  return settledCount;
}
