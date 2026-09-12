import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { currentConsent, type ConsentRequest } from "./consent";

export type WriteOutcome = "not_dispatched" | "dispatch_started" | "committed" | "no_effect" | "outcome_unknown" | "partial";
export type WriteResponse = "pending" | "delivered" | "blocked" | "failed" | "caller_cancelled";
export interface WriteCall {
  id: string;
  parentId?: string;
  origin?: string;
  actor?: string;
  runId?: string;
  workflowId?: string;
  idempotencyKey?: string;
  deferResponse?: boolean;
  onDispatch?: () => void;
}
export interface WriteRecorder {
  begin(call: WriteCall, tool: string): void;
  outcome(id: string, outcome: WriteOutcome, code?: string): void;
  response(id: string, response: WriteResponse): void;
  targets?(id: string, targets: string[]): void;
}
const calls = new AsyncLocalStorage<WriteCall>();
let recorder: WriteRecorder | undefined;
let requireConsent = false;
/** Installed at application startup; tests and library consumers may inject a recorder. */
export function configureWriteExecution(next?: WriteRecorder, strictConsent = false): void {
  recorder = next;
  requireConsent = strictConsent;
}
export function currentWriteCall(): WriteCall | undefined { return calls.getStore(); }
export function newWriteCall(extra: Partial<WriteCall> = {}): WriteCall {
  const parent = calls.getStore();
  return { ...parent, id: randomUUID(), parentId: parent?.id, onDispatch: undefined, idempotencyKey: undefined, ...extra };
}
export function withWriteCall<T>(call: WriteCall, fn: () => T): T { return calls.run(call, fn); }
export function recordWriteResponse(call: WriteCall, response: WriteResponse): void {
  recorder?.response(call.id, response);
}
export function recordWriteOutcome(outcome: WriteOutcome, code?: string): void {
  const call = calls.getStore();
  if (call) recorder?.outcome(call.id, outcome, `adapter:${code ?? "reported"}`);
}

/** One boundary for ordinary agent, voice, deferred and directly invoked tools.
 * Arguments/results deliberately never enter generic history: adapters own safe capture.
 */
export async function executeWrite<T>(request: ConsentRequest, fn: () => T | Promise<T>): Promise<T | string> {
  const call = calls.getStore() ?? newWriteCall({ origin: "direct-tool", actor: "agent" });
  return calls.run(call, async () => {
    recorder?.begin(call, request.tool);
    const args = request.args as Record<string, unknown> | null;
    if (args && typeof args === "object") recordTargets(call, [args.id, args.from, args.to, args.reminderId, args.page_id, args.canonicalId]);
    const gate = currentConsent();
    const verdict = gate ? await gate(request) : requireConsent ? { allow: false as const, tell: "Not done. This write needs an authorized chat, workflow, or review action." } : { allow: true as const };
    if (!verdict.allow) {
      recorder?.outcome(call.id, "not_dispatched", "permission");
      recorder?.response(call.id, "delivered");
      return verdict.tell;
    }
    recorder?.outcome(call.id, "dispatch_started");
    call.onDispatch?.();
    try {
      const result = await fn();
      if (result && typeof result === "object" && "id" in result) recordTargets(call, [result.id]);
      recorder?.outcome(call.id, "committed");
      if (!call.deferResponse) recorder?.response(call.id, "delivered");
      return result;
    } catch (error) {
      // A throw cannot prove no side effect. An adapter can record a stronger outcome.
      recorder?.outcome(call.id, "outcome_unknown", "execution_error");
      if (!call.deferResponse) recorder?.response(call.id, "failed");
      throw error;
    }
  });
}

function recordTargets(call: WriteCall, values: unknown[]) {
  const ids = values.filter((v): v is string => typeof v === "string" && /^[\w/:.-]{1,200}$/.test(v));
  if (ids.length) recorder?.targets?.(call.id, [...new Set(ids)]);
}
/** Domain entry points share the operation already established by a tool.
 * Direct user/worker mutations receive their own durable history record.
 */
export function auditDomain<T>(name: string, fn: () => T, target?: unknown): T {
  if (calls.getStore()) return fn();
  const call = newWriteCall({ origin: "domain", actor: "system" });
  recorder?.begin(call, name); recordTargets(call, [target]);
  return calls.run(call, () => {
    recorder?.outcome(call.id, "dispatch_started");
    try {
      const result = fn();
      recordTargets(call, [result]);
      recorder?.outcome(call.id, "committed"); recorder?.response(call.id, "delivered");
      return result;
    } catch (e) {
      recorder?.outcome(call.id, "outcome_unknown", "domain_error"); recorder?.response(call.id, "failed"); throw e;
    }
  });
}

export type FileMutation = <T>(root: string, actor: string, tool: string, stage: (root: string) => Promise<T>) => Promise<T>;
let fileMutation: FileMutation | undefined;
export function configureFileMutation(handler?: FileMutation): void { fileMutation = handler; }
export function fileMutationHandler(): FileMutation | undefined { return fileMutation; }

export type RowMutation = <T>(table: "reminders" | "collection_items", id: string, fields: string[], fn: () => T) => T;
let rowMutation: RowMutation | undefined;
export function configureRowMutation(handler?: RowMutation): void { rowMutation = handler; }
export function rowMutationHandler(): RowMutation | undefined { return rowMutation; }
