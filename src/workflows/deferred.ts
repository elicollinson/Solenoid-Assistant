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
// Two sources, because there are two kinds of tool in this service.
//
//   * Ours. Every one lives in a group in ../tools/groups.ts, and a group is a
//     factory over `{ db, okf }` — which is exactly why they are factories. So
//     the catalog is rebuilt here against the same handles and the tool is
//     found by name. Nothing about it is stale: it was never anything but a
//     closure over a database handle.
//
//   * A remote server's. `notion-create-pages` belongs to an MCP client, and
//     the one this app keeps alive at startup (../mcp/notionCache.ts) is the
//     same connection the run used. A server that is not connected means the
//     call cannot be made, which is said out loud rather than guessed at.
//
// ## What is checked before it runs
//
// The rule, again. A permission can have been narrowed to `deny` between the
// run asking and you answering, and the answer to "may this happen" is the rule
// NOW, not the rule when the question was written. Anything else would make a
// stale bubble a way around a standing refusal.
import type { Db } from "../db";
import * as s from "../db/schema";
import { eq } from "drizzle-orm";
import type { AgentTool } from "../core/tools";
import { TOOL_GROUP_CATALOG, type ToolGroupContext } from "../tools/groups";
import { getNotionMcpClient } from "../mcp/notionCache";
import { loadMcpTools } from "../mcp/adapter";
import { capabilityFor, resolvePermission } from "./permissions";

/** Why a deferred call could not be made. Each is a different sentence to a
 *  person, which is why they are not one boolean. */
export type RefusalReason = "denied" | "unknown_tool" | "disconnected";

export type DeferredOutcome =
  | { ran: true; summary: string }
  | { ran: false; reason: RefusalReason; summary: string };

/**
 * Find the tool a deferred call names.
 *
 * Async only because of the MCP branch. Ours are synchronous — a group factory
 * is a closure over handles the caller already has.
 */
export async function resolveDeferredTool(
  context: ToolGroupContext,
  name: string,
): Promise<AgentTool | undefined> {
  for (const factory of Object.values(TOOL_GROUP_CATALOG)) {
    const found = factory(context).tools.find((tool) => tool.definition.function.name === name);
    if (found) return found;
  }

  // Not ours. The only other tools this service ever holds come from an MCP
  // server, and the only one it keeps connected is Notion.
  const client = getNotionMcpClient();
  if (!client) return undefined;
  const remote = await loadMcpTools(client);
  return remote.find((tool) => tool.definition.function.name === name);
}

/**
 * Make the call, or say why not.
 *
 * Never throws for an ordinary refusal: "the rule now says deny" and "that
 * server is not connected" are answers a person needs to read, not exceptions.
 * A tool that throws while running is caught and reported as a failure, exactly
 * as ../core/rawAgent.ts does for a live one — the record has to say the write
 * was attempted and did not land.
 */
export async function runDeferredWrite(
  db: Db,
  call: { runId: string; tool: string; args: unknown },
  context: ToolGroupContext,
  /** Where a tool comes back from. The catalog plus the MCP cache, everywhere
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
    const remote = call.tool.includes("-") && !getNotionMcpClient();
    return remote
      ? {
        ran: false,
        reason: "disconnected",
        summary: `Not done: ${call.tool} belongs to a server this app is not connected to right now.`,
      }
      : {
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
    const result = await tool.execute(args);
    const rendered = typeof result === "string" ? result : JSON.stringify(result);
    return {
      ran: true,
      summary: `${call.tool} ran and finished: ${cap(rendered, 200)}`,
    };
  } catch (error) {
    return {
      ran: false,
      reason: "unknown_tool",
      summary: `${call.tool} was allowed and failed: ${
        cap(error instanceof Error ? error.message : String(error), 200)
      }`,
    };
  }
}

const cap = (text: string, at: number) => (text.length > at ? `${text.slice(0, at - 1)}…` : text);
