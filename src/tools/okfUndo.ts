import { z } from "zod";
import { defineTool } from "../core/tools";
import type { HistoryRuntime } from "../writeHistory/runtime";

/** Intentionally unregistered: no UI, tool group, workflow or deferred resolver
 * exposes undo yet. A future caller must use the existing write consent boundary. */
export function createOkfUndoTool(runtime: HistoryRuntime) {
  return defineTool({ name: "okf_undo", kind: "write", description: "Undo one saved OKF write if no later edits or references conflict.",
    schema: z.object({ operationId: z.string().min(1) }), execute: ({ operationId }) => runtime.files.undo(operationId) });
}
