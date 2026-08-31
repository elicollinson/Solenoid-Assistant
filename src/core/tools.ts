import { z } from "zod";
import { authoredText } from "../safety/authoredText";

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

/**
 * Whether a tool observes or changes the world.
 *
 * Two jobs. It splits the briefing, so a model can see at a glance which calls
 * are consequential. And it is what `readOnly()` filters on, which is how an
 * agent whose context holds text a stranger wrote gets a group it cannot write
 * through — the case that matters, since a write tool in that loop is a path
 * for the stranger to author what the user is shown.
 *
 * "read" means it cannot change anything a later read would see. A tool that
 * writes an audit row on the way past is a write; classify by effect, not by
 * how the name reads. When it is genuinely arguable, it is a write.
 */
export type ToolKind = "read" | "write";

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  definition: FunctionToolDefinition;
  kind: ToolKind;
  schema: S;
  execute: (
    args: z.infer<S>,
    context?: { signal?: AbortSignal },
  ) => unknown | Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(config: {
  name: string;
  description: string;
  /** See ToolKind. Required: an unclassified tool has to be assumed a write. */
  kind: ToolKind;
  schema: S;
  execute: (
    args: z.infer<S>,
    context?: { signal?: AbortSignal },
  ) => unknown | Promise<unknown>;
}): AgentTool<S> {
  // Every description reaching this function is a literal in this repository —
  // the MCP adapter builds its AgentTools by hand precisely because a remote
  // server's description is that server's text, not ours. Keep it that way: a
  // description routed through here from anywhere else would be declaring
  // somebody else's words unscreenable. See ../safety/authoredText.ts.
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
        // Zod 4: derive the model-facing JSON schema straight from the Zod schema.
        // (Zod 3? use the `zod-to-json-schema` package instead.)
        parameters: z.toJSONSchema(config.schema) as Record<string, unknown>,
      },
    },
  };
}
