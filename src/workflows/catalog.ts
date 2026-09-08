// What this service can actually run, described rather than executed.
//
// One entry per workflow with real code behind it. This file is deliberately
// import-light — types and literals only — because three very different places
// read it and none of them should drag in an agent, a model route or an ONNX
// session just to answer "what is on the list":
//
//   * src/workflows/sync.ts writes these rows into the `workflows` table, so
//     the Workflows surface lists them beside the design's fixtures;
//   * src/db/queries/workflows.ts marks a row runnable and hands the detail
//     pane the arguments its trigger form draws;
//   * src/workflows/registry.ts pairs each slug with the function that runs it.
//
// The split is the point: the catalog says what exists, the registry says what
// happens. A workflow missing from the registry is a list entry with a disabled
// Run button rather than a button that throws.
import type { WorkflowInputField } from "../shared/workflows";

export type { WorkflowInputField, WorkflowInputKind } from "../shared/workflows";

export interface WriteCapabilityInfo {
  capability: string;
  label: string;
  description: string;
  tools: readonly string[];
}

export const KNOWN_WRITE_CAPABILITIES: readonly WriteCapabilityInfo[] = [
  {
    capability: "okf.write",
    label: "OKF Memory",
    description: "Write facts, summaries, and memories to the local OKF store",
    tools: ["okf_create", "okf_patch", "okf_move", "okf_deprecate"],
  },
  {
    capability: "calendar.write",
    label: "Calendar Events",
    description: "Create, modify, move, and cancel calendar events",
    tools: [
      "calendar_create_event",
      "calendar_update_event",
      "calendar_delete_event",
      "calendar_move_event",
      "calendar_cancel_event",
    ],
  },
  {
    capability: "reminders.write",
    label: "Reminders",
    description: "Create, update, delete, and complete reminders",
    tools: [
      "reminders_create",
      "reminders_update",
      "reminders_delete",
      "reminders_mark_complete",
    ],
  },
  {
    capability: "recommendations.write",
    label: "Recommendations",
    description: "Propose, archive, and update recommendations",
    tools: [
      "recommendations_create",
      "recommendations_archive",
      "recommendations_update_confidence",
      "recommendations_annotate",
      "recommendations_snooze",
    ],
  },
  {
    capability: "activity.write",
    label: "Activity Notes",
    description: "Annotate and log notes to activity items",
    tools: ["activity_annotate"],
  },
  {
    capability: "workflows.write",
    label: "Workflow Control",
    description: "Pause workflows, adjust schedules, or set instructions",
    tools: [
      "workflows_pause",
      "workflows_set_instructions",
      "workflows_set_summary",
      "workflows_set_schedule",
      "workflows_set_permissions",
    ],
  },
  {
    capability: "notion.write",
    label: "Notion Workspace",
    description: "Create and update pages in Notion workspace",
    tools: ["notion-create-pages", "notion-update-page"],
  },
  {
    capability: "tavily.write",
    label: "Tavily Search",
    description: "Execute web search queries",
    tools: ["tavily-search"],
  },
];

const CAPABILITIES_BY_NAME = new Map(KNOWN_WRITE_CAPABILITIES.map((c) => [c.capability, c]));

export function writeCapabilityInfo(capability: string): WriteCapabilityInfo {
  const existing = CAPABILITIES_BY_NAME.get(capability);
  if (existing) return existing;
  const family = capability.replace(/\.write$/, "");
  return {
    capability,
    label: `${family.charAt(0).toUpperCase()}${family.slice(1)} Write`,
    description: `Write tools in the ${family} family`,
    tools: [],
  };
}

export interface WorkflowCatalogEntry {
  /** Stable, URL-safe, and the primary key the UI routes on. */
  slug: string;
  name: string;
  /** What it is for, in one line. Drawn where a workflow has no run to
   *  summarise yet, which is every one of these on a fresh database. */
  description: string;
  trigger: "schedule" | "on_demand";
  /** The words the table's cadence column shows. */
  cadence: string;
  /** Set only where a schedule genuinely fires it. */
  rrule: string | null;
  /**
   * What this workflow may do unaccompanied, as it SHIPS.
   *
   * Seeded into `workflow_permissions` on the first `db:sync-workflows` and
   * never touched again — the same bargain as `rrule`, and for the same reason:
   * the row is a decision somebody made and this file does not get to overrule
   * it on the next sync.
   *
   * A capability nobody lists is `ask` (see ../workflows/permissions.ts), so
   * every entry below is a write this service ALREADY makes on its own. Writing
   * them down is the point: they were implicit, which meant there was nothing
   * to revoke and nothing to read.
   */
  permissions?: readonly { capability: string; mode: "allow" | "ask" | "deny" }[];
  inputs: readonly WorkflowInputField[];
}

/** A field with the nulls filled in, so an entry below reads as its own shape. */
function field(
  name: string,
  label: string,
  options: Partial<Omit<WorkflowInputField, "name" | "label">> = {},
): WorkflowInputField {
  return {
    name,
    label,
    kind: options.kind ?? "text",
    required: options.required ?? false,
    placeholder: options.placeholder ?? null,
    default: options.default ?? null,
    help: options.help ?? null,
  };
}

export const WORKFLOW_CATALOG: readonly WorkflowCatalogEntry[] = [
  {
    slug: "message-extraction",
    name: "iMessage extraction",
    description:
      "Read the iMessage window, screen every conversation for injected instructions, pull out action items and summaries, and offer what is worth keeping to memory.",
    trigger: "on_demand",
    cadence: "On demand",
    rrule: null,
    // It ends by handing what survived the grader to `okfManagerAgent`, which
    // holds okf_create/patch/move/deprecate. That is the whole point of the
    // workflow, so it ships allowed — and is now a rule you can turn off.
    permissions: [{ capability: "okf.write", mode: "allow" }],
    inputs: [
      field("start", "From", {
        kind: "datetime",
        help: "Leave both blank and I read the last 24 hours.",
      }),
      field("end", "To", { kind: "datetime", help: "Defaults to now." }),
    ],
  },
  {
    slug: "screenshot-classification",
    name: "Screenshot classification",
    description:
      "Describe recent screenshots with the vision model and classify each as a book, film, show, game, music — or reject it. Reads the Photos library; writes nothing.",
    trigger: "on_demand",
    cadence: "On demand",
    rrule: null,
    // None, and the description says why: the classifier agent holds no tools
    // at all. "Writes nothing" is a claim this makes enforceable rather than
    // merely true today.
    inputs: [
      field("hoursBack", "Hours back", { kind: "number", default: 24 }),
      field("limit", "Most screenshots", {
        kind: "number",
        default: 10,
        help: "Vision calls are slow. Start small.",
      }),
    ],
  },
  {
    slug: "screenshot-ingestion",
    name: "Screenshot ingestion",
    description:
      "Classify recent screenshots, source a content card for everything that isn't rejected, and write it into the Notion gallery. This one writes to your workspace.",
    trigger: "on_demand",
    cadence: "On demand",
    rrule: null,
    // Two, because two MCP servers are reached. `notion.write` is the real
    // one: it creates and updates pages in your workspace. `tavily.write` is
    // an artefact of ../mcp/adapter.ts marking every remote tool a write — a
    // remote server does not say whether a call changes anything, so the safe
    // guess is that it does, and a web search is caught by it.
    permissions: [
      { capability: "notion.write", mode: "allow" },
      { capability: "tavily.write", mode: "allow" },
    ],
    inputs: [
      field("hoursBack", "Hours back", { kind: "number", default: 24 }),
      field("limit", "Most screenshots", {
        kind: "number",
        default: 5,
        help: "Each one costs a vision call, a web search and a Notion write.",
      }),
    ],
  },
  {
    slug: "safety-classification",
    name: "Prompt-injection screen",
    description:
      "Chunk a piece of text and score every chunk for injected instructions, reporting the most concerning one.",
    trigger: "on_demand",
    cadence: "On demand",
    rrule: null,
    inputs: [
      field("input", "Text to screen", {
        kind: "textarea",
        required: true,
        placeholder: "Paste whatever you want me to look at.",
      }),
      field("maxLength", "Words per chunk", { kind: "number", default: 40 }),
    ],
  },
  {
    slug: "weather-briefing",
    name: "Weather briefing",
    description:
      "The demo tool-using agent: look up a city's weather and write it up.",
    trigger: "schedule",
    cadence: "Daily, 07:00",
    // The schedule this one SHIPS with. Seeded into `workflow_schedules` on the
    // first `db:sync-workflows` and never touched again — the row is the truth
    // after that, and moving it through the screen or by asking the agent is a
    // decision this file does not get to overrule on the next restart.
    rrule: "FREQ=DAILY;BYHOUR=7;BYMINUTE=0",
    inputs: [field("city", "City", { required: true, default: "San Francisco" })],
  },
];

const BY_SLUG = new Map(WORKFLOW_CATALOG.map((entry) => [entry.slug, entry]));

/** The entry for a slug, or undefined for a workflow with no code behind it. */
export function catalogEntry(slug: string): WorkflowCatalogEntry | undefined {
  return BY_SLUG.get(slug);
}
