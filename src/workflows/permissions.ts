// What a workflow may do with nobody watching.
//
// Delegates canonical capability derivation (`_` before `-`), scoped permission
// resolution, and ambient AsyncLocalStorage tool gating to
// `@elicollinson/solenoid-security` so every `solenoid-engine` Agent running
// inside `withRunPermissions` / `withWorkflowPermissions` enforces workflow
// rules automatically.
import {
  DEFAULT_PERMISSION_MODE,
  capabilityFor,
  resolveScopedPermission,
  withToolGate,
  type ToolGate,
  type ToolRequest,
  type ToolVerdict,
} from "@elicollinson/solenoid-security";
import { and, eq, isNull } from "drizzle-orm";
import { log as baseLog, type LogAttributes } from "../core/logger";
import type { Db } from "../db";
import { deferWorkflowWrite } from "../db/mutations/workflows";
import * as s from "../db/schema";

const log = baseLog.child("permissions");

export type PermissionMode = (typeof s.PERMISSION_MODE)[number];

/** What governs a capability nobody has written a rule for. */
export const DEFAULT_MODE: PermissionMode = DEFAULT_PERMISSION_MODE;

/** Canonical write-tool capability derivation from `@elicollinson/solenoid-security`. */
export { capabilityFor };

/**
 * The live rule for a capability: this workflow's, else the global one, else
 * the default (`ask`), resolved through `@elicollinson/solenoid-security`.
 */
export function resolvePermission(
  db: Db,
  /** Undefined where the caller is not a synced workflow; global rules govern. */
  workflowId: string | undefined,
  capability: string,
): { mode: PermissionMode; scope: "workflow" | "global" | "default" } {
  const own = workflowId
    ? live(db, eq(s.workflowPermissions.workflowId, workflowId), capability)
    : undefined;
  const global = live(db, isNull(s.workflowPermissions.workflowId), capability);
  const resolved = resolveScopedPermission({
    tool: capability,
    ...(own ? { workflow: { [capability]: own } } : {}),
    ...(global ? { global: { [capability]: global } } : {}),
  });
  return {
    mode: resolved.mode,
    scope:
      resolved.scope === "workflow" || resolved.scope === "global"
        ? resolved.scope
        : "default",
  };
}

function live(
  db: Db,
  scope: ReturnType<typeof eq> | ReturnType<typeof isNull>,
  capability: string,
): PermissionMode | undefined {
  const [row] = db
    .select({ mode: s.workflowPermissions.mode })
    .from(s.workflowPermissions)
    .where(
      and(
        scope,
        eq(s.workflowPermissions.capability, capability),
        isNull(s.workflowPermissions.retiredAt),
      ),
    )
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

function shared(
  db: Db,
  scope: { workflowId?: string; slug: string; runId?: string },
  request: ToolRequest,
): { capability: string; verdict: ToolVerdict | null; fields: LogAttributes } {
  if (request.kind === "read") {
    return {
      capability: capabilityFor(request.tool),
      verdict: { allow: true },
      fields: { workflow: scope.slug },
    };
  }
  const capability = capabilityFor(request.tool);
  const resolved = resolvePermission(db, scope.workflowId, capability);
  const fields: LogAttributes = {
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
export function workflowConsent(context: RunContext): ToolGate {
  return (request: ToolRequest) => {
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
    log.warn(`${request.tool} deferred: ${capability} needs a person`, {
      ...fields,
      decision_id: decisionId,
    });
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
export function withRunPermissions<T>(
  context: RunContext,
  fn: () => Promise<T>,
): Promise<T> {
  return withToolGate(workflowConsent(context), fn);
}

// ---------------------------------------------------------------------------
// The same rules, for a caller that is not a run
// ---------------------------------------------------------------------------

/** Run `fn` under a workflow's permissions when there is no run to hang them on. */
export function withWorkflowPermissions<T>(
  db: Db,
  slug: string,
  fn: () => Promise<T>,
): Promise<T> {
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
  return withToolGate(directConsent({ db, workflowId: row?.id, slug }), fn);
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
export function directConsent(context: DirectContext): ToolGate {
  return (request: ToolRequest) => {
    const { capability, verdict, fields } = shared(context.db, context, request);
    if (verdict) return verdict;

    log.warn(
      `${request.tool} refused: ${capability} needs a person and this is not a run`,
      fields,
    );
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
