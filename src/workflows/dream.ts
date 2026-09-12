import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { currentConsent } from "../core/consent";
import { defineTool } from "../core/tools";
import { parseConcept } from "../okf/concept";
import { normalizeConceptId } from "../okf/bundle";
import { OkfStore } from "../okf/store";
import { hash, HistoryConflict } from "../writeHistory/history";
import { snapshot } from "../writeHistory/files";
import type { HistoryRuntime } from "../writeHistory/runtime";
import { synthesisSchema, synthesizeDream, validateSynthesis, type DreamSynthesizer } from "./dreamSynthesis";

export interface NeighborResult { status: "ready" | "unavailable"; candidates: { id: string; sourceSha256: string; score: number }[]; configId?: string }
export type DreamNeighbors = (id: string, hash: string, limit: number) => Promise<NeighborResult>;
const marker = "solenoid-synthesis-v1";
const evidenceBody = (body: string) => body.replace(/\n\n<!-- solenoid-overview-link -->\n[\s\S]*?<!-- \/solenoid-overview-link -->\n?/g, "").trim();
const sourceSchema = z.object({ id: z.string(), sha256: z.string(), title: z.string(), body: z.string() });
const updateSchema = z.object({ preparedAt: z.number(), targetId: z.string(), targetHash: z.string().nullable(),
  title: z.string(), evidenceKey: z.string(), sources: z.array(sourceSchema).min(2).max(6), synthesis: synthesisSchema });
type DreamUpdate = z.infer<typeof updateSchema>;
const label = (text: string) => text.replace(/[\[\]<>\r\n]/g, " ");
function overview(update: DreamUpdate): string {
  return `# ${label(update.title)}\n\nSynthesis of source accounts; not independently verified.\n\n` +
    update.synthesis.claims.map(claim => `## ${claim.kind === "difference" ? "Differing accounts" : claim.kind === "connection" ? "Related observations" : "From the accounts"}\n\n${claim.text}\n\n` +
      claim.evidence.map(e => `[${label(update.sources.find(s => s.id === e.sourceId)!.title)}](/${e.sourceId}.md):\n` + e.quote.split("\n").map(line => `> ${line}`).join("\n")).join("\n\n")).join("\n\n") +
    `\n\n## Original accounts\n\n${update.sources.map(s => `- [${label(s.title)}](/${s.id}.md)`).join("\n")}\n`;
}

/** A deterministic workflow write. Existing workflow permission/deferred-write
 * mechanisms govern it; it is not added to the agent's tool groups. */
export function reflectionWriteTool(runtime: HistoryRuntime) {
  return defineTool({ name: "okf_apply_reflection", kind: "write", description: "Save a cited memory synthesis and links while retaining all original accounts.",
    schema: updateSchema, execute: async update => {
      validateSynthesis(update.synthesis, update.sources);
      if (update.synthesis.identity !== "same") throw new HistoryConflict("Uncertain identity: keep these accounts separate");
      const targetId = normalizeConceptId(update.targetId);
      return runtime.files.mutate(runtime.root, "memory-reflection", "okf_apply_reflection", async root => {
        for (const source of update.sources) {
          const file = Bun.file(join(root, `${normalizeConceptId(source.id)}.md`));
          if (!(await file.exists()) || hash(await file.text()) !== source.sha256) throw new HistoryConflict("Source changed during reflection; retry on current memories");
        }
        const file = Bun.file(join(root, `${targetId}.md`));
        if ((await file.exists() ? hash(await file.text()) : null) !== update.targetHash) throw new HistoryConflict("Overview changed during reflection");
        const store = new OkfStore({ root, actor: "memory-reflection", now: () => new Date(update.preparedAt) }, true);
        const body = overview(update);
        const sources = update.sources.map(s => ({ resource: `/${s.id}.md`, id: s.sha256, title: s.title }));
        const extra = { overview_kind: marker, overview_body_sha: hash(body.trim() + "\n"), evidence_key: update.evidenceKey,
          derivation: { kind: "cited-synthesis", source_versions: update.sources.map(s => ({ id: s.id, sha256: s.sha256 })) } };
        if (update.targetHash === null) await store.create({ id: targetId, type: "Memory", title: update.title, body, sources, extra });
        else await store.patch({ id: targetId, title: update.title, sources, bodyOps: [{ op: "replaceAll", content: body }], extra });
        for (const source of update.sources) {
          const current = await store.read(source.id), body = current.body ?? "";
          if (!body.includes(`](/${targetId}.md)`)) await store.patch({ id: source.id, bodyOps: [{ op: "replaceAll", content:
            `${body.trim()}\n\n<!-- solenoid-overview-link -->\n## Related overview\n\n[${label(update.title)}](/${targetId}.md)\n<!-- /solenoid-overview-link -->\n` }] });
        }
        return { id: targetId, title: update.title, sourceIds: update.sources.map(s => s.id) };
      });
    } });
}

/** Existing Workflows runner owns scheduling, guidance, tracing and cancellation.
 * One shared embedding index supplies candidates; no proposal queue or new UI. */
export class DreamWorkflow {
  constructor(readonly runtime: HistoryRuntime, readonly neighbors: DreamNeighbors = runtime.neighbors, readonly synthesize: DreamSynthesizer = synthesizeDream) {}
  async run(signal?: AbortSignal) {
    const db = this.runtime.history.db.$client, resource = `dream:${this.runtime.root}`, owner = randomUUID();
    db.transaction(() => {
      const prior = db.query("SELECT pid FROM okf_write_locks WHERE resource=?").get(resource) as { pid: number } | null;
      if (prior) {
        let alive = true; try { process.kill(prior.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
        if (alive) throw new HistoryConflict("Reflection is already running");
        db.query("DELETE FROM okf_write_locks WHERE resource=?").run(resource);
      }
      db.query("INSERT INTO okf_write_locks(resource,owner,pid,acquired_at) VALUES(?,?,?,?)").run(resource, owner, process.pid, this.runtime.history.now());
    }).immediate();
    try { return await this.pass(signal); }
    finally { db.query("DELETE FROM okf_write_locks WHERE resource=? AND owner=?").run(resource, owner); }
  }
  private async pass(signal?: AbortSignal) {
    const gate = currentConsent();
    if (!gate) throw new HistoryConflict("Reflection requires the existing workflow permission context");
    const files = await snapshot(this.runtime.root);
    const eligible = [...files].filter(([path, text]) => !["index.md", "log.md"].includes(path.split("/").at(-1)!) &&
      !parseConcept(path.slice(0, -3), text).frontmatter.overview_kind && parseConcept(path.slice(0, -3), text).frontmatter.status !== "deprecated").map(([path]) => path.slice(0, -3)).sort();
    const db = this.runtime.history.db.$client;
    const checkpoint = db.query("SELECT cursor FROM dream_checkpoints WHERE root=?").get(this.runtime.root) as { cursor: number } | null;
    const offset = (checkpoint?.cursor ?? 0) % Math.max(1, eligible.length);
    const seeds = [...eligible.slice(offset), ...eligible.slice(0, offset)].slice(0, 12);
    const seen = new Set<string>(), updates: { id: string; title: string; operationId: string }[] = [];
    let unavailable = 0, uncertain = 0, unchanged = 0, deferred = 0, attempts = 0;
    for (const id of seeds) {
      signal?.throwIfAborted();
      if (attempts >= 5) break;
      const result = await this.neighbors(id, hash(files.get(`${id}.md`)! ), 12);
      if (result.status !== "ready") { unavailable++; continue; }
      const ids = [...new Set([id, ...result.candidates.filter(c => c.id !== id && eligible.includes(c.id) &&
        hash(files.get(`${c.id}.md`)!) === c.sourceSha256).slice(0, 5).map(c => c.id)])].sort();
      if (ids.length < 2) continue;
      const groupKey = hash(JSON.stringify(ids));
      if (seen.has(groupKey)) continue;
      seen.add(groupKey);
      const identities = new Set(ids.map(id => parseConcept(id, files.get(`${id}.md`)!).frontmatter.entity_id).filter(v => typeof v === "string"));
      if (identities.size > 1) { uncertain++; continue; }
      const sources = ids.map(id => { const text = files.get(`${id}.md`)!, c = parseConcept(id, text);
        return { id, sha256: hash(text), title: String(c.frontmatter.title ?? id), body: evidenceBody(c.body) }; });
      const evidenceKey = hash(JSON.stringify(sources.map(s => [s.id, s.title, s.body, parseConcept(s.id, files.get(`${s.id}.md`)!).frontmatter.sources])));
      const targetId = `overviews/related-${groupKey.slice(0, 16)}`, target = files.get(`${targetId}.md`);
      if (target) {
        const current = parseConcept(targetId, target);
        if (current.frontmatter.evidence_key === evidenceKey) { unchanged++; continue; }
        if (current.frontmatter.overview_kind !== marker || current.frontmatter.overview_body_sha !== hash(current.body)) { uncertain++; continue; }
      }
      attempts++;
      let synthesis;
      try { synthesis = validateSynthesis(await this.synthesize(sources, sources[0]!.title, signal), sources); }
      catch (e) { if (e instanceof HistoryConflict) { uncertain++; continue; } throw e; }
      signal?.throwIfAborted();
      if (synthesis.identity !== "same") { uncertain++; continue; }
      const update = updateSchema.parse({ preparedAt: this.runtime.history.now(), targetId, targetHash: target ? hash(target) : null,
        title: `${sources[0]!.title} — related memories`, evidenceKey, sources, synthesis });
      const tool = reflectionWriteTool(this.runtime);
      const verdict = await gate({ tool: tool.definition.function.name, kind: "write", args: update, description: tool.definition.function.description });
      if (!verdict.allow) { deferred++; continue; }
      signal?.throwIfAborted();
      try {
        const saved = await tool.execute(update) as { id: string; title: string; operationId: string };
        updates.push(saved);
        // Backlinks changed source versions; subsequent seeds must use current
        // bytes and wait for their refreshed vectors, not retry a stale read set.
        files.clear(); for (const [path, text] of await snapshot(this.runtime.root)) files.set(path, text);
      } catch (e) { if (e instanceof HistoryConflict) { uncertain++; continue; } throw e; }
    }
    db.query("INSERT INTO dream_checkpoints(root,cursor) VALUES(?,?) ON CONFLICT(root) DO UPDATE SET cursor=excluded.cursor")
      .run(this.runtime.root, (offset + seeds.length) % Math.max(1, eligible.length));
    return { updates, seeds: seeds.length, unavailable, uncertain, unchanged, deferred };
  }
}
