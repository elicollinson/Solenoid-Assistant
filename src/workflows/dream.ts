import { join } from "node:path";
import { z } from "zod";
import { parseConcept } from "../okf/concept";
import { normalizeConceptId } from "../okf/bundle";
import { OkfStore } from "../okf/store";
import { currentWriteCall, newWriteCall, withWriteCall } from "../core/writeExecution";
import { hash, HistoryConflict } from "../writeHistory/history";
import { snapshot } from "../writeHistory/files";
import type { HistoryRuntime } from "../writeHistory/runtime";

export interface NeighborResult {
  status: "ready" | "unavailable";
  candidates: { id: string; sourceSha256: string; score: number }[];
  configId?: string;
}
export type DreamNeighbors = (id: string, hash: string, limit: number) => Promise<NeighborResult>;
const sourceSchema = z.object({ id: z.string(), sha256: z.string(), title: z.string(), body: z.string(),
  entityId: z.string().nullable(), sources: z.array(z.unknown()) });
export const dreamPlanSchema = z.object({
  version: z.literal(1), root: z.string(), canonicalId: z.string(), canonicalHash: z.string().nullable(),
  entityId: z.string(), title: z.string(), sources: z.array(sourceSchema).min(2).max(6),
  coverage: z.enum(["ready", "unavailable", "explicit-selection"]),
  embeddingConfig: z.string().optional(), identity: z.enum(["supported", "needs-confirmation"]),
  duplicateIds: z.array(z.string()),
});
export type DreamPlan = z.infer<typeof dreamPlanSchema>;
const canonicalMarker = "solenoid-overview-v1";

/** No model or network call here. A neighbor is a candidate, not an assertion.
 * The first workflow creates an attributed source overview and keeps all detail.
 */
export class DreamWorkflow {
  constructor(readonly runtime: HistoryRuntime, readonly neighbors: DreamNeighbors = async () => ({ status: "unavailable", candidates: [] })) {}
  async candidates(seed: string) {
    const id = normalizeConceptId(seed), files = await snapshot(this.runtime.root);
    const text = files.get(`${id}.md`); if (!text) throw new HistoryConflict("Seed memory is missing");
    const result = await this.neighbors(id, hash(text), 12);
    const valid = result.candidates.filter(c => c.id !== id && files.has(`${c.id}.md`) && hash(files.get(`${c.id}.md`)!) === c.sourceSha256);
    return { ...result, candidates: valid };
  }
  async propose(input: { sourceIds: string[]; canonicalId: string; entityId: string; title: string; deprecateDuplicates?: boolean },
    coverage: DreamPlan["coverage"] = "explicit-selection", embeddingConfig?: string) {
    const canonicalId = normalizeConceptId(input.canonicalId);
    const ids = [...new Set(input.sourceIds.map(normalizeConceptId))].sort();
    if (ids.length < 2 || ids.length > 6 || ids.includes(canonicalId)) throw new HistoryConflict("Choose two to six distinct source memories and a separate overview");
    if (!input.entityId.trim() || !input.title.trim() || input.title.length > 120) throw new HistoryConflict("An entity key and short overview title are required");
    const files = await snapshot(this.runtime.root);
    const canonical = files.get(`${canonicalId}.md`);
    if (canonical && parseConcept(canonicalId, canonical).frontmatter.overview_kind !== canonicalMarker) throw new HistoryConflict("Existing overview is user-maintained; choose a new path rather than overwrite it");
    const sources = ids.map(id => {
      const text = files.get(`${id}.md`); if (!text) throw new HistoryConflict(`Source is unavailable: ${id}`);
      const c = parseConcept(id, text);
      if (c.frontmatter.status === "deprecated" || c.frontmatter.overview_kind) throw new HistoryConflict("Derived or deprecated memories cannot be new source evidence");
      return { id, sha256: hash(text), title: typeof c.frontmatter.title === "string" ? c.frontmatter.title : id,
        body: c.body, entityId: typeof c.frontmatter.entity_id === "string" ? c.frontmatter.entity_id : null,
        sources: Array.isArray(c.frontmatter.sources) ? c.frontmatter.sources : [] };
    });
    if (sources.some(s => s.entityId && s.entityId !== input.entityId)) throw new HistoryConflict("A source is assigned to a different entity; resolve identity separately first");
    // Deduplicate only exactly equal body AND source attestations. No semantic
    // similarity threshold can authorize losing a distinct observation.
    const seen = new Map<string, string>(), duplicateIds: string[] = [];
    for (const source of sources) {
      const signature = hash(JSON.stringify([source.body, source.sources]));
      if (input.deprecateDuplicates && source.sources.length && seen.has(signature)) duplicateIds.push(source.id);
      else seen.set(signature, source.id);
    }
    const value = dreamPlanSchema.parse({ version: 1, root: this.runtime.root, canonicalId,
      canonicalHash: canonical ? hash(canonical) : null, entityId: input.entityId, title: input.title,
      sources, coverage, embeddingConfig, identity: sources.every(s => s.entityId === input.entityId) ? "supported" : "needs-confirmation", duplicateIds });
    const digest = hash(JSON.stringify(value));
    const existing = this.runtime.history.db.$client.query("SELECT id,digest FROM write_plans WHERE kind='dream' AND digest=? AND state IN ('proposed','rejected') AND expires_at>? LIMIT 1")
      .get(digest, this.runtime.history.now()) as { id: string; digest: string } | null;
    if (existing) return { ...existing, value };
    return this.runtime.history.plan("dream", value);
  }
  overview(plan: DreamPlan) {
    // Source titles are escaped for Markdown. No genre/preference inference is
    // made from co-occurrence; original prose stays one link away.
    const label = (text: string) => text.replace(/[\[\]<>\r\n]/g, " ");
    return `# ${label(plan.title)}\n\nThis overview groups source accounts about the reviewed entity. It does not resolve disagreements or verify their factual accuracy.\n\n## Source accounts\n\n` +
      plan.sources.map(s => `- [${label(s.title)}](/${s.id}.md) — retained original account.`).join("\n") +
      "\n\n## Evidence and uncertainty\n\nPreferences, dates, qualifiers and personal details remain in the original accounts. Conflicting accounts are retained separately.\n";
  }
  async apply(planId: string, digest: string, confirmIdentity: boolean) {
    const stored = this.runtime.history.readPlan<unknown>(planId);
    if (stored.kind !== "dream" || stored.digest !== digest) throw new HistoryConflict("Wrong dream review plan");
    const plan = dreamPlanSchema.parse(stored.value);
    if (plan.root !== this.runtime.root) throw new HistoryConflict("Proposal belongs to a different knowledge bundle");
    if (!confirmIdentity) throw new HistoryConflict("Review and confirm that all selected accounts concern the same entity");
    if (stored.state === "applied") return { operationId: stored.appliedOperationId };
    const call = newWriteCall({ parentId: currentWriteCall()?.id, actor: "user", origin: "dream-review", idempotencyKey: `dream:${planId}` });
    this.runtime.history.db.$client.transaction(() => {
      this.runtime.history.claimPlan(planId, digest, call.id);
      this.runtime.history.begin(call, "okf_dream_apply");
    }).immediate();
    try {
      await withWriteCall(call, () => this.runtime.files.mutate(plan.root, "dream-workflow", "okf_dream_apply", async root => {
        for (const source of plan.sources) {
          const f = Bun.file(join(root, `${source.id}.md`));
          if (!(await f.exists()) || hash(await f.text()) !== source.sha256) throw new HistoryConflict("Source changed since review; prepare a new proposal");
        }
        const f = Bun.file(join(root, `${plan.canonicalId}.md`));
        const currentHash = await f.exists() ? hash(await f.text()) : null;
        if (currentHash !== plan.canonicalHash) throw new HistoryConflict("Overview changed since review");
        const store = new OkfStore({ root, actor: "dream-workflow" }, true);
        const sources = plan.sources.map(s => ({ resource: `/${s.id}.md`, id: s.sha256, title: s.title }));
        const extra = { overview_kind: canonicalMarker, entity_id: plan.entityId,
          derivation: { kind: "source-index", source_versions: plan.sources.map(s => ({ id: s.id, sha256: s.sha256 })), proposal: planId } };
        if (plan.canonicalHash === null) await store.create({ id: plan.canonicalId, type: "Memory", title: plan.title, sources, body: this.overview(plan), extra });
        else await store.patch({ id: plan.canonicalId, title: plan.title, sources, bodyOps: [{ op: "replaceAll", content: this.overview(plan) }], extra });
        for (const source of plan.sources) {
          const c = await store.read(source.id);
          const link = `[${plan.title.replace(/[\[\]<>\r\n]/g, " ")}](/${plan.canonicalId}.md)`;
          const body = c.body ?? "";
          if (!body.includes(`](/${plan.canonicalId}.md)`)) await store.patch({ id: source.id,
            bodyOps: [{ op: "replaceAll", content: `${body.trim()}\n\n## Overview\n\n${link}\n` }], extra: { entity_id: plan.entityId } });
        }
        for (const id of plan.duplicateIds) {
          const original = plan.sources.find(s => s.id === id)!;
          const keeper = plan.sources.find(s => !plan.duplicateIds.includes(s.id) && s.body === original.body && JSON.stringify(s.sources) === JSON.stringify(original.sources))!;
          await store.deprecate(id, { reason: "Reviewed exact duplicate of the same source account; original text retained.", supersededBy: keeper.id });
        }
      }));
      this.runtime.history.markPlan(planId, "applied");
      this.runtime.history.response(call.id, "delivered");
      return { operationId: call.id };
    } catch (e) { this.runtime.history.markPlan(planId, "failed"); throw e; }
  }
  /** Bounded unattended pass: only already identified entities can be grouped.
   * Ambiguous candidates are exposed for manual selection, never auto-resolved.
   */
  async run() {
    const files = await snapshot(this.runtime.root);
    const seeds = [...files.keys()].filter(p => !["index.md", "log.md"].includes(p.split("/").at(-1)!)).sort().slice(0, 20);
    const proposals: { id: string; digest: string }[] = [];
    let unavailable = 0, uncertain = 0;
    for (const path of seeds) {
      if (proposals.length >= 5) break;
      const id = path.slice(0, -3), source = parseConcept(id, files.get(path)!);
      if (source.frontmatter.overview_kind || source.frontmatter.status === "deprecated") continue;
      const result = await this.candidates(id);
      if (result.status !== "ready") { unavailable++; continue; }
      const entity = source.frontmatter.entity_id;
      if (typeof entity !== "string") { uncertain += result.candidates.length; continue; }
      const related = result.candidates.filter(c => parseConcept(c.id, files.get(`${c.id}.md`)!).frontmatter.entity_id === entity).slice(0, 5);
      if (!related.length) continue;
      const proposal = await this.propose({ sourceIds: [id, ...related.map(c => c.id)], entityId: entity,
        canonicalId: `people/entity-${hash(entity).slice(0, 16)}`, title: String(source.frontmatter.title ?? entity) }, "ready", result.configId);
      if (!proposals.some(p => p.id === proposal.id)) proposals.push({ id: proposal.id, digest: proposal.digest });
    }
    return { proposals, seeds: seeds.length, unavailable, uncertain, writesToMemories: 0 };
  }
}
