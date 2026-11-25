import {
  reachesWorld,
  toJsonSchema,
  toolName,
  type AgentToolKind,
  type FunctionToolDefinition,
  type ToolContext,
} from "@elicollinson/solenoid-engine";
import { authoredText, type ToolKind } from "@elicollinson/solenoid-security";
import type { z } from "zod";

export { reachesWorld, toJsonSchema, toolName };
export type { AgentToolKind, FunctionToolDefinition, ToolContext, ToolKind };

// ---------------------------------------------------------------------------
// A tool bundles everything about one capability in ONE place: the Zod schema
// (single source of truth) drives both runtime validation AND the JSON schema
// the model sees. Compatible with @elicollinson/solenoid-engine AgentTool while
// keeping `context` optional for direct unit invocations (`tool.execute(args)`).
// ---------------------------------------------------------------------------

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  definition: FunctionToolDefinition;
  kind: ToolKind;
  schema: S;
  execute: (
    args: z.infer<S>,
    context?: ToolContext | { signal?: AbortSignal },
  ) => unknown | Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(config: {
  name: string;
  description: string;
  /** Required: an unclassified tool has to be assumed a write. */
  kind: ToolKind;
  schema: S;
  execute: (
    args: z.infer<S>,
    context?: ToolContext | { signal?: AbortSignal },
  ) => unknown | Promise<unknown>;
}): AgentTool<S> {
  // Every description reaching this function is a literal in this repository —
  // MCP tools are built by hand so remote descriptions are never whitelisted.
  authoredText.offer(`tool:${config.name}`, config.description);
  return {
    kind: config.kind,
    schema: config.schema,
    execute: config.execute,
    definition: {
      type: "function",
      function: {
        name: config.name,
        description: config.description,
        parameters: toJsonSchema(config.schema),
      },
    },
  };
}
