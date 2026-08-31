// What an agent can fetch, listed rather than constructed.
//
// Same split as ../workflows/catalog.ts and ../workflows/registry.ts: this file
// says which tool groups exist and how to build one; each group's own file says
// what it is and what its tools do. A group is registered here and nowhere else,
// so "what could this agent open" is one list rather than a grep.
//
// Adding a group is:
//
//   1. In the group's own file (e.g. ./recommendations.ts), export a factory
//      that returns `defineToolGroup({ ... })`. Its `shape.spine` comes from
//      `describeTable(s.recommendations, { ... })` in ../db/schemaDoc.ts, whose
//      notes argument is a mapped type — every column must be documented or
//      explicitly marked `null`, or it will not compile.
//   2. Add one line to TOOL_GROUP_CATALOG below.
//   3. Hand the group to an Agent as `toolGroups: [...]` rather than `tools`.
//
// Nothing else changes: the tools themselves stay ordinary `defineTool` calls
// and keep working if handed to an agent directly.
import { readOnly, type ToolGroup } from "../core/toolGroups";
import type { Db } from "../db";
import { activityGroup } from "./activity";
import { calendarGroup } from "./calendar";
import { contactsGroup } from "./contacts";
import { imessageGroup, type ReadWindow } from "./imessage";
import { knowledgeGroup } from "./knowledge";
import { okfGroup } from "./okf";
import { photosGroup } from "./photos";
import { recommendationsGroup } from "./recommendations";
import { remindersGroup } from "./reminders";
import { workflowsGroup } from "./workflows";

/**
 * How much of a group an agent may open.
 *
 * This is not a preference. Several of these tool sets carry write tools that
 * must not sit in the same loop as text a stranger wrote — an agent reading
 * email while holding a propose or create tool is a path for that stranger to
 * author what the user is shown. Such an agent gets `read_only`, and because
 * the briefing is rendered from the group's actual tools, it is never even told
 * the write tools exist.
 */
export type ToolGroupTrust = "read_only" | "full";

/**
 * What a group needs to bind itself to.
 *
 * Every handle here is bound by the caller and never comes from the model, for
 * the reason the factories are factories: nothing the model says can redirect a
 * group at another database, another bundle or a wider time window.
 */
export interface ToolGroupContext {
  db: Db;
  /** For the groups backed by the OKF bundle on disk rather than the database. */
  okf?: {
    root: string;
    /** Recorded as `generated.by`. An agent that could name its own actor could
     *  claim `human:...` and forge the top trust tier (spec §5.3). */
    actor: string;
  };
  /** The window the iMessage group may read. Absent means its own default. */
  imessage?: ReadWindow;
}

export interface ToolGroupOptions {
  /** Defaults to `read_only`: the safe answer is the one you get by forgetting. */
  trust?: ToolGroupTrust;
}

/**
 * A group, bound to its data at construction.
 *
 * The handle is bound here and never comes from the model, for the reason
 * ./okf.ts and ./recommendations.ts are both factories: nothing the model says
 * can redirect these at another database.
 *
 * A factory always returns EVERY tool it has. It never filters for trust —
 * `readOnly` in ../core/toolGroups.ts does that, once, for all of them. Ten
 * factories each filtering for themselves is ten chances to get it wrong in a
 * way nobody can see from outside.
 */
export type ToolGroupFactory = (context: ToolGroupContext) => ToolGroup;

/**
 * Every group this service can offer, keyed by the name in `get_<name>_tools`.
 *
 * Ordered as a reader would want them: the surfaces this product is about
 * first, then the sources it reads the world through. An agent is given the few
 * it could plausibly need, never the lot — see buildToolGroups.
 */
export const TOOL_GROUP_CATALOG: Readonly<Record<string, ToolGroupFactory>> = {
  // The surfaces: this app's own records, and the screens built on them.
  recommendations: recommendationsGroup,
  reminders: remindersGroup,
  calendar: calendarGroup,
  workflows: workflowsGroup,
  knowledge: knowledgeGroup,
  activity: activityGroup,
  // The sources: what the assistant reads the world through. Everything these
  // answer with was written by somebody else — see ../safety/trust.ts — so
  // `imessage`, `photos` and `contacts` have no write tool at all and the
  // read-only form of each is the group itself.
  //
  // `okf` is the exception and is listed here because it is READ the same way:
  // it is the memory the agent forms out of everything above it. It carries
  // four writes (okf_create, okf_patch, okf_move, okf_deprecate), so unlike its
  // three neighbours it has a read-only form that is genuinely smaller — which
  // is the whole reason `readOnly` filters rather than asserts.
  okf: okfGroup,
  imessage: imessageGroup,
  photos: photosGroup,
  contacts: contactsGroup,
};


/** Thrown when an agent asks for a group that is not in the catalog. */
export class NoSuchToolGroupError extends Error {
  constructor(name: string) {
    super(
      `No tool group named "${name}". Known groups: ${
        Object.keys(TOOL_GROUP_CATALOG).join(", ") || "(none registered yet)"
      }`,
    );
    this.name = "NoSuchToolGroupError";
  }
}

/**
 * Build the named groups, all at one trust level.
 *
 * The usual call: `new Agent({ ..., toolGroups: buildToolGroups({ db }, ["recommendations"]) })`.
 * Naming them explicitly rather than taking everything is the point — an agent
 * should be able to open only what its job could plausibly need.
 */
export function buildToolGroups(
  context: ToolGroupContext,
  names: readonly string[],
  options: ToolGroupOptions = {},
): ToolGroup[] {
  return names.map((name) => {
    const factory = TOOL_GROUP_CATALOG[name];
    if (!factory) throw new NoSuchToolGroupError(name);
    const group = factory(context);
    return (options.trust ?? "read_only") === "full" ? group : readOnly(group);
  });
}
