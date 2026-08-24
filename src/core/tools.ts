import { z } from "zod";

export interface FunctionToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// A tool bundles everything about one capability in ONE place: the Zod schema
// (single source of truth) drives both runtime validation AND the JSON schema
// the model sees. No more parallel toolDefs/toolImpls that can drift apart.
// ---------------------------------------------------------------------------

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  definition: FunctionToolDefinition;
  schema: S;
  execute: (
    args: z.infer<S>,
    context?: { signal?: AbortSignal },
  ) => unknown | Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(config: {
  name: string;
  description: string;
  schema: S;
  execute: (
    args: z.infer<S>,
    context?: { signal?: AbortSignal },
  ) => unknown | Promise<unknown>;
}): AgentTool<S> {
  return {
    schema: config.schema,
    execute: config.execute,
    definition: {
      type: "function",
      function: {
        name: config.name,
        description: config.description,
        // Zod 4: derive the model-facing JSON schema straight from the Zod schema.
        // (Zod 3? use the `zod-to-json-schema` package instead.)
        parameters: z.toJSONSchema(config.schema) as Record<string, unknown>,
      },
    },
  };
}
