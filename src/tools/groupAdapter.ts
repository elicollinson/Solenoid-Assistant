import {
  defineToolGroup as defineEngineToolGroup,
  type AgentTool as EngineAgentTool,
  type ToolGroup as EngineToolGroup,
} from "@elicollinson/solenoid-engine";
import { authoredText } from "@elicollinson/solenoid-security";
import {
  defineToolGroup as validateLegacyToolGroup,
  readOnly,
  renderBriefing,
  type ToolGroup as LegacyToolGroup,
} from "../core/toolGroups";
import type { AgentTool as LegacyAgentTool } from "../core/tools";
import {
  NoSuchToolGroupError,
  TOOL_GROUP_CATALOG,
  type ToolGroupContext,
} from "./groups";

export type ToolGroupName =
  | "recommendations"
  | "reminders"
  | "calendar"
  | "workflows"
  | "logs"
  | "github"
  | "knowledge"
  | "activity"
  | "okf"
  | "imessage"
  | "photos"
  | "contacts"
  | "pushover";

export interface CompileToolGroupOptions {
  /** When true, strips write tools and omits write descriptions from the compiled briefing. */
  readOnly?: boolean;
}

export interface CompileToolCatalogOptions extends CompileToolGroupOptions {
  /** Subset of catalog group names to compile; defaults to all 13 catalog groups. */
  groups?: readonly ToolGroupName[];
}

function adaptTool(tool: LegacyAgentTool): EngineAgentTool {
  const { $schema: _metaSchema, ...parameters } = tool.definition.function.parameters as Record<
    string,
    unknown
  > & { $schema?: unknown };
  const name = tool.definition.function.name;
  const description = tool.definition.function.description;
  authoredText.offer(`tool:${name}`, description);
  return {
    kind: tool.kind,
    schema: tool.schema,
    definition: {
      type: "function",
      function: {
        name,
        description,
        parameters,
      },
    },
    execute: (args, context) => tool.execute(args, context),
  };
}

/**
 * Compiles one solenoid-assistant `RecordShape`-backed `ToolGroup` into a
 * `solenoid-engine` `defineToolGroup` (`open_tool_group`), preserving Drizzle-checked
 * table briefings and registering authored text into `@elicollinson/solenoid-security`.
 */
export function compileToolGroup(
  group: LegacyToolGroup,
  options: CompileToolGroupOptions = {},
): EngineToolGroup {
  validateLegacyToolGroup(group);
  const effective = options.readOnly ? readOnly(group) : group;
  const briefing = renderBriefing(effective);

  if (options.readOnly) {
    const droppedWrites = group.tools
      .filter((tool) => tool.kind === "write")
      .map((tool) => tool.definition.function.name);
    const leaked = droppedWrites.filter(
      (name) => briefing.includes(name) || effective.summary.includes(name),
    );
    if (leaked.length > 0) {
      throw new Error(
        `Read-only compilation of tool group "${effective.name}" leaked dropped write tool names: ${leaked.join(", ")}`,
      );
    }
  }

  authoredText.offer(`group:${effective.name}:summary`, effective.summary);
  for (const section of briefing.split("\n\n")) {
    authoredText.offer(`briefing:${effective.name}:section`, section);
  }

  const tools = effective.tools.map(adaptTool);
  return defineEngineToolGroup({
    name: effective.name,
    summary: effective.summary,
    briefing,
    tools,
  });
}

/**
 * Compiles the full (or selected subset of) `TOOL_GROUP_CATALOG` into engine `ToolGroup[]`.
 */
export function compileToolCatalog(
  context: ToolGroupContext,
  options: CompileToolCatalogOptions = {},
): EngineToolGroup[] {
  const names = options.groups ?? (Object.keys(TOOL_GROUP_CATALOG) as ToolGroupName[]);
  return names.map((name) => {
    const factory = TOOL_GROUP_CATALOG[name];
    if (!factory) throw new NoSuchToolGroupError(name);
    return compileToolGroup(factory(context), { readOnly: options.readOnly });
  });
}
