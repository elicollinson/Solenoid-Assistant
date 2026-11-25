import type { ToolGroup as EngineToolGroup } from "@elicollinson/solenoid-engine";
import type { ToolGroup as LegacyToolGroup } from "../core/toolGroups";
import type { TOOL_GROUP_CATALOG, ToolGroupContext } from "./groups";

export type ToolGroupName = keyof typeof TOOL_GROUP_CATALOG;

export interface CompileToolGroupOptions {
  /** When true, strips write tools and omits write descriptions from the compiled briefing. */
  readOnly?: boolean;
}

export interface CompileToolCatalogOptions extends CompileToolGroupOptions {
  /** Subset of catalog group names to compile; defaults to all 13 catalog groups. */
  groups?: readonly ToolGroupName[];
}

/**
 * Compiles one solenoid-assistant `RecordShape`-backed `ToolGroup` into a
 * `solenoid-engine` `defineToolGroup` (`open_tool_group`), preserving Drizzle-checked
 * table briefings and registering authored text into `@elicollinson/solenoid-security`.
 */
export function compileToolGroup(
  _group: LegacyToolGroup,
  _options?: CompileToolGroupOptions,
): EngineToolGroup {
  throw new Error("Not implemented: compileToolGroup");
}

/**
 * Compiles the full (or selected subset of) `TOOL_GROUP_CATALOG` into engine `ToolGroup[]`.
 */
export function compileToolCatalog(
  _context: ToolGroupContext,
  _options?: CompileToolCatalogOptions,
): EngineToolGroup[] {
  throw new Error("Not implemented: compileToolCatalog");
}
