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
import { z } from "zod";
import { defineTool, type AgentTool } from "../core/tools";
import { OkfStore, type OkfStoreOptions } from "../okf/store";
import type { BodyOp } from "../okf/body";

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
  /** Read-only subset — safe for agents whose context contains untrusted text. */
  read_only: AgentTool[];
  /** Everything, for a librarian agent. */
  all: AgentTool[];
  store: OkfStore;
}

export function createOkfTools(opts: OkfStoreOptions): OkfTools {
  const store = new OkfStore(opts);

  const list = defineTool({
    name: "okf_list",
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
      limit: z.number().int().positive().max(100).default(20),
    }),
    execute: (args) => store.search(args),
  });

  const create = defineTool({
    name: "okf_create",
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

  const read_only = [list, read, search] as AgentTool[];
  return {
    list,
    read,
    search,
    create,
    patch,
    move,
    deprecate,
    read_only,
    all: [...read_only, create, patch, move, deprecate] as AgentTool[],
    store,
  };
}
