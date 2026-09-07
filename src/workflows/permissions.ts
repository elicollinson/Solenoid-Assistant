// What a workflow may do with nobody watching.
//
// `workflow_permissions` has been in the schema since the beginning: one live
// rule per capability, `allow | ask | deny`, retired rather than overwritten so
// a run in June can still be read against June's rules. The agent could write
// them (`workflows_set_permissions`), the detail pane drew them, and NOTHING
// READ THEM. Every unattended write in this service went ahead because no code
// existed that could have refused one.
//
// That is the same failure `./schedule.ts` was written to end, one layer up: a
// record the screen draws and the agent edits, that nothing executes. The tool
// that writes these even warns "a rule under a name nothing checks governs
// nothing", which was true of every name.
//
// ## The three answers, and the one that is interesting
//
//   allow  the write happens.
//   deny   it does not, and the model is told so plainly.
//   ask    it does not happen NOW. The intent is written down as an open
//          decision and joins everything else waiting on the person.
//
// `ask` is where the design had to make a choice. In a chat it means stop and
// put a button in front of them, which ../agents/chat.ts already does, because
// the person is sitting there. At three in the morning there is nobody to stop
// for, and a run that blocks until a ten-minute timer expires has converted a
// question into a failed run and thrown the question away. So unattended `ask`
// DEFERS: nothing is written, the run carries on and finishes, and
// `deferWorkflowWrite` records what it wanted to do.
//
// Deferring is only worth anything if the question is both VISIBLE and
// ANSWERABLE, and the first version of this was neither. It wrote a `decisions`
// row and stopped, and no query in the product returns one of those on its own:
// the home feed, the rail count and the Workflows gate all reach a decision
// through `activity_items`. A row nothing reads is the exact failure this file
// was written to end, reproduced inside the fix for it.
//
// So `deferWorkflowWrite` writes the feed entry too, hangs the buttons off it
// the way ../db/queries/home.ts reads them, and ./deferred.ts makes the call
// when you press Write it — re-checking the rule first, because a capability
// narrowed between 3am and breakfast must not be reachable through a bubble
// written before the narrowing.
//
// ## The default is `ask`
//
// A capability with no rule on the workflow and no rule globally is asked
// about, not allowed — the same bargain ../tools/groups.ts strikes with trust:
// the safe answer is the one you get by forgetting. Today's unattended writes
// are therefore SEEDED, in ./catalog.ts, so that what this service already does
// on its own is written down and revocable rather than implicit.
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db";
import * as s from "../db/schema";
import { log as baseLog, type LogAttributes } from "../core/logger";
import { withConsent, type ConsentGate, type ConsentRequest, type ConsentVerdict } from "../core/consent";
import { deferWorkflowWrite } from "../db/mutations/workflows";

const log = baseLog.child("permissions");

export type PermissionMode = (typeof s.PERMISSION_MODE)[number];

/** What governs a capability nobody has written a rule for. */
export const DEFAULT_MODE: PermissionMode = "ask";

/**
 * `okf_create` → `okf.write`, `notion-create-pages` → `notion.write`.
 *
 * Derived rather than declared per tool, and the derivation is the family a
 * tool belongs to: everything up to the first separator. That is the vocabulary
 * `workflows_set_permissions` already tells the agent to use — its own examples
 * are 'spend', 'calendar.write', 'email.send' — so a rule written by the agent
 * and a rule checked here meet at the same string without anybody maintaining a
 * table between them.
 *
 * Both separators, because two naming conventions genuinely reach this: our own
 * tools are `group_verb` and MCP servers hand back `server-verb`
 * (`notion-create-pages`). A name with neither is its own family, which is the
 * right answer for a one-off.
 *
 * Only writes have capabilities. A read changes nothing a later read would see,
 * so there is nothing to authorise and no rule that could sensibly govern it.
 */
export function capabilityFor(tool: string): string {
  const cut = tool.search(/[_-]/);
  return `${cut > 0 ? tool.slice(0, cut) : tool}.write`;
}

/**
 * The live rule for a capability: this workflow's, else the global one, else
 * the default.
 *
 * Two lookups rather than one query with an OR, so that "this workflow says
 * nothing" and "nothing says anything" stay distinguishable — a per-workflow
 * `deny` must beat a global `allow`, and a per-workflow rule that was revoked
 * must fall through to the global one rather than to the default. The table's
 * null `workflowId` is what "governs everything at once" means.
 */
export function resolvePermission(
  db: Db,
  /** Undefined where the caller is not one of ours — a slug this database has
   *  never synced. There is nothing to hold a per-workflow rule, so the global
   *  one governs, and failing that the default does. */
  workflowId: string | undefined,
  capability: string,
): { mode: PermissionMode; scope: "workflow" | "global" | "default" } {
  const own = workflowId
    ? live(db, eq(s.workflowPermissions.workflowId, workflowId), capability)
    : undefined;
  if (own) return { mode: own, scope: "workflow" };

  const global = live(db, isNull(s.workflowPermissions.workflowId), capability);
  if (global) return { mode: global, scope: "global" };

  return { mode: DEFAULT_MODE, scope: "default" };
}

function live(
  db: Db,
  scope: ReturnType<typeof eq> | ReturnType<typeof isNull>,
  capability: string,
): PermissionMode | undefined {
  const [row] = db
    .select({ mode: s.workflowPermissions.mode })
    .from(s.workflowPermissions)
    .where(and(scope, eq(s.workflowPermissions.capability, capability), isNull(s.workflowPermissions.retiredAt)))
    .limit(1)
    .all();
  return row?.mode;
}

/** Which run is asking, and where its answer gets written. */
export interface RunContext {
  db: Db;
  workflowId: string;
  runId: string;
  slug: string;
}

/**
 * allow and deny, which read the same whoever is asking.
 *
 * `ask` is the only mode where it matters what the caller is, so it is the only
 * one this does not answer: a run defers the question, and a caller with no run
 * has nowhere to put one. Null means ask, and the gate above decides what
 * asking means for it.
 *
 * Every verdict is logged at the level its consequence deserves: an allow is
 * debug because it is the ordinary case, and a refusal is a warning, because a
 * workflow that quietly stopped doing half its job is precisely the thing this
 * file exists to make visible.
 */
function shared(
  db: Db,
  scope: { workflowId?: string; slug: string; runId?: string },
  request: ConsentRequest,
): { capability: string; verdict: ConsentVerdict | null; fields: LogAttributes } {
  const capability = capabilityFor(request.tool);
  const resolved = resolvePermission(db, scope.workflowId, capability);
  const fields = {
    workflow: scope.slug,
    ...(scope.runId ? { run_id: scope.runId } : {}),
    capability,
    mode: resolved.mode,
    scope: resolved.scope,
  };

  if (resolved.mode === "allow") {
    log.debug(`${request.tool} allowed under ${capability}`, fields);
    return { capability, verdict: { allow: true }, fields };
  }

  if (resolved.mode === "deny") {
    log.warn(`${request.tool} refused: ${capability} is denied`, fields);
    return {
      capability,
      fields,
      verdict: {
        allow: false,
        tell:
          `Refused. This workflow is not allowed to ${capability.replace(".write", "")}: ` +
          `the standing rule for "${capability}" is deny. NOTHING WAS WRITTEN. Do not try ` +
          "another route to the same change — say in your result that you could not do it, " +
          "and why.",
      },
    };
  }

  return { capability, verdict: null, fields };
}

/** The gate a run is governed by. */
export function workflowConsent(context: RunContext): ConsentGate {
  return (request: ConsentRequest) => {
    const { capability, verdict, fields } = shared(context.db, context, request);
    if (verdict) return verdict;

    // ask, with nobody to ask. Write down what it wanted rather than throwing
    // the intent away, and let the run finish without the change.
    const decisionId = deferWorkflowWrite(context.db, {
      workflowId: context.workflowId,
      runId: context.runId,
      tool: request.tool,
      args: request.args,
      capability,
      why: request.description.split(/(?<=[.!?])\s/)[0]?.trim() ?? request.description,
    });
    log.warn(`${request.tool} deferred: ${capability} needs a person`, { ...fields, decision_id: decisionId });
    return {
      allow: false,
      tell:
        `Not done. "${capability}" is set to ask, and nobody is here to answer — so this ` +
        "has been put to them and is waiting. NOTHING WAS WRITTEN. Do not try another route " +
        "to the same change; carry on with the rest, and say in your result that this one " +
        "is waiting on them.",
    };
  };
}

/** Run `fn` with this run's permissions governing every write inside it. */
export function withRunPermissions<T>(context: RunContext, fn: () => Promise<T>): Promise<T> {
  return withConsent(workflowConsent(context), fn);
}

// ---------------------------------------------------------------------------
// The same rules, for a caller that is not a run
// ---------------------------------------------------------------------------

/**
 * Run `fn` under a workflow's permissions when there is no run to hang them on.
 *
 * Three callers execute a workflow's body without going through
 * ./runner.ts — `GET /message-extraction` and its legacy alias, `GET
 * /screenshots/ingest`, and `scripts/catchup-screenshot-ingestion.ts`, which
 * exists precisely because the sweep outlives any sensible HTTP timeout. Each
 * of them is the same code doing the same unattended writes as the scheduled
 * run, and until this existed each of them was ungated: `currentConsent()`
 * outside `withConsent` is undefined, and undefined means everything goes
 * through. A back door around a standing `deny` is not a smaller failure than
 * no gate at all, and a cron-able script writing OKF is not meaningfully
 * "outside a run".
 *
 * So they are governed by the same rows, resolved against the same slug. What
 * they cannot do is DEFER: a deferred write is answered through the run it
 * belonged to (see `readDeferredWrite`, which needs one), and these have none.
 * `ask` therefore refuses, and says the question was not recorded — the honest
 * sentence, and a reason to start the thing from the Workflows screen where the
 * question would be kept.
 *
 * On a database that has never synced the catalog there is no workflow row and
 * so no seeded rule, which lands everything on the default and refuses it. That
 * is the same answer `startWorkflowRun` gives such a database (it cannot find
 * the workflow either), said in the one place a caller might not expect it —
 * hence the warning rather than a silent wall of refusals.
 */
export function withWorkflowPermissions<T>(db: Db, slug: string, fn: () => Promise<T>): Promise<T> {
  const [row] = db
    .select({ id: s.workflows.id })
    .from(s.workflows)
    .where(eq(s.workflows.slug, slug))
    .limit(1)
    .all();
  if (!row) {
    log.warn(
      `No workflow row for "${slug}", so nothing it ships with is in force here — ` +
        "every write it makes will fall to the default. Run `bun run db:sync-workflows`.",
      { workflow: slug },
    );
  }
  return withConsent(directConsent({ db, workflowId: row?.id, slug }), fn);
}

/** Which workflow's rules govern, for a caller that is not a run. */
export interface DirectContext {
  db: Db;
  /** Absent where this database has never heard of the slug. */
  workflowId?: string;
  slug: string;
}

/** The gate such a caller is governed by: `ask` refuses, because there is
 *  nothing here that could carry the question to a person. */
export function directConsent(context: DirectContext): ConsentGate {
  return (request: ConsentRequest) => {
    const { capability, verdict, fields } = shared(context.db, context, request);
    if (verdict) return verdict;

    log.warn(`${request.tool} refused: ${capability} needs a person and this is not a run`, fields);
    return {
      allow: false,
      tell:
        `Not done. "${capability}" is set to ask, and this was not started as a run — there ` +
        "is no record to attach the question to, so it has NOT been put to anybody and " +
        "NOTHING WAS WRITTEN. Do not try another route to the same change; carry on with the " +
        "rest, and say in your result that this one needs to be run from the Workflows screen, " +
        "where the same write would be kept for them to answer.",
    };
  };
}
