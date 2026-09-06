// Tools an agent fetches rather than holds.
//
// A session that starts holding forty tools spends its whole context window on
// tool definitions before it has read the task. A tool GROUP is the alternative:
// the agent starts holding one loader per group — `get_recommendations_tools`,
// `get_reminders_tools` — each carrying a single line about what that data
// structure is for. Calling a loader answers with a briefing (what the shape is,
// how it moves, what each tool does) AND makes that group's tools callable for
// the rest of the run.
//
// Three properties are the point of doing it this way:
//
//   * The briefing is RENDERED, never written out. The field list comes from the
//     schema (see ../db/schemaDoc.ts, where a mapped type makes an undocumented
//     column a compile error) and the tool list comes from the AgentTool objects
//     themselves, whose Zod schemas already carry every parameter's prose. There
//     is no second copy of anything to drift.
//
//   * The briefing is rendered from the group's ACTUAL tools. A group built
//     read-only for an agent that reads untrusted text cannot advertise a write
//     tool it will then refuse to run.
//
//   * Activation is scoped to one run, not to the Agent. Several agents in this
//     codebase are module-level singletons; if opening a group mutated the
//     agent's tool map, one run's unlocked writes would silently be the next
//     run's starting state.
//
// The briefing must stay a pure function of code — schema, annotations and tool
// definitions, never a row. That is not a style note: it is the licence for
// registering the briefing as authored text (../safety/authoredText.ts), which
// is what stops the injection screen reading our own instructions as an attack.
// Interpolate one row into a briefing and that licence is void.
//
// Cost, said plainly: with one group this pattern costs more context than it
// saves (a briefing plus the definitions, rather than the definitions alone). It
// breaks even at about three groups and pays properly at five or six. Which is
// why the tool section below prints a one-line signature rather than the full
// JSON Schema — the real schemas arrive with the definitions the moment the
// group opens, and printing them twice doubles the price of the whole idea.
import { z } from "zod";
import { authoredText } from "../safety/authoredText";
import type { AgentTool, FunctionToolDefinition } from "./tools";

// ---------------------------------------------------------------------------
// The shape of a record
// ---------------------------------------------------------------------------

/**
 * One field of a data structure, as the agent is told about it.
 *
 * Everything except `note` is derived from the schema by whatever produced it —
 * ../db/schemaDoc.ts for a Drizzle table, by hand for a structure this database
 * does not hold. `note` is the only authored part.
 */
export interface FieldDoc {
  /** The name the tools use, which is the TypeScript property, not the column. */
  name: string;
  /** "text", "integer", "timestamp", or "one of: a | b | c" for an enum. */
  type: string;
  required: boolean;
  /** Rendered as given: `"proposed"`, `0`, `now`. Omit when there is none. */
  default?: string;
  /** "workflows.id" — what this points at, when it points at something. */
  references?: string;
  /** What it is for, in the group author's voice. */
  note?: string;
}

/** A field the tools expose that no single stored column backs. */
export interface DerivedField {
  name: string;
  /** Free text, because these are not columns: "string", "string[]", "pairs". */
  type: string;
  note: string;
}

/** A second table the record spills onto, named as the agent should think of it. */
export interface RelatedShape {
  /** "Cited evidence", not "evidence_links". */
  label: string;
  fields: FieldDoc[];
}

/**
 * What one item IS — separate from what each tool takes, which the tool
 * definitions already say. The two overlap and do different jobs: this answers
 * "what is a recommendation", the tool section answers "how do I call this".
 */
export interface RecordShape {
  /** "recommendation". Used in headings and in the loader's description. */
  singular: string;
  /** The record's own fields. */
  spine: FieldDoc[];
  /** Rows in other tables that belong to one record. */
  related?: RelatedShape[];
  /** Fields assembled on read that no column holds. */
  derived?: DerivedField[];
}

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

export interface ToolGroup {
  /** Lowercase, snake_case. The loader is `get_<name>_tools`. */
  name: string;
  /** The heading of the briefing. Defaults to `name` with its underscores
   *  spaced and its first letter raised, which is wrong for an acronym. */
  title?: string;
  /**
   * The one line the model sees at session start, before it has opened
   * anything. This is the whole basis on which it decides to open the group, so
   * say what the data structure is FOR, not what the tools do.
   */
  summary: string;
  /** What this data structure is for, at length. Two paragraphs is plenty. */
  purpose: string;
  /**
   * The lifecycle and the invariants — the one-way doors, the orders that
   * matter, the thing every tool description would otherwise have to repeat.
   * No introspection can know any of it.
   *
   * Name ACTS, not tools: "forgetting one outright is the last resort", never
   * "recommendations_forget is the last resort". This paragraph is rendered
   * unchanged into the read-only form of the group, where the write tools are
   * gone — prose that names one there is telling an agent about something it
   * does not have. The tool list is rendered from `tools` and is always right;
   * this is the part that can be wrong, and ../tools/groups.test.ts is what
   * catches it. The same goes for `purpose` and for every `note` in `shape`.
   */
  guidance?: string;
  shape: RecordShape;
  /** What opening the group unlocks. The briefing is rendered from this. */
  tools: readonly AgentTool[];
}

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export function loaderName(group: string): string {
  return `get_${group}_tools`;
}

/** `name` → `Name`, `content_cards` → `Content cards`. */
function titleFrom(name: string): string {
  const spaced = name.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Check a group over and hand it back. Everything here is a mistake that would
 * otherwise surface as a model failing to call a tool it was told it had.
 */
export function defineToolGroup(group: ToolGroup): ToolGroup {
  if (!NAME_PATTERN.test(group.name)) {
    throw new Error(
      `Tool group name "${group.name}" must be lowercase snake_case starting with a letter`,
    );
  }
  if (!group.summary.trim()) {
    throw new Error(`Tool group "${group.name}" needs a summary; it is all the model sees at first`);
  }
  if (!group.purpose.trim()) {
    throw new Error(`Tool group "${group.name}" needs a purpose`);
  }
  if (!group.shape.singular.trim()) {
    throw new Error(`Tool group "${group.name}" needs shape.singular`);
  }
  if (!group.tools.length) {
    throw new Error(`Tool group "${group.name}" has no tools, so there is nothing to load`);
  }
  const seen = new Set<string>();
  for (const tool of group.tools) {
    const name = tool.definition.function.name;
    if (seen.has(name)) {
      throw new Error(`Tool group "${group.name}" registers "${name}" twice`);
    }
    seen.add(name);
  }
  if (seen.has(loaderName(group.name))) {
    throw new Error(
      `Tool group "${group.name}" contains a tool named "${loaderName(group.name)}", which is its own loader`,
    );
  }
  return group;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const WRAP_AT = 88;
const NAME_COLUMN = 22;

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = "";
    for (const word of words) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
    out.push("");
  }
  if (out.at(-1) === "") out.pop();
  return out;
}

function paragraphs(text: string): string {
  return wrap(text.trim(), WRAP_AT).join("\n");
}

/** `  status              one of: proposed | adopted, required, default "proposed"` */
/**
 * A name in the gutter and something beside it, wrapped to the same width as
 * every other line here.
 *
 * One helper for all three columns — a field's facts, a derived field's type, a
 * tool's signature — because when only the prose wrapped, three group authors
 * discovered the ragged edge and shortened their OWN text to fit a constraint
 * they had to reverse-engineer from the output. Comments in their files
 * explained the renderer's internals. That is the wrong thing to have taught
 * them: what to say about a field is theirs, how wide the page is, is ours.
 */
function column(name: string, beside: string, indent: number): string {
  const gutter = " ".repeat(indent);
  const [first = "", ...rest] = wrap(beside, WRAP_AT - indent);
  // A name longer than the column takes its own line rather than pushing every
  // other row out of alignment.
  const head = name.length > indent - 2
    ? `  ${name}\n${gutter}${first}`
    : `  ${name.padEnd(indent - 2)}${first}`;
  return [head, ...rest.map((line) => gutter + line)].join("\n");
}

/** The wrapped note under a column, at the same gutter. */
function note(text: string | undefined, indent: number): string[] {
  if (!text) return [];
  const gutter = " ".repeat(indent);
  return wrap(text, WRAP_AT - indent).map((line) => gutter + line);
}

function fieldLine(field: FieldDoc): string {
  const facts = [
    field.type,
    field.required ? "required" : "optional",
    ...(field.default === undefined ? [] : [`default ${field.default}`]),
  ].join(", ");
  const arrow = field.references ? ` → ${field.references}` : "";
  return column(field.name, `${facts}${arrow}`, NAME_COLUMN + 2);
}

function fieldBlock(fields: readonly FieldDoc[]): string {
  return fields
    .map((field) => [fieldLine(field), ...note(field.note, NAME_COLUMN + 2)].join("\n"))
    .join("\n");
}

function derivedBlock(fields: readonly DerivedField[]): string {
  return fields
    .map((field) =>
      [column(field.name, field.type, NAME_COLUMN + 2), ...note(field.note, NAME_COLUMN + 2)].join("\n"),
    )
    .join("\n");
}

/**
 * `recommendations_list(status?, group?, limit?)` — read off the JSON Schema the
 * tool already generated from its Zod schema, so a parameter cannot appear here
 * that the tool does not take.
 */
export function toolSignature(tool: AgentTool): string {
  const params = tool.definition.function.parameters as {
    properties?: Record<string, { default?: unknown }>;
    required?: string[];
  };
  const required = new Set(params.required ?? []);
  const names = Object.entries(params.properties ?? {}).map(([name, property]) =>
    // Zod 4 lists a `.default()` field as required — correct about the parsed
    // object, wrong about the call, where the whole point of a default is that
    // you may leave it out. A property carrying one is optional to supply.
    required.has(name) && property?.default === undefined ? name : `${name}?`,
  );
  return `${tool.definition.function.name}(${names.join(", ")})`;
}

/**
 * The briefing a loader answers with.
 *
 * Pure, and deliberately so: it reads the group and nothing else. Nothing here
 * may touch a database, a file or a network response — see the header.
 */
export function renderBriefing(group: ToolGroup): string {
  const sections: string[] = [
    `# ${group.title ?? titleFrom(group.name)}`,
    paragraphs(group.purpose),
    `## The shape of one ${group.shape.singular}`,
  ];

  const shape = group.shape;
  const reads = group.tools.filter((tool) => tool.kind === "read");
  const writes = group.tools.filter((tool) => tool.kind === "write");
  const hasExtras = Boolean(shape.related?.length || shape.derived?.length);
  sections.push(
    [hasExtras ? "Stored on the record itself:" : "", fieldBlock(shape.spine)]
      .filter(Boolean)
      .join("\n"),
  );
  for (const related of shape.related ?? []) {
    // Wrapped like every other line of prose here. A label is meant to be short,
    // but one that is not should still not run off the edge of the briefing.
    sections.push([...wrap(`${related.label}:`, WRAP_AT), fieldBlock(related.fields)].join("\n"));
  }
  if (shape.derived?.length) {
    sections.push(
      [
        // The second clause is false for a group with no writes, and a briefing
        // that tells a model it can set something it cannot is worse than one
        // that says less.
        writes.length
          ? "Assembled on read, not stored — you set these through the tools that name them:"
          : "Assembled on read, not stored — computed for you each time you read one:",
        derivedBlock(shape.derived),
      ].join("\n"),
    );
  }

  if (group.guidance?.trim()) {
    sections.push("## How they move", paragraphs(group.guidance));
  }

  // Split by kind rather than listed flat. A model deciding whether to call
  // something benefits more from "this one changes things" than from any amount
  // of hedging inside the description, and the split costs one heading.
  sections.push("## The tools you now hold");
  if (reads.length) {
    sections.push(["Reading — these change nothing:", "", describeTools(reads)].join("\n"));
  }
  if (writes.length) {
    sections.push(
      [
        `Writing — each of these changes something, and what a ${shape.singular} says is`,
        "part of the record somebody will read back later:",
        "",
        describeTools(writes),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

function describeTools(tools: readonly AgentTool[]): string {
  return tools
    .map((tool) =>
      [
        // The signature wraps too. recommendations_propose takes seventeen
        // parameters and ran to 221 characters on one line.
        ...wrap(toolSignature(tool), WRAP_AT),
        ...note(tool.definition.function.description, 4),
      ].join("\n"),
    )
    .join("\n\n");
}

/** What the loader's own one-line description says at session start. */
export function renderLoaderDescription(group: ToolGroup): string {
  const names = group.tools.map((tool) => tool.definition.function.name).join(", ");
  return (
    `${group.summary.trim()} ` +
    `Call this to load the ${group.tools.length} tools for working with ` +
    `${group.shape.singular} records — ${names} — none of which you can call until you do. ` +
    `It answers with their schema and how they fit together.`
  );
}

/**
 * The same group with its write tools removed.
 *
 * For an agent whose context holds text somebody else wrote. A write tool in
 * that loop is a path for that stranger to author what the user is later shown,
 * so the answer is not to warn the model off it — it is for the tool not to be
 * there. Because the briefing renders from `tools`, the restricted group does
 * not even mention what it dropped.
 *
 * One implementation, called from one place (../tools/groups.ts), rather than
 * every factory filtering for itself: a group that got its own filter subtly
 * wrong would be a hole nobody could see from the outside.
 */
export function readOnly(group: ToolGroup): ToolGroup {
  const tools = group.tools.filter((tool) => tool.kind === "read");
  if (!tools.length) {
    throw new Error(
      `Tool group "${group.name}" has no read tools, so there is no read-only form of it`,
    );
  }
  if (tools.length === group.tools.length) return group;

  const restricted = defineToolGroup({ ...group, tools });
  // The tool LIST is rendered from `tools` and is therefore always right. The
  // prose is not: `purpose`, `guidance` and every `note` in `shape` are carried
  // over unchanged, and a sentence naming a write tool there tells an agent
  // holding a stranger's text about something it does not have. This is the one
  // place that knows what was dropped, so it is the one place that can check.
  const briefing = renderBriefing(restricted);
  const advertised = group.tools
    .filter((tool) => tool.kind === "write")
    .map((tool) => tool.definition.function.name)
    .filter((name) => briefing.includes(name));
  if (advertised.length) {
    throw new Error(
      `The read-only form of tool group "${group.name}" still names ${advertised.join(", ")} in its ` +
        `prose. Name the act rather than the tool — "forgetting one outright is the last resort" — ` +
        `so the sentence reads correctly whether or not the agent holds the tool.`,
    );
  }
  return restricted;
}

// ---------------------------------------------------------------------------
// The belt: what an Agent holds, and what one run of it opened
// ---------------------------------------------------------------------------

/** Loaders take nothing. Shared across every loader; there is nothing to vary. */
const NO_ARGS = z.object({});

interface CompiledGroup {
  group: ToolGroup;
  /** Rendered once at construction. It cannot change; nothing in it is live. */
  briefing: string;
  definition: FunctionToolDefinition;
}

/**
 * What one name in the belt refers to: a group's loader, or one of its tools.
 *
 * One index rather than three. Registration used to write a name into
 * `claimed`, into a per-group `byName`, and (per run) into a `loaders` map, and
 * then `definitions`, `resolve` and `unopenedOwnerOf` each walked a different
 * one. Adding a tool should not mean remembering three places.
 */
interface Claim {
  group: string;
  /** Absent for a loader, which is built per session because it closes over one. */
  tool?: AgentTool;
}

/**
 * The groups an Agent was built with, compiled once. Immutable and shareable —
 * the mutable part is a ToolSession, which one run owns.
 */
export class ToolBelt {
  private readonly compiled = new Map<string, CompiledGroup>();
  /** Every name this belt answers to: loaders and group tools alike. */
  private readonly claimed = new Map<string, Claim>();

  constructor(groups: readonly ToolGroup[] = []) {
    for (const group of groups) {
      defineToolGroup(group);
      const loader = loaderName(group.name);
      if (this.compiled.has(group.name)) {
        throw new Error(`Tool group "${group.name}" was registered twice`);
      }
      for (const tool of group.tools) {
        const name = tool.definition.function.name;
        const owner = this.claimed.get(name);
        if (owner) {
          throw new Error(
            `Tool "${name}" is claimed by both tool groups "${owner.group}" and "${group.name}"`,
          );
        }
        this.claimed.set(name, { group: group.name, tool });
      }
      const owner = this.claimed.get(loader);
      if (owner) {
        throw new Error(
          `Tool group "${group.name}" needs the name "${loader}", claimed by "${owner.group}"`,
        );
      }
      this.claimed.set(loader, { group: group.name });
      const briefing = renderBriefing(group);
      const description = renderLoaderDescription(group);
      // Both are pure functions of the group, which is a pure function of the
      // source: no row, no file, no response reaches either. That is the whole
      // licence for declaring them ours — see ../safety/authoredText.ts.
      authoredText.offer(`briefing:${group.name}`, briefing);
      authoredText.offer(`loader:${loader}`, description);
      // The sections too, so a model quoting one back in its reasoning is
      // matched. Redaction is exact, so the granularity has to be there.
      for (const section of briefing.split("\n\n")) {
        authoredText.offer(`briefing:${group.name}:section`, section);
      }
      this.compiled.set(group.name, {
        group,
        briefing,
        definition: {
          type: "function",
          function: {
            name: loader,
            description,
            parameters: z.toJSONSchema(NO_ARGS) as Record<string, unknown>,
          },
        },
      });
    }
  }

  get size(): number {
    return this.compiled.size;
  }

  get names(): string[] {
    return [...this.compiled.keys()];
  }

  /** Whether this belt already owns a tool name — loader or member. */
  claims(name: string): boolean {
    return this.claimed.has(name);
  }

  /** The briefing a loader would answer with. For tests and for the docs. */
  briefingFor(group: string): string {
    const compiled = this.compiled.get(group);
    if (!compiled) throw new Error(`No tool group named "${group}"`);
    return compiled.briefing;
  }

  /** A fresh view for one run. Nothing opened in it escapes it. */
  session(): ToolSession {
    return new ToolSession(this.compiled, this.claimed);
  }
}

/**
 * One run's view of the belt: every loader, plus the tools of every group this
 * run has opened. Created per model-route attempt, so a retry on the next route
 * starts from the same closed state the first attempt did.
 */
export class ToolSession {
  private readonly open = new Set<string>();

  constructor(
    private readonly compiled: ReadonlyMap<string, CompiledGroup>,
    private readonly claimed: ReadonlyMap<string, Claim>,
  ) {}

  /** The loader for a group, built where it is handed over — it is the one
   *  thing here that closes over this session, so there is nothing to gain by
   *  building ten of them up front. */
  private loader(entry: CompiledGroup): AgentTool {
    return {
      definition: entry.definition,
      // A loader hands over a briefing and opens a door; it changes nothing a
      // later read would see. Which of the tools BEHIND that door are writes
      // is the group's business, and `readOnly` has already settled it.
      kind: "read",
      schema: NO_ARGS,
      execute: () => {
        this.open.add(entry.group.name);
        return entry.briefing;
      },
    };
  }

  /** Which groups this run has opened, in the order it opened them. */
  get opened(): string[] {
    return [...this.open];
  }

  /** Open a group without the model asking — for an agent that starts with one
   *  group already in hand. The briefing is NOT emitted; the caller is expected
   *  to have put it in the system prompt or to not need it. */
  preopen(group: string): void {
    if (!this.compiled.has(group)) throw new Error(`No tool group named "${group}"`);
    this.open.add(group);
  }

  /** Every definition the model should see this turn. */
  definitions(): FunctionToolDefinition[] {
    const defs = [...this.compiled.values()].map((entry) => entry.definition);
    for (const name of this.open) {
      for (const tool of this.compiled.get(name)!.group.tools) defs.push(tool.definition);
    }
    return defs;
  }

  /** The tool behind a name, if this run may call it. A group tool that has not
   *  been loaded resolves to nothing, exactly as if it did not exist. */
  resolve(name: string): AgentTool | undefined {
    const claim = this.claimed.get(name);
    if (!claim) return undefined;
    if (!claim.tool) return this.loader(this.compiled.get(claim.group)!);
    return this.open.has(claim.group) ? claim.tool : undefined;
  }

  /**
   * Which group a name belongs to, open or not — including a loader's own.
   *
   * Needed because a tool name does not reliably say: nine groups name their
   * tools `<group>_<verb>`, and `read_imessages` and `lookup_contact` do not.
   * Anything that has to attribute a call to a group has to ask rather than
   * parse, or it will be wrong about exactly the two that read the world.
   */
  ownerOf(name: string): string | undefined {
    return this.claimed.get(name)?.group;
  }

  /** Whether a name belongs to a group this run has not opened — the one case
   *  worth a better error than "unknown tool". */
  unopenedOwnerOf(name: string): string | undefined {
    const claim = this.claimed.get(name);
    return claim?.tool && !this.open.has(claim.group) ? claim.group : undefined;
  }
}
