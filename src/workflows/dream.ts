import { randomUUID } from "node:crypto";
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
const sourceSchema = z.object({ semanticHash: z.string(), id: z.string(), sha256: z.string(), title: z.string(), body: z.string(),
  entityId: z.string().nullable(), sources: z.array(z.unknown()) });
export const dreamPlanSchema = z.object({
  preparedAt: z.number(), evidenceKey: z.string(), organizationKey: z.string(),
  preview: z.array(z.object({ path: z.string(), before: z.string().nullable(), after: z.string().nullable() })).default([]),
  version: z.literal(1), root: z.string(), canonicalId: z.string(), canonicalHash: z.string().nullable(),
  entityId: z.string(), title: z.string(), sources: z.array(sourceSchema).min(2).max(6),
  coverage: z.enum(["ready", "unavailable", "explicit-selection"]),
  embeddingConfig: z.string().optional(), identity: z.enum(["supported", "needs-confirmation"]),
  duplicateIds: z.array(z.string()),
});
export type DreamPlan = z.infer<typeof dreamPlanSchema>;
const canonicalMarker = "solenoid-overview-v1";
const evidenceBody = (body: string) => body.replace(/\n\n<!-- solenoid-overview-link -->\n[\s\S]*?<!-- \/solenoid-overview-link -->\n?/g, "").trim();

/** No model or network call here. A neighbor is a candidate, not an assertion.
 * The first workflow creates an attributed source overview and keeps all detail.
 */
export class DreamWorkflow {
  constructor(readonly runtime: HistoryRuntime, readonly neighbors: DreamNeighbors = runtime.neighbors) {}
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
    if (canonical && (parseConcept(canonicalId, canonical).frontmatter.overview_kind !== canonicalMarker || parseConcept(canonicalId, canonical).frontmatter.overview_body_sha !== hash(parseConcept(canonicalId, canonical).body))) throw new HistoryConflict("Existing overview is user-maintained; choose a new path rather than overwrite it");
    const sources = ids.map(id => {
      const text = files.get(`${id}.md`); if (!text) throw new HistoryConflict(`Source is unavailable: ${id}`);
      const c = parseConcept(id, text);
      if (c.frontmatter.status === "deprecated" || c.frontmatter.overview_kind) throw new HistoryConflict("Derived or deprecated memories cannot be new source evidence");
      return { semanticHash: hash(JSON.stringify([c.frontmatter.title, c.frontmatter.description, c.frontmatter.sources, evidenceBody(c.body)])), id, sha256: hash(text), title: typeof c.frontmatter.title === "string" ? c.frontmatter.title : id,
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
    const organizationKey = hash(JSON.stringify([canonicalId, input.entityId, input.title, sources.map(s => [s.id, s.semanticHash]), duplicateIds]));
    if (canonical && parseConcept(canonicalId, canonical).frontmatter.organization_key === organizationKey) throw new HistoryConflict("Overview already reflects this source evidence");
    const evidenceKey = hash(JSON.stringify([organizationKey, sources.map(s => s.sha256), canonical ? hash(canonical) : null]));
    const pending = this.runtime.history.db.$client.query("SELECT id,digest,cipher FROM write_plans WHERE kind='dream' AND state IN ('proposed','rejected') AND expires_at>? ORDER BY created_at DESC LIMIT 100").all(this.runtime.history.now()) as { id: string; digest: string; cipher: string }[];
    for (const old of pending) {
      const value = this.runtime.history.decrypt<DreamPlan>(old.cipher);
      if (value.evidenceKey === evidenceKey) return { id: old.id, digest: old.digest, value };
    }
    const value = dreamPlanSchema.parse({ preparedAt: this.runtime.history.now(), evidenceKey, organizationKey, version: 1, root: this.runtime.root, canonicalId,
      canonicalHash: canonical ? hash(canonical) : null, entityId: input.entityId, title: input.title,
      sources, coverage, embeddingConfig, identity: sources.every(s => s.entityId === input.entityId) ? "supported" : "needs-confirmation", duplicateIds });
    value.preview = (await this.runtime.files.preview(value.root, root => this.materialize(value, root)))
      .filter(c => !["index.md", "log.md"].includes(c.path.split("/").at(-1)!));
    return this.runtime.history.plan("dream", value);
  }
  overview(plan: DreamPlan) {
    // Source titles are escaped for Markdown. No genre/preference inference is
    // made from co-occurrence; original prose stays one link away.
    const label = (text: string) => text.replace(/[\[\]<>\r\n]/g, " ");
    return `# ${label(plan.title)}\n\nThis overview groups source accounts about the reviewed entity. It does not resolve disagreements or verify their factual accuracy.\n\n## Source accounts\n\n` +
      plan.sources.map(s => `### ${label(s.title)}\n\n[Original account](/${s.id}.md)${evidenceBody(s.body).length > 900 ? " — excerpt, full detail retained at source" : ""}\n\n${evidenceBody(s.body).slice(0, 900).split("\n").map(line => `> ${line}`).join("\n")}`).join("\n\n") +
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
        await this.materialize(plan, root);
        for (const change of plan.preview) {
          const file = Bun.file(join(root, change.path));
          const text = await file.exists() ? await file.text() : null;
          if (text !== change.after) throw new HistoryConflict("Materialized change differs from the reviewed diff");
        }
      }));
      this.runtime.history.markPlan(planId, "applied");
      this.runtime.history.response(call.id, "delivered");
      return { operationId: call.id };
    } catch (e) { this.runtime.history.markPlan(planId, "failed"); throw e; }
  }
  private async materialize(plan: DreamPlan, root: string) {
    const store = new OkfStore({ root, actor: "dream-workflow", now: () => new Date(plan.preparedAt) }, true);
    const sources = plan.sources.map(s => ({ resource: `/${s.id}.md`, id: s.sha256, title: s.title }));
    const extra = { overview_kind: canonicalMarker, entity_id: plan.entityId, overview_body_sha: hash(this.overview(plan).trim() + "\n"), organization_key: plan.organizationKey,
      derivation: { kind: "source-index", source_versions: plan.sources.map(s => ({ id: s.id, sha256: s.sha256 })), proposal: plan.evidenceKey } };
    if (plan.canonicalHash === null) await store.create({ id: plan.canonicalId, type: "Memory", title: plan.title, sources, body: this.overview(plan), extra });
    else await store.patch({ id: plan.canonicalId, title: plan.title, sources, bodyOps: [{ op: "replaceAll", content: this.overview(plan) }], extra });
    for (const source of plan.sources) {
      const c = await store.read(source.id);
      const link = `[${plan.title.replace(/[\[\]<>\r\n]/g, " ")}](/${plan.canonicalId}.md)`;
      const body = c.body ?? "";
      if (!body.includes(`](/${plan.canonicalId}.md)`)) await store.patch({ id: source.id,
        bodyOps: [{ op: "replaceAll", content: `${body.trim()}\n\n<!-- solenoid-overview-link -->\n## Overview\n\n${link}\n<!-- /solenoid-overview-link -->\n` }], extra: { entity_id: plan.entityId } });
    }
    for (const id of plan.duplicateIds) {
      const original = plan.sources.find(s => s.id === id)!;
      const keeper = plan.sources.find(s => !plan.duplicateIds.includes(s.id) && s.body === original.body && JSON.stringify(s.sources) === JSON.stringify(original.sources))!;
      await store.deprecate(id, { reason: "Reviewed exact duplicate of the same source account; original text retained.", supersededBy: keeper.id });
    }
  }
  /** Bounded unattended pass: only already identified entities can be grouped.
   * Ambiguous candidates are exposed for manual selection, never auto-resolved.
   */
  async run(signal?: AbortSignal) {
    const db = this.runtime.history.db.$client, resource = `dream:${this.runtime.root}`, owner = randomUUID();
    db.transaction(() => {
      const prior = db.query("SELECT pid FROM write_resource_locks WHERE resource=?").get(resource) as { pid: number } | null;
      if (prior) {
        let alive = true; try { process.kill(prior.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
        if (alive) throw new HistoryConflict("A reflection pass is already running");
        db.query("DELETE FROM write_resource_locks WHERE resource=?").run(resource);
      }
      db.query("INSERT INTO write_resource_locks(resource,owner,pid,acquired_at) VALUES(?,?,?,?)").run(resource, owner, process.pid, this.runtime.history.now());
    }).immediate();
    try { return await this.pass(signal); }
    finally { db.query("DELETE FROM write_resource_locks WHERE resource=? AND owner=?").run(resource, owner); }
  }
  private async pass(signal?: AbortSignal) {
    const files = await snapshot(this.runtime.root);
    const all = [...files.keys()].filter(p => !["index.md", "log.md"].includes(p.split("/").at(-1)!) && !parseConcept(p.slice(0, -3), files.get(p)!).frontmatter.overview_kind).sort();
    const db = this.runtime.history.db.$client;
    const checkpoint = db.query("SELECT cursor,hashes FROM dream_checkpoints WHERE root=?").get(this.runtime.root) as { cursor: number; hashes: string } | null;
    const hashes: Record<string, string> = checkpoint ? JSON.parse(checkpoint.hashes) : {};
    const offset = (checkpoint?.cursor ?? 0) % Math.max(1, all.length);
    const rotated = [...all.slice(offset), ...all.slice(0, offset)];
    const changed = all.filter(p => hashes[p] !== hash(files.get(p)!)).slice(0, 12);
    const seeds = [...new Set([...changed, ...rotated.slice(0, 8)])].slice(0, 20);
    const queue = db.query("SELECT count(*) AS n FROM write_plans WHERE kind='dream' AND state='proposed' AND expires_at>?").get(this.runtime.history.now()) as { n: number };
    const quota = Math.max(0, Math.min(5, 10 - queue.n));
    const proposals: { id: string; digest: string }[] = [];
    let unavailable = 0, uncertain = 0;
    for (const path of seeds) {
      signal?.throwIfAborted();
      if (proposals.length >= quota) break;
      const id = path.slice(0, -3), source = parseConcept(id, files.get(path)!);
      if (source.frontmatter.overview_kind || source.frontmatter.status === "deprecated") continue;
      const result = await this.candidates(id);
      if (result.status !== "ready") { unavailable++; continue; }
      hashes[path] = hash(files.get(path)!);
      const entity = source.frontmatter.entity_id;
      if (typeof entity !== "string") { uncertain += result.candidates.length; continue; }
      const related = result.candidates.filter(c => {
        const text = files.get(`${c.id}.md`); if (!text) return false;
        const fm = parseConcept(c.id, text).frontmatter;
        return fm.entity_id === entity && !fm.overview_kind && fm.status !== "deprecated";
      }).slice(0, 5);
      if (!related.length) continue;
      const canonical = [...files].find(([path, text]) => !["index.md", "log.md"].includes(path.split("/").at(-1)!) && parseConcept(path.slice(0, -3), text).frontmatter.overview_kind === canonicalMarker && parseConcept(path.slice(0, -3), text).frontmatter.entity_id === entity);
      let proposal;
      try { proposal = await this.propose({ sourceIds: [id, ...related.map(c => c.id)], entityId: entity,
        canonicalId: canonical?.[0].slice(0, -3) ?? `people/entity-${hash(entity).slice(0, 16)}`, title: canonical ? String(parseConcept(canonical[0].slice(0, -3), canonical[1]).frontmatter.title) : entity }, "ready", result.configId);
      } catch (e) { if (e instanceof HistoryConflict) { uncertain++; continue; } throw e; }
      if (!proposals.some(p => p.id === proposal.id)) proposals.push({ id: proposal.id, digest: proposal.digest });
    }
    const liveHashes = Object.fromEntries(Object.entries(hashes).filter(([p]) => files.has(p)));
    db.query("INSERT INTO dream_checkpoints(root,cursor,hashes) VALUES(?,?,?) ON CONFLICT(root) DO UPDATE SET cursor=excluded.cursor,hashes=excluded.hashes")
      .run(this.runtime.root, (offset + 8) % Math.max(1, all.length), JSON.stringify(liveHashes));
    return { proposals, seeds: seeds.length, unavailable, uncertain, writesToMemories: 0 };
  }
}
