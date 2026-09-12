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

export type FileMutation = <T>(root: string, actor: string, tool: string, stage: (root: string) => Promise<T>) => Promise<T>;
let fileMutation: FileMutation | undefined;
export function configureFileMutation(handler?: FileMutation): void { fileMutation = handler; }
export function fileMutationHandler(): FileMutation | undefined { return fileMutation; }

export type RowMutation = <T>(table: "reminders" | "collection_items", id: string, fields: string[], fn: () => T) => T;
let rowMutation: RowMutation | undefined;
export function configureRowMutation(handler?: RowMutation): void { rowMutation = handler; }
export function rowMutationHandler(): RowMutation | undefined { return rowMutation; }
