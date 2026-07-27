// The OKF store: every mutation the tool layer can perform, and the invariants
// it enforces on the way through.
//
// The division of labour that makes this trustworthy: the *model* supplies
// content, the *store* supplies identity and time. `generated.by` comes from
// the actor bound at construction, `generated.at` from the injected clock,
// `index.md`/`log.md` are side effects, and `verified` is not writable here at
// all — a generating agent that could stamp `verified: { by: human:... }` could
// forge the top trust tier (§5.3) on its own output.
import { rm, rmdir, readdir } from "node:fs/promises";
import pLimit from "p-limit";
import { join } from "node:path";
import {
  OkfError,
  INDEX_FILENAME,
  LOG_FILENAME,
  conceptPath,
  dirPath,
  normalizeConceptId,
  normalizeDirId,
  openBundle,
  parentDirId,
  titleFromId,
  writeFileAtomic,
  type Bundle,
} from "./bundle";
import { applyBodyOp, findSection, type BodyOp } from "./body";
import {
  mergeFrontmatter,
  parseConcept,
  serializeConcept,
  type Concept,
} from "./concept";
import { conceptLinks, rewriteLinks, type LinkKind } from "./links";
import { regenerateIndexChain } from "./indexFile";
import { appendLogEntry } from "./logFile";
import { countConcepts, hasConcepts, listDirectory, scanConcepts } from "./scan";
import {
  addDays,
  isStale,
  isoDate,
  isoDateTime,
  lastVerifiedAt,
  meetsTrust,
  statusOf,
  trustTier,
  type Status,
  type TrustTier,
} from "./trust";
import { validateBundle, type ValidationReport } from "./validate";

/**
 * Frontmatter keys the store owns. A caller reaching them through `extra`
 * would be routing around the guarantees above, so it is refused by name.
 */
const GUARDED_KEYS = new Set([
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "status",
  "sources",
  "usage_window",
  "stale_after",
  "generated",
  "verified",
  "okf_version",
]);

export interface SourceEntry {
  resource: string;
  id?: string;
  title?: string;
  author?: string;
  usage_count?: number;
  last_modified?: string;
}

export interface OkfStoreOptions {
  root: string;
  /** Actor recorded as `generated.by` (§7). Never model-supplied. */
  actor: string;
  now?: () => Date;
  /** Days added to `stale_after` on create when the caller gives none. `null` disables. */
  defaultStaleAfterDays?: number | null;
  /** Require provenance on create from non-human actors. */
  requireSources?: boolean;
}

export interface ConceptSummary {
  id: string;
  type: string;
  title: string;
  description?: string;
  status: Status;
  tags?: string[];
  trust: TrustTier;
  stale: boolean;
}

export interface ReadResult extends ConceptSummary {
  frontmatter: Record<string, unknown>;
  generatedBy?: string;
  generatedAt?: string;
  verifiedAt?: string;
  staleAfter?: string;
  body?: string;
  links?: { text: string; target: string; kind: LinkKind; id?: string; exists?: boolean }[];
}

export interface CreateInput {
  id: string;
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  status?: Status;
  sources?: SourceEntry[];
  usageWindow?: { from: string; to: string };
  /** `undefined` takes the default TTL; `null` writes no `stale_after` at all. */
  staleAfter?: string | null;
  body?: string;
  extra?: Record<string, unknown>;
}

export interface PatchInput {
  id: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  status?: Status;
  sources?: SourceEntry[];
  usageWindow?: { from: string; to: string };
  staleAfter?: string | null;
  bodyOps?: BodyOp[];
  extra?: Record<string, unknown>;
}

export interface SearchInput {
  query?: string;
  type?: string;
  tags?: string[];
  status?: Status;
  minTrust?: TrustTier;
  staleOnly?: boolean;
  limit?: number;
}

export class OkfStore {
  readonly bundle: Bundle;
  readonly actor: string;
  private readonly defaultStaleAfterDays: number | null;
  private readonly requireSources: boolean;
  // Index regeneration and log appends are read-modify-write over shared files,
  // and `fanout` runs agents concurrently. One writer at a time per store.
  private readonly gate = pLimit(1);

  constructor(opts: OkfStoreOptions) {
    this.bundle = openBundle(opts.root, { now: opts.now });
    this.actor = opts.actor;
    this.defaultStaleAfterDays =
      opts.defaultStaleAfterDays === undefined ? 90 : opts.defaultStaleAfterDays;
    this.requireSources = opts.requireSources ?? true;
  }

  // --- read ---------------------------------------------------------------

  async read(id: string, opts: { frontmatterOnly?: boolean } = {}): Promise<ReadResult> {
    const conceptId = normalizeConceptId(id);
    const concept = await this.load(conceptId);
    const result = this.summarize(concept.id, concept.frontmatter) as ReadResult;
    result.frontmatter = concept.frontmatter;

    const generated = concept.frontmatter.generated;
    if (generated && typeof generated === "object" && !Array.isArray(generated)) {
      const record = generated as Record<string, unknown>;
      if (typeof record.by === "string") result.generatedBy = record.by;
      if (typeof record.at === "string") result.generatedAt = record.at;
    }
    result.verifiedAt = lastVerifiedAt(concept.frontmatter);
    if (typeof concept.frontmatter.stale_after === "string") {
      result.staleAfter = concept.frontmatter.stale_after;
    }

    if (opts.frontmatterOnly) return result;

    result.body = concept.body;
    result.links = await Promise.all(
      conceptLinks(concept.id, concept.body).map(async (link) => ({
        text: link.text,
        target: link.target,
        kind: link.kind,
        ...(link.id ? { id: link.id, exists: await this.exists(link.id) } : {}),
      })),
    );
    return result;
  }

  async list(dirId = ""): Promise<{
    path: string;
    concepts: ConceptSummary[];
    groups: { path: string; concepts: number }[];
  }> {
    const normalized = normalizeDirId(dirId);
    const listing = await listDirectory(this.bundle, normalized);
    const groups = await Promise.all(
      listing.groups.map(async (group) => ({
        path: group,
        concepts: await countConcepts(this.bundle, group),
      })),
    );
    return {
      path: normalized,
      concepts: listing.concepts.map((entry) => this.summarize(entry.id, entry.frontmatter)),
      // A directory holding only reference material (§6.3) is not a group.
      groups: groups.filter((group) => group.concepts > 0),
    };
  }

  async search(input: SearchInput = {}): Promise<{
    matched: number;
    returned: number;
    results: (ConceptSummary & { snippet?: string })[];
  }> {
    const { concepts } = await scanConcepts(this.bundle);
    const query = input.query?.trim().toLowerCase();
    const wantedTags = input.tags?.map((t) => t.toLowerCase());
    const scored: { summary: ConceptSummary & { snippet?: string }; score: number }[] = [];

    for (const concept of concepts) {
      const { frontmatter, body, id } = concept;
      if (input.type && String(frontmatter.type ?? "").toLowerCase() !== input.type.toLowerCase()) {
        continue;
      }
      // Absent `status` means stable (§5.4), so `status: "stable"` must match a
      // concept that never declared one.
      if (input.status && statusOf(frontmatter) !== input.status) continue;
      if (input.minTrust && !meetsTrust(frontmatter, input.minTrust)) continue;
      if (input.staleOnly && !isStale(frontmatter, this.bundle.now())) continue;
      if (wantedTags?.length) {
        const tags = toStringArray(frontmatter.tags).map((t) => t.toLowerCase());
        // Any-of: a narrowing all-of filter turns a two-tag guess into zero results.
        if (!wantedTags.some((tag) => tags.includes(tag))) continue;
      }

      let score = 1;
      let snippet: string | undefined;
      if (query) {
        const title = String(frontmatter.title ?? "").toLowerCase();
        const description = String(frontmatter.description ?? "").toLowerCase();
        const bodyLower = body.toLowerCase();
        const inHead = title.includes(query) || description.includes(query) || id.toLowerCase().includes(query);
        const bodyIndex = bodyLower.indexOf(query);
        if (!inHead && bodyIndex === -1) continue;
        score = inHead ? 2 : 1;
        if (bodyIndex !== -1) snippet = makeSnippet(body, bodyIndex, query.length);
      }

      const summary = this.summarize(id, frontmatter) as ConceptSummary & { snippet?: string };
      if (snippet) summary.snippet = snippet;
      scored.push({ summary, score });
    }

    scored.sort((a, b) => b.score - a.score || a.summary.id.localeCompare(b.summary.id));
    const limit = input.limit ?? 20;
    return {
      matched: scored.length,
      returned: Math.min(limit, scored.length),
      results: scored.slice(0, limit).map((s) => s.summary),
    };
  }

  validate(): Promise<ValidationReport> {
    return validateBundle(this.bundle);
  }

  // --- write --------------------------------------------------------------

  create(input: CreateInput): Promise<ConceptSummary & { path: string }> {
    return this.gate(async () => {
      const id = normalizeConceptId(input.id);
      const path = conceptPath(this.bundle, id);
      if (await Bun.file(path).exists()) {
        throw new OkfError(
          `Concept "${id}" already exists — use okf_patch to change it, or pick another id`,
          "already_exists",
        );
      }
      const type = input.type?.trim();
      if (!type) throw new OkfError("`type` is required and must be non-empty (§4.1)", "missing_type");

      const sources = input.sources ?? [];
      if (this.requireSources && sources.length === 0 && !this.actor.startsWith("human:")) {
        throw new OkfError(
          "`sources` is required: an agent-generated concept must record what it was derived from (§5.1)",
          "missing_sources",
        );
      }

      const now = this.bundle.now();
      const frontmatter: Record<string, unknown> = {
        type,
        title: input.title,
        description: input.description,
        resource: input.resource,
        tags: input.tags?.length ? input.tags : undefined,
        status: input.status,
        generated: { by: this.actor, at: isoDateTime(now) },
        stale_after: this.resolveStaleAfter(input.staleAfter, now),
        sources: sources.length ? sources : undefined,
        usage_window: input.usageWindow,
        ...assertUnguarded(input.extra),
      };

      await writeFileAtomic(path, serializeConcept({ frontmatter, body: input.body ?? "" }));
      await regenerateIndexChain(this.bundle, parentDirId(id));
      await appendLogEntry(
        this.bundle,
        "Creation",
        `Established [${input.title ?? titleFromId(id)}](/${id}.md).`,
      );
      return { ...this.summarize(id, frontmatter), path };
    });
  }

  patch(input: PatchInput): Promise<ConceptSummary> {
    return this.gate(async () => {
      const id = normalizeConceptId(input.id);
      const concept = await this.load(id);

      const patch: Record<string, unknown> = {
        title: input.title,
        description: input.description,
        resource: input.resource,
        tags: input.tags,
        status: input.status,
        sources: input.sources,
        usage_window: input.usageWindow,
        ...assertUnguarded(input.extra),
      };
      if (input.staleAfter !== undefined) patch.stale_after = input.staleAfter;

      const touchesFrontmatter = Object.values(patch).some((v) => v !== undefined);
      const ops = input.bodyOps ?? [];
      if (!touchesFrontmatter && ops.length === 0) {
        throw new OkfError("Nothing to patch: supply frontmatter fields, body ops, or both", "empty_patch");
      }

      let body = concept.body;
      for (const op of ops) body = applyBodyOp(body, op);

      const frontmatter = mergeFrontmatter(concept.frontmatter, patch);
      // The content changed, so `generated` re-stamps: it records how the
      // *current* content was produced (§5.2). `verified` deliberately does
      // not move — content can change without re-confirmation.
      frontmatter.generated = { by: this.actor, at: isoDateTime(this.bundle.now()) };

      await writeFileAtomic(conceptPath(this.bundle, id), serializeConcept({ frontmatter, body }));
      await regenerateIndexChain(this.bundle, parentDirId(id));
      await appendLogEntry(this.bundle, "Update", `Updated [${displayTitle(id, frontmatter)}](/${id}.md).`);
      return this.summarize(id, frontmatter);
    });
  }

  move(
    from: string,
    to: string,
    opts: { updateLinks?: boolean } = {},
  ): Promise<{ from: string; to: string; rewrittenIn: string[] }> {
    return this.gate(async () => {
      const fromId = normalizeConceptId(from);
      const toId = normalizeConceptId(to);
      if (fromId === toId) throw new OkfError("Source and destination are the same concept", "noop_move");

      const concept = await this.load(fromId);
      const toPath = conceptPath(this.bundle, toId);
      if (await Bun.file(toPath).exists()) {
        throw new OkfError(`Concept "${toId}" already exists`, "already_exists");
      }

      const updateLinks = opts.updateLinks ?? true;
      const moves = new Map([[fromId, toId]]);
      const rewrittenIn: string[] = [];

      // The moved concept's own relative links are recomputed from its new
      // location even when their targets did not move.
      const movedBody = updateLinks
        ? rewriteLinks(concept.body, { sourceIdBefore: fromId, sourceIdAfter: toId, moves })
        : concept.body;

      await writeFileAtomic(toPath, serializeConcept({ ...concept, body: movedBody }));
      await rm(conceptPath(this.bundle, fromId), { force: true });

      if (updateLinks) {
        const { concepts } = await scanConcepts(this.bundle);
        for (const other of concepts) {
          if (other.id === toId) continue;
          const next = rewriteLinks(other.body, {
            sourceIdBefore: other.id,
            sourceIdAfter: other.id,
            moves,
          });
          if (next === other.body) continue;
          await writeFileAtomic(
            conceptPath(this.bundle, other.id),
            serializeConcept({ frontmatter: other.frontmatter, body: next }),
          );
          rewrittenIn.push(other.id);
        }
      }

      await this.pruneEmptyDirs(parentDirId(fromId));
      await regenerateIndexChain(this.bundle, parentDirId(fromId));
      await regenerateIndexChain(this.bundle, parentDirId(toId));
      await appendLogEntry(
        this.bundle,
        "Move",
        `Moved [${displayTitle(toId, concept.frontmatter)}](/${toId}.md) from \`${fromId}\`.`,
      );
      return { from: fromId, to: toId, rewrittenIn: rewrittenIn.sort() };
    });
  }

  /**
   * There is no delete. OKF keeps deprecated concepts "for links and history"
   * (§5.4), so the destructive operation a knowledge base needs is a status
   * change — inbound links keep resolving and the record of what was once
   * believed survives.
   */
  deprecate(
    id: string,
    opts: { reason?: string; supersededBy?: string } = {},
  ): Promise<ConceptSummary & { supersededByExists?: boolean }> {
    return this.gate(async () => {
      const conceptId = normalizeConceptId(id);
      const concept = await this.load(conceptId);

      let supersededByExists: boolean | undefined;
      let note = opts.reason?.trim() ?? "No longer current.";
      if (opts.supersededBy) {
        const target = normalizeConceptId(opts.supersededBy);
        supersededByExists = await this.exists(target);
        note += ` Superseded by [${target}](/${target}.md).`;
      }

      const frontmatter: Record<string, unknown> = {
        ...concept.frontmatter,
        status: "deprecated",
        generated: { by: this.actor, at: isoDateTime(this.bundle.now()) },
      };
      const body = applyBodyOp(concept.body, {
        op: findSection(concept.body, "Deprecation") ? "replace" : "add",
        section: "Deprecation",
        content: note,
      });

      await writeFileAtomic(
        conceptPath(this.bundle, conceptId),
        serializeConcept({ frontmatter, body }),
      );
      await regenerateIndexChain(this.bundle, parentDirId(conceptId));
      await appendLogEntry(
        this.bundle,
        "Deprecation",
        `Deprecated [${displayTitle(conceptId, frontmatter)}](/${conceptId}.md). ${note}`,
      );
      const summary = this.summarize(conceptId, frontmatter) as ConceptSummary & {
        supersededByExists?: boolean;
      };
      if (supersededByExists !== undefined) summary.supersededByExists = supersededByExists;
      return summary;
    });
  }

  // --- internals ----------------------------------------------------------

  private async load(id: string): Promise<Concept> {
    const path = conceptPath(this.bundle, id);
    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw new OkfError(`No concept "${id}" in this bundle`, "not_found");
    }
    return parseConcept(id, await file.text());
  }

  private async exists(id: string): Promise<boolean> {
    try {
      return await Bun.file(conceptPath(this.bundle, id)).exists();
    } catch {
      return false;
    }
  }

  private summarize(id: string, frontmatter: Record<string, unknown>): ConceptSummary {
    const tags = toStringArray(frontmatter.tags);
    const summary: ConceptSummary = {
      id,
      type: typeof frontmatter.type === "string" ? frontmatter.type : "",
      title: displayTitle(id, frontmatter),
      status: statusOf(frontmatter),
      trust: trustTier(frontmatter),
      stale: isStale(frontmatter, this.bundle.now()),
    };
    if (typeof frontmatter.description === "string") summary.description = frontmatter.description;
    if (tags.length) summary.tags = tags;
    return summary;
  }

  private resolveStaleAfter(given: string | null | undefined, now: Date): string | undefined {
    if (given === null) return undefined;
    if (typeof given === "string") return given;
    if (this.defaultStaleAfterDays === null) return undefined;
    return isoDate(addDays(now, this.defaultStaleAfterDays));
  }

  /**
   * Remove directories a move emptied. Conservative on purpose: a directory is
   * only removed when it holds nothing but its own `index.md`/`log.md`, so a
   * `references/` folder of attester code (§6.3) is never swept up.
   */
  private async pruneEmptyDirs(dirId: string): Promise<void> {
    let current = dirId;
    while (current !== "") {
      if (await hasConcepts(this.bundle, current)) return;
      const abs = dirPath(this.bundle, current);
      let entries: string[];
      try {
        entries = await readdir(abs);
      } catch {
        return;
      }
      if (!entries.every((name) => name === INDEX_FILENAME || name === LOG_FILENAME)) return;
      for (const name of entries) await rm(join(abs, name), { force: true });
      await rmdir(abs).catch(() => {});
      current = parentDirId(current);
    }
  }
}

function displayTitle(id: string, frontmatter: Record<string, unknown>): string {
  return typeof frontmatter.title === "string" && frontmatter.title.trim() !== ""
    ? frontmatter.title
    : titleFromId(id);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function assertUnguarded(extra: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!extra) return {};
  const guarded = Object.keys(extra).filter((key) => GUARDED_KEYS.has(key));
  if (guarded.length > 0) {
    throw new OkfError(
      `These fields cannot be set through \`extra\`: ${guarded.join(", ")}. ` +
        "`verified` in particular is never writable by a generating agent — verification is recorded " +
        "by a separate reviewer (§5.2).",
      "guarded_field",
    );
  }
  return extra;
}

function makeSnippet(body: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(body.length, index + length + 60);
  const slice = body.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < body.length ? "…" : ""}`;
}
