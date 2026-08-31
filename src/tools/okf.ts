// Agent-facing tools for an OKF knowledge bundle (specs/okf/spec.md).
//
// A factory rather than module-level singletons (unlike the other tools in this
// directory) because two things must be bound at construction and never come
// from the model: the bundle root, and the actor recorded as `generated.by`.
// An agent that could name its own actor could claim to be `human:...` and
// forge the top trust tier (§5.3).
//
// Read tools (okf_list / okf_read / okf_search) are safe to hand to any agent.
// The write tools should NOT go in the same loop as untrusted input — an agent
// reading iMessages while holding okf_create is a direct write-to-memory
// injection path. Have the intake agent emit a proposal and let a separate
// librarian agent, whose context holds no untrusted text, commit it.
//
// Two ways in, one set of tools behind them. `createOkfTools` hands back the
// tools (and the store) for an agent built around the bundle — ../agents/
// okfManager.ts is that agent. `okfGroup` wraps the same seven as a tool group
// an agent FETCHES (../core/toolGroups.ts), which is how an agent that mostly
// does something else gets at the bundle without carrying seven definitions it
// will probably never call. Neither filters for trust: `readOnly` in the core
// does that, once, for every group.
//
// What this file deliberately cannot do: set `verified`, name its own actor, or
// delete anything. The first two are the trust tier (§5.3) and the third is the
// bundle's memory of what was once believed (§5.4).
import { join } from "node:path";
import { z } from "zod";
import { defineTool, type AgentTool } from "../core/tools";
import {
  defineToolGroup,
  type DerivedField,
  type FieldDoc,
  type ToolGroup,
} from "../core/toolGroups";
import { OkfStore, type OkfStoreOptions } from "../okf/store";
import type { BodyOp } from "../okf/body";
import type { ToolGroupContext } from "./groups";
import { limit } from "./_shared";

const statusSchema = z
  .enum(["draft", "stable", "deprecated"])
  .describe("Lifecycle status (§5.4). Absent means 'stable'.");

const trustSchema = z
  .enum(["unverified", "machine-confirmed", "human-reviewed"])
  .describe("Trust tier derived from `verified` (§5.3).");

const sourceSchema = z.object({
  resource: z
    .string()
    .min(1)
    .describe(
      "What this was derived from: a URL, a bundle path like '/tables/orders.md', or a scope " +
        "descriptor a reader cannot follow (e.g. 'all queries in BigQuery project X').",
    ),
  id: z
    .string()
    .optional()
    .describe("Stable key for citing this source from the body with a [^id] footnote."),
  title: z.string().optional().describe("Human-readable label for the source."),
  author: z
    .string()
    .optional()
    .describe("Who produced the source: 'team:x', 'human:x', or '<producer>/<version>'."),
  usage_count: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("How often the source was exercised in the usage window — a liveness signal."),
  last_modified: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("When the source itself last changed (YYYY-MM-DD)."),
});

const usageWindowSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const staleAfterSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional()
  .describe(
    "Absolute date this content should be re-checked (§5.5). Omit for the default horizon; " +
      "pass null for a fact that does not expire.",
  );

const extraSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .describe(
    "Additional producer-defined frontmatter, e.g. the Attested Computation fields " +
      "`runtime`, `parameters`, `computation`, `executor`, `attester` (§10). Cannot be used to " +
      "set `verified`, `generated`, or any field this tool already names.",
  );

const bodyEditSchema = z
  .object({
    op: z
      .enum(["replace", "append", "add", "delete", "replaceAll"])
      .describe(
        "replace: swap a section's content (must exist). append: add to the end of a section " +
          "(must exist). add: create a new section (must NOT exist). delete: remove a section. " +
          "replaceAll: rewrite the whole body.",
      ),
    section: z
      .string()
      .optional()
      .describe("Heading text to act on, without the '#' (e.g. 'Schema'). Required unless op is replaceAll."),
    content: z.string().optional().describe("Markdown content. Required for every op except delete."),
    level: z
      .number()
      .int()
      .min(1)
      .max(6)
      .optional()
      .describe("Heading level for op 'add' (default 1)."),
  })
  .refine((v) => v.op === "replaceAll" || !!v.section?.trim(), {
    error: "`section` is required unless op is 'replaceAll'",
  })
  .refine((v) => v.op === "delete" || typeof v.content === "string", {
    error: "`content` is required for this op",
  });

function toBodyOp(edit: z.infer<typeof bodyEditSchema>): BodyOp {
  if (edit.op === "replaceAll") return { op: "replaceAll", content: edit.content ?? "" };
  const section = (edit.section ?? "").trim();
  if (edit.op === "delete") return { op: "delete", section };
  if (edit.op === "add") {
    return { op: "add", section, content: edit.content ?? "", ...(edit.level ? { level: edit.level } : {}) };
  }
  return { op: edit.op, section, content: edit.content ?? "" };
}

export interface OkfTools {
  list: AgentTool;
  read: AgentTool;
  search: AgentTool;
  create: AgentTool;
  patch: AgentTool;
  move: AgentTool;
  deprecate: AgentTool;
  /** Everything, for a librarian agent. */
  all: AgentTool[];
  store: OkfStore;
}

export function createOkfTools(opts: OkfStoreOptions): OkfTools {
  const store = new OkfStore(opts);

  const list = defineTool({
    name: "okf_list",
    kind: "read",
    description:
      "List what a knowledge bundle directory contains — the cheap first step before reading " +
      "anything. Returns each concept's id, title, description, type, status, trust tier and " +
      "staleness, plus any subgroups. Call with no arguments for the bundle root.",
    schema: z.object({
      path: z
        .string()
        .default("")
        .describe("Group (directory) to list, e.g. 'finance/computations'. Empty means the bundle root."),
    }),
    execute: ({ path }) => store.list(path),
  });

  const read = defineTool({
    name: "okf_read",
    kind: "read",
    description:
      "Read one concept by id (its path in the bundle without the .md, e.g. 'tables/orders'). " +
      "Returns its frontmatter, body, derived trust tier and staleness, and its outbound links " +
      "with a flag for whether each target exists — follow those to crawl the bundle.",
    schema: z.object({
      id: z.string().min(1).describe("Concept id, e.g. 'metrics/revenue'."),
      frontmatterOnly: z
        .boolean()
        .default(false)
        .describe("Skip the body and links — use when scanning many concepts cheaply."),
    }),
    execute: ({ id, frontmatterOnly }) => store.read(id, { frontmatterOnly }),
  });

  const search = defineTool({
    name: "okf_search",
    kind: "read",
    description:
      "Find concepts by text and/or by their metadata. Text matches the id, title, description " +
      "and body; the filters narrow by frontmatter. Use it before creating anything, to avoid " +
      "writing a concept that already exists.",
    schema: z.object({
      query: z.string().optional().describe("Case-insensitive text to look for. Omit to filter only."),
      type: z.string().optional().describe("Exact concept type, e.g. 'Metric', 'Playbook'."),
      tags: z
        .array(z.string())
        .optional()
        .describe("Match concepts carrying ANY of these tags."),
      status: statusSchema.optional(),
      minTrust: trustSchema.optional().describe("Return only concepts at this trust tier or higher."),
      staleOnly: z
        .boolean()
        .default(false)
        .describe("Return only concepts past their stale_after date — i.e. due for a re-check."),
      limit: limit({ max: 100, default: 20, keeps: "the first matches the store returns" }),
    }),
    execute: (args) => store.search(args),
  });

  const create = defineTool({
    name: "okf_create",
    kind: "write",
    description:
      "Create a new concept — one markdown document capturing one unit of knowledge. Fails if " +
      "the id is already taken (use okf_patch to change an existing concept). Parent groups are " +
      "created automatically, so 'finance/metrics/revenue' needs no separate step. " +
      "`generated.by`/`generated.at` are stamped automatically and cannot be supplied.",
    schema: z.object({
      id: z
        .string()
        .min(1)
        .describe(
          "Path within the bundle without the .md, e.g. 'finance/metrics/revenue'. Slashes create " +
            "groups. 'index' and 'log' are reserved.",
        ),
      type: z
        .string()
        .min(1)
        .describe(
          "What kind of thing this is — short and self-explanatory, e.g. 'Metric', 'Playbook', " +
            "'BigQuery Table', 'Reference', 'Attested Computation'. Reuse a type already in the bundle when one fits.",
        ),
      title: z.string().optional().describe("Human-readable display name."),
      description: z.string().optional().describe("One sentence summarizing the concept; shown in listings."),
      resource: z
        .string()
        .optional()
        .describe("Canonical URI of the underlying asset, when the concept describes a real thing."),
      tags: z.array(z.string()).optional().describe("Short cross-cutting labels."),
      status: statusSchema.optional(),
      sources: z
        .array(sourceSchema)
        .optional()
        .describe("What this concept was derived from. Required for agent-authored concepts (§5.1)."),
      usageWindow: usageWindowSchema.optional().describe("Date range framing every source's usage_count."),
      staleAfter: staleAfterSchema,
      body: z
        .string()
        .optional()
        .describe(
          "Markdown body. Prefer structure (headings, lists, tables, code fences) over prose. " +
            "Link to other concepts with markdown links like [orders](/tables/orders.md). " +
            "Cite a source with a [^source-id] footnote.",
        ),
      extra: extraSchema,
    }),
    execute: (args) => store.create(args),
  });

  const patch = defineTool({
    name: "okf_patch",
    kind: "write",
    description:
      "Change an existing concept. Fails if it does not exist (use okf_create for new ones). " +
      "Frontmatter fields you omit are left untouched and unknown fields are preserved; the body " +
      "is edited one section at a time by heading. To retire a concept use okf_deprecate, and to " +
      "rename or relocate it use okf_move — neither is expressible here.",
    schema: z.object({
      id: z.string().min(1).describe("Concept id to patch."),
      frontmatter: z
        .object({
          title: z.string().optional(),
          description: z.string().optional(),
          resource: z.string().optional(),
          tags: z.array(z.string()).optional().describe("Replaces the existing tag list wholesale."),
          status: statusSchema.optional(),
          sources: z.array(sourceSchema).optional().describe("Replaces the existing source list wholesale."),
          usageWindow: usageWindowSchema.optional(),
          staleAfter: staleAfterSchema,
          extra: extraSchema,
        })
        .optional()
        .describe("Frontmatter fields to set. Omit the whole object to change only the body."),
      body: bodyEditSchema.optional().describe("One section-level edit to the markdown body."),
    }),
    execute: ({ id, frontmatter, body }) =>
      store.patch({
        id,
        ...(frontmatter ?? {}),
        ...(body ? { bodyOps: [toBodyOp(body)] } : {}),
      }),
  });

  const move = defineTool({
    name: "okf_move",
    kind: "write",
    description:
      "Rename or relocate a concept. A concept's id IS its path, so this rewrites every markdown " +
      "link pointing at it across the whole bundle — it is the only safe way to change an id. " +
      "Groups left empty are cleaned up.",
    schema: z.object({
      from: z.string().min(1).describe("Current concept id."),
      to: z.string().min(1).describe("New concept id. Must not already exist."),
      updateLinks: z
        .boolean()
        .default(true)
        .describe("Rewrite inbound links. Leave true unless you intend to break them."),
    }),
    execute: ({ from, to, updateLinks }) => store.move(from, to, { updateLinks }),
  });

  const deprecate = defineTool({
    name: "okf_deprecate",
    kind: "write",
    description:
      "Retire a concept that is no longer current. There is no delete: the document stays so " +
      "existing links keep resolving and the history of what was believed survives (§5.4). Marks " +
      "it deprecated and records why in the body.",
    schema: z.object({
      id: z.string().min(1).describe("Concept id to deprecate."),
      reason: z.string().optional().describe("Why it is no longer current."),
      supersededBy: z
        .string()
        .optional()
        .describe("Concept id that replaces it, if there is one — linked from the deprecation note."),
    }),
    execute: ({ id, reason, supersededBy }) => store.deprecate(id, { reason, supersededBy }),
  });

  return {
    list,
    read,
    search,
    create,
    patch,
    move,
    deprecate,
    all: [list, read, search, create, patch, move, deprecate] as AgentTool[],
    store,
  };
}

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

/**
 * The bundle when the caller names no root.
 *
 * Anchored to this module rather than the process cwd, for the reason
 * ../agents/okfManager.ts is: a bare "../../okf" resolves against wherever the
 * server was launched from, so the store's location silently depended on the
 * launch directory.
 */
export const DEFAULT_OKF_ROOT = join(import.meta.dir, "../../okf");

/**
 * The actor when the caller names none.
 *
 * It must not begin with `human:`. That prefix is what the store reads to
 * decide a concept was written by a person — it waives the provenance
 * requirement on create, and a `human:` verifier is the whole of the top trust
 * tier (§5.3). A default that claimed it would forge both.
 */
export const DEFAULT_OKF_ACTOR = "okfToolGroup";

/**
 * An OKF object's frontmatter, by hand.
 *
 * No `describeTable` here: the bundle is files, so there is no table to read
 * this off. The trade is that these notes and the store are two things that can
 * drift, which is why the fields the store OWNS say so in their note rather
 * than being quietly omitted — a model that cannot see `generated` at all will
 * try to write one.
 */
const SPINE: FieldDoc[] = [
  {
    name: "id",
    type: "text",
    required: true,
    note:
      "The path within the bundle with the .md removed: 'finance/metrics/revenue' is the file " +
      "finance/metrics/revenue.md. Slashes are groups, and they are created for you. It is not a " +
      "frontmatter field — the id IS the address, which is why changing one is a move rather than " +
      "an edit. Elsewhere in this service the same object is cited as " +
      "'okf:finance/metrics/revenue'. 'index' and 'log' are reserved.",
  },
  {
    name: "type",
    type: "text",
    required: true,
    note:
      "What kind of thing this is, in a word or two: 'Metric', 'Playbook', 'Memory', 'BigQuery Table', " +
      "'Attested Computation'. Free text, so reuse a type the bundle already uses when one fits — types " +
      "nobody repeats are how a taxonomy stops being one.",
  },
  {
    name: "title",
    type: "text",
    required: false,
    default: "derived from the id",
    note: "The display name, and what listings and inbound links show.",
  },
  {
    name: "description",
    type: "text",
    required: false,
    note: "One sentence, shown in listings and in search results. It is often all another agent reads.",
  },
  {
    name: "tags",
    type: "string[]",
    required: false,
    note:
      "Short cross-cutting labels, for the groupings the directory tree cannot express. A patch replaces " +
      "the whole list rather than adding to it.",
  },
  {
    name: "status",
    type: "one of: draft | stable | deprecated",
    required: false,
    default: "stable",
    note:
      "Absent means stable (§5.4), so a concept that never declared a status still matches a search for " +
      "stable ones. Reaching 'deprecated' is deprecation's job, not a patch's.",
  },
  {
    name: "resource",
    type: "text",
    required: false,
    note:
      "Canonical URI of the underlying asset, when the concept describes a real thing that lives " +
      "elsewhere — a table, a dashboard, a document.",
  },
  {
    name: "sources",
    type: "list of { resource, id?, title?, author?, usage_count?, last_modified? }",
    required: true,
    note:
      "What the content was derived from (§5.1). Required of every agent-authored concept, and create " +
      "refuses without it: a claim with no provenance cannot be checked by the person who has to act on " +
      "it. Give each source an `id` and the body can cite it with a [^id] footnote. Replaced whole by a " +
      "patch.",
  },
  {
    name: "usage_window",
    type: "{ from: YYYY-MM-DD, to: YYYY-MM-DD }",
    required: false,
    note:
      "The date range every source's `usage_count` was counted over. A count with no window behind it is " +
      "a number nobody can interpret.",
  },
  {
    name: "stale_after",
    type: "YYYY-MM-DD",
    required: false,
    default: "90 days after it was written",
    note:
      "The date this should be re-checked (§5.5) — an absolute date, not a duration, so it means the same " +
      "thing whenever it is read. Pass null on create for a fact that does not expire.",
  },
  {
    name: "generated.by",
    type: "text",
    required: true,
    note:
      "Who produced the CURRENT content. Stamped from the actor bound when these tools were built and not " +
      "accepted as an argument anywhere — an agent that could name its own actor could claim to be a " +
      "person. Every write re-stamps it, including a one-word patch.",
  },
  {
    name: "generated.at",
    type: "ISO 8601 timestamp",
    required: true,
    note: "When the current content was produced. Stamped from the clock, never supplied.",
  },
  {
    name: "verified",
    type: "list of { by, at }",
    required: false,
    note:
      "Who has since confirmed this is true, and when. No tool here writes it — see the trust rule below. " +
      "A bare mapping rather than a list is read as one event.",
  },
  {
    name: "body",
    type: "markdown",
    required: false,
    note:
      "The knowledge itself, under the frontmatter. Prefer structure — headings, lists, tables, code " +
      "fences — over paragraphs, because the next reader is usually a model scanning for one fact. Link " +
      "to another concept with an ordinary markdown link ([orders](/tables/orders.md)); those links are " +
      "the bundle's graph, and okf_read hands them back with a flag for whether each target exists. " +
      "It is edited one section at a time, by heading.",
  },
];

const DERIVED: DerivedField[] = [
  {
    name: "trust",
    type: "one of: unverified | machine-confirmed | human-reviewed",
    note:
      "Read off `verified` on every read, never stored: no verification is 'unverified', a verifier whose " +
      "name starts with 'human:' is 'human-reviewed', anything else is 'machine-confirmed'. Search filters " +
      "on it with minTrust.",
  },
  {
    name: "verifiedAt",
    type: "ISO 8601 timestamp",
    note: "The most recent verification, when there has been one. Absent is not a failure; it is the norm.",
  },
  {
    name: "stale",
    type: "boolean",
    note:
      "Whether today has reached `stale_after`. A date comparison made at read time, so a concept goes " +
      "stale on its own without anything running.",
  },
  {
    name: "links",
    type: "list of { text, target, kind, id?, exists? }",
    note:
      "The body's outbound links, resolved, from okf_read. `exists: false` is a link to a concept nobody " +
      "has written yet — either write it or stop pointing at it.",
  },
];

const PURPOSE = `
One OKF object is one markdown file holding one unit of knowledge: YAML
frontmatter saying what it is and where it came from, and a markdown body saying
the thing itself. Its id is its path inside the bundle, so the directory tree is
the taxonomy and a relationship between two concepts is an ordinary markdown
link between two files.

The bundle is durable memory — what you have been told, what you have worked
out, and what you have been asked to remember — kept in a form a person can read
and edit in a text editor with none of this service running. That is the whole
point of it being files, and it is what these tools are protecting: write for
the person who will open the file in six months without you there to explain it.
It is not a scratchpad. A concept is worth creating when it will still be true
and still be wanted next month; anything shorter-lived belongs somewhere else.
`;

const GUIDANCE = `
Trust is derived, never asserted. A concept's tier is read off its \`verified\`
list on every read: nothing is 'unverified', a verifier named 'human:...' is
'human-reviewed', anyone else is 'machine-confirmed'. No tool here writes
\`verified\`, and none takes an actor — \`generated.by\` comes from the actor bound
when these tools were built. That is deliberate and it is about you: an agent
that could name its own actor could sign its own output as a person and mint the
top tier for a guess (§5.3). So treat trust as something you read before relying
on a concept, not something you can raise. If you need a fact confirmed, say so
in the body and leave the tier where it is.

Three statuses, and no delete (§5.4). A concept is 'draft' while it is still
being worked out, 'stable' once it is meant to be relied on — which is the
default, so an absent status means stable — and 'deprecated' once it is no
longer current. Deprecating is how a concept is retired: the file stays, so
every inbound link keeps resolving and the record of what was once believed
survives. Deprecate rather than remove, with a reason, and name the concept that
replaces it when there is one. To rename or relocate one, move it: the id
is the path, so a move is the only operation that rewrites the inbound links
instead of breaking them.

Staleness is a date, not a judgement (§5.5). \`stale_after\` is an absolute date
and a concept is stale once today reaches it; create stamps one ninety days out
unless you pass your own, or null for something that will not expire. Patching
re-stamps \`generated\` but leaves \`stale_after\` alone, so if you have actually
re-checked a fact, set a new date to say so — otherwise you have changed the
content without moving the horizon. okf_search with staleOnly is the list of
what is due for a look.

Search before you create. Two concepts saying nearly the same thing is the one
failure this bundle cannot recover from on its own: neither is wrong, so nobody
deletes either, and every later reader has to work out which is current. If
something close already exists, patch it.
`;

/**
 * The OKF group.
 *
 * Every tool, always. An agent whose context holds text a stranger wrote gets
 * this group through `readOnly`, which is the one place that filtering happens
 * — and it matters here more than most: okf_create in a loop that has just read
 * an email is a stranger writing directly into the memory the agent will trust
 * tomorrow.
 */
export function okfGroup(context: ToolGroupContext): ToolGroup {
  const tools = createOkfTools({
    root: context.okf?.root ?? DEFAULT_OKF_ROOT,
    actor: context.okf?.actor ?? DEFAULT_OKF_ACTOR,
  });
  return defineToolGroup({
    name: "okf",
    // Spelled out, because the default would raise one letter of an acronym.
    title: "OKF",
    summary:
      "The knowledge bundle on disk — durable, human-readable memory: what you have been told, what you " +
      "have worked out, and what you have been asked to remember.",
    purpose: PURPOSE,
    guidance: GUIDANCE,
    shape: {
      singular: "concept",
      spine: SPINE,
      derived: DERIVED,
    },
    tools: tools.all,
  });
}
