import { hasPendingFileWrite } from "../writeHistory/history";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { canonicalBundleRoot } from "../okf/bundle";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SQLQueryBindings } from "bun:sqlite";
import type { Db } from "../db";
import { okfObjectId } from "../db/ids";
import { parseDocument } from "../okf/concept";
import { isStale, meetsTrust, statusOf, trustTier } from "../okf/trust";
import type { SearchInput } from "../okf/store";
import { extractFields } from "../db/okf/fields";
import { provenanceOf, sourceEntries } from "../db/okf/reindex";
import { shelfFor } from "../db/okf/classify";
import { configId, decode, EmbeddingError, encode, formatInput, googleEmbeddings, hash, normalize,
  type EmbeddingConfig, type EmbeddingProvider } from "./embedding";

type Document = { scope: string; concept_id: string; source_hash: string; approved_config: string | null;
  title: string; header: string; body: string; frontmatter: string };
type Chunk = { scope: string; concept_id: string; config_id: string; input_hash: string; input: string;
  excerpt: string; vector: Uint8Array | null; state: string; attempts: number; owner: string | null };
type Scan = { documents: Document[]; problems: string[] };
export type SearchOptions = SearchInput & { group?: string; includeBody?: boolean };
export type IndexStatus = { enabled: boolean; configId: string; eligible: number; ready: number; pending: number;
  failed: number; unindexed: number; problems: number; reservedTokens: number; dailyTokens: number };

// Fail the entire scan on directory/read errors. A missing mount is not an empty
// corpus. Symlinks are never followed. Parse errors retire only that search row.
function scan(root: string): Scan {
  if (!statSync(root).isDirectory()) throw new Error("Knowledge store unavailable");
  const documents: Document[] = [], problems: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("Knowledge store contains a symlink");
      if (entry.isDirectory()) { walk(rel); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".md") || ["index.md", "log.md"].includes(entry.name)) continue;
      const raw = readFileSync(join(root, rel), "utf8");
      const id = rel.slice(0, -3);
      try {
        const { frontmatter: fm, body } = parseDocument(raw);
        if (!fm) { problems.push(id); continue; }
        const title = typeof fm.title === "string" ? fm.title : id;
        const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : [];
        const header = [title, String(fm.description ?? ""), tags.join(" "),
          ...extractFields(body).map(f => `${f.label}: ${f.value}`)].join("\n");
        documents.push({ scope: root, concept_id: id, source_hash: hash(raw), approved_config: null,
          title, header, body, frontmatter: JSON.stringify(fm) });
      } catch { problems.push(id); }
    }
  }
  walk("");
  return { documents, problems };
}

// Hard splitting preserves every codepoint, including CJK and long unbroken
// strings. Byte ceilings are conservative; autoTruncate=false is the final guard.
function splitBytes(text: string, max: number): string[] {
  const chunks: string[] = [];
  let part = "", size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > max) { chunks.push(part); part = ""; size = 0; }
    part += char; size += bytes;
  }
  if (part) chunks.push(part);
  return chunks;
}
export function chunksFor(doc: Pick<Document, "title" | "header" | "body">, config: EmbeddingConfig) {
  const ceiling = config.model === "gemini-embedding-001" ? 1600 : 5000;
  const context = splitBytes(doc.title, 300)[0] ?? "";
  // Header facts are also in the original body, but the header gives short
  // memories a useful representation. No generated timestamp is embedded.
  const sections = [doc.header, ...doc.body.split(/\n(?=#{1,6} )/)];
  const unique = new Map<string, { inputHash: string; input: string; excerpt: string }>();
  for (const section of sections) for (const excerpt of splitBytes(section, ceiling - 400)) {
    if (!excerpt.trim()) continue;
    const input = `${context}\n${excerpt}`;
    const inputHash = hash(input);
    unique.set(inputHash, { inputHash, input, excerpt });
  }
  return [...unique.values()];
}

export class KnowledgeIndex {
  readonly root: string;
  readonly configId: string;
  private readonly provider: EmbeddingProvider;
  constructor(private readonly dbFactory: () => Db, root: string, readonly config: EmbeddingConfig,
    provider?: EmbeddingProvider, private readonly now: () => number = Date.now) {
    this.root = canonicalBundleRoot(root);
    this.configId = configId(config);
    this.provider = provider ?? googleEmbeddings(config);
  }
  private get sql() { return this.dbFactory().$client; }
  private all<T>(query: string, ...args: SQLQueryBindings[]) { return this.sql.query<T, SQLQueryBindings[]>(query).all(...args); }
  private run(query: string, ...args: SQLQueryBindings[]) { return this.sql.query(query).run(...args); }
  private documents() { return this.all<Document>("SELECT * FROM okf_search_documents WHERE scope=?", this.root); }
  private key(id: string) { return `okf-search:${hash(this.root)}:${id}`; }

  private writeInProgress() {
    return hasPendingFileWrite(this.dbFactory(), this.root);
  }

  /** Establish the pre-write inventory so recovery can distinguish a new file
   * from an existing corpus even if the process dies before the post-write hook. */
  prepareWrite() {
    if (existsSync(this.root)) this.reconcile();
    else this.run("INSERT OR IGNORE INTO okf_search_scopes VALUES (?,?)", this.root, this.now());
  }

  /** Synchronous transaction/scan keeps concurrent server and worker passes ordered.
   * Initial discovery does not opt old memories into a paid backfill. */
  reconcile(options: { enroll?: "all" | string[]; retryFailed?: boolean } = {}): IndexStatus {
    if (this.writeInProgress()) return this.status();
    let problems = 0;
    this.sql.transaction(() => {
      const scanned = scan(this.root); // throwing rolls back, including absence handling
      problems = scanned.problems.length;
      const initialized = this.all("SELECT 1 FROM okf_search_scopes WHERE scope=?", this.root).length > 0;
      const previous = new Map(this.documents().map(d => [d.concept_id, d]));
      const seen = new Set(scanned.documents.map(d => d.concept_id));
      for (const doc of scanned.documents) {
        const old = previous.get(doc.concept_id);
        const explicit = options.enroll === "all" || options.enroll?.includes(doc.concept_id);
        const changed = old && old.source_hash !== doc.source_hash;
        doc.approved_config = explicit || (!old && initialized) || changed ? this.configId : old?.approved_config ?? null;
        const fm = JSON.parse(doc.frontmatter) as Record<string, unknown>;
        if (statusOf(fm) === "deprecated") doc.approved_config = null;
        if (!old || old.source_hash !== doc.source_hash || old.approved_config !== doc.approved_config) {
          this.run(`INSERT INTO okf_search_documents VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scope,concept_id)
            DO UPDATE SET source_hash=excluded.source_hash,approved_config=excluded.approved_config,
            title=excluded.title,header=excluded.header,body=excluded.body,frontmatter=excluded.frontmatter`,
            this.root, doc.concept_id, doc.source_hash, doc.approved_config, doc.title, doc.header, doc.body, doc.frontmatter);
          this.run("DELETE FROM search WHERE subject_id=? AND kind='okf_search'", this.key(doc.concept_id));
          this.run("INSERT INTO search(title,body,subject_id,kind) VALUES (?,?,?,'okf_search')",
            doc.title, `${doc.header}\n${doc.body}`, this.key(doc.concept_id));
        }
        if (doc.approved_config !== this.configId) {
          // Deprecated sources and model changes cannot leave spendable jobs.
          this.run("DELETE FROM okf_search_chunks WHERE scope=? AND concept_id=? AND config_id=?",
            this.root, doc.concept_id, this.configId);
          continue;
        }
        const desired = chunksFor(doc, this.config);
        const live = new Set(desired.map(c => c.inputHash));
        for (const held of this.all<Chunk>("SELECT * FROM okf_search_chunks WHERE scope=? AND concept_id=? AND config_id=?", this.root, doc.concept_id, this.configId)) {
          if (!live.has(held.input_hash)) this.run("DELETE FROM okf_search_chunks WHERE scope=? AND concept_id=? AND config_id=? AND input_hash=?",
            this.root, doc.concept_id, this.configId, held.input_hash);
        }
        for (const chunk of desired) this.run(`INSERT OR IGNORE INTO okf_search_chunks
          (scope,concept_id,config_id,input_hash,input,excerpt) VALUES (?,?,?,?,?,?)`,
          this.root, doc.concept_id, this.configId, chunk.inputHash, chunk.input, chunk.excerpt);
      }
      for (const old of previous.values()) if (!seen.has(old.concept_id)) {
        this.run("DELETE FROM search WHERE subject_id=? AND kind='okf_search'", this.key(old.concept_id));
        this.run("DELETE FROM okf_search_chunks WHERE scope=? AND concept_id=?", this.root, old.concept_id);
        this.run("DELETE FROM okf_search_documents WHERE scope=? AND concept_id=?", this.root, old.concept_id);
      }
      if (options.retryFailed) this.run(`UPDATE okf_search_chunks SET state='pending',attempts=0,next_attempt=0,error=NULL
        WHERE scope=? AND config_id=? AND state='failed'`, this.root, this.configId);
      this.run("INSERT OR IGNORE INTO okf_search_scopes VALUES (?,?)", this.root, this.now());
    }).immediate();
    return this.status(problems);
  }

  status(problems = 0): IndexStatus {
    const docs = this.documents().filter(d => statusOf(JSON.parse(d.frontmatter)) !== "deprecated");
    const chunks = this.all<Chunk>("SELECT * FROM okf_search_chunks WHERE scope=? AND config_id=?", this.root, this.configId);
    let ready = 0, pending = 0, failed = 0, unindexed = 0;
    for (const doc of docs) {
      const held = chunks.filter(c => c.concept_id === doc.concept_id);
      if (doc.approved_config !== this.configId || !held.length) unindexed++;
      else if (held.some(c => c.state === "failed")) failed++;
      else if (held.every(c => c.state === "ready")) ready++;
      else pending++;
    }
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const used = this.all<{ reserved_tokens: number }>("SELECT reserved_tokens FROM okf_embedding_usage WHERE day=?", day)[0]?.reserved_tokens ?? 0;
    return { enabled: this.config.enabled, configId: this.configId, eligible: docs.length, ready, pending, failed,
      unindexed, problems, reservedTokens: used, dailyTokens: this.config.dailyTokens };
  }
  plan() {
    const indexing = this.reconcile();
    let chunks = 0, inputBytes = 0;
    for (const doc of this.documents().filter(d => this.eligible(d, {}))) {
      for (const chunk of chunksFor(doc, this.config)) {
        chunks++;
        inputBytes += Buffer.byteLength(formatInput(this.config, chunk.input, "document"));
      }
    }
    return { ...indexing, totalChunks: chunks, conservativeInputTokenCeiling: inputBytes,
      estimatedOnlineCostUpperUsd: inputBytes / 1_000_000 * (this.config.model === "gemini-embedding-2" ? 0.20 : 0.15),
      note: "Full rebuild ceiling using bytes as tokens; unchanged vectors are reused. Confirm current Cloud SKU." };
  }
  private reserve(input: string, kind: "document" | "query") {
    // Reserve UTF-8 bytes as a conservative token ceiling. Never refund a failed
    // or timed-out call: it may already have been billed remotely.
    const tokens = Buffer.byteLength(formatInput(this.config, input, kind));
    if (!this.config.project) throw new EmbeddingError("missing_project");
    if (tokens > (this.config.model === "gemini-embedding-001" ? 1900 : 7000)) throw new EmbeddingError("input_too_large");
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const allowed = this.sql.transaction(() => {
      this.run("INSERT OR IGNORE INTO okf_embedding_usage VALUES (?,0)", day);
      return this.run(`UPDATE okf_embedding_usage SET reserved_tokens=reserved_tokens+?
        WHERE day=? AND reserved_tokens+?<=?`, tokens, day, tokens, this.config.dailyTokens).changes > 0;
    }).immediate();
    if (!allowed) throw new EmbeddingError("daily_budget_exhausted");
  }

  /** One leased job per tick. No paid batch or corpus-wide fanout. */
  async processOne(): Promise<string> {
    if (!this.config.enabled) return "disabled";
    if (!this.config.project) return "missing_project";
    if (this.writeInProgress()) return "write_in_progress";
    this.reconcile();
    const owner = randomUUID();
    const job = this.sql.transaction(() => {
      const candidate = this.all<Chunk>(`SELECT c.* FROM okf_search_chunks c JOIN okf_search_documents d
        ON d.scope=c.scope AND d.concept_id=c.concept_id AND d.approved_config=c.config_id
        WHERE c.scope=? AND c.config_id=? AND ((c.state IN ('pending','retry') AND c.next_attempt<=?)
        OR (c.state='running' AND c.lease_until<=?)) ORDER BY c.next_attempt,c.concept_id,c.input_hash LIMIT 1`,
        this.root, this.configId, this.now(), this.now())[0];
      if (!candidate) return undefined;
      this.run(`UPDATE okf_search_chunks SET state='running',owner=?,lease_until=?,attempts=attempts+1
        WHERE scope=? AND concept_id=? AND config_id=? AND input_hash=?`,
        owner, this.now() + 60_000, this.root, candidate.concept_id, this.configId, candidate.input_hash);
      return candidate;
    }).immediate();
    if (!job) return "idle";
    try {
      this.reserve(job.input, "document");
      const vector = normalize(await this.provider.embed(job.input, "document"), this.config.dimensions);
      if (this.writeInProgress()) throw new EmbeddingError("write_in_progress", true);
      // Files may have changed while awaiting Google. Reconcile before publishing.
      this.reconcile();
      const wrote = this.run(`UPDATE okf_search_chunks SET vector=?,state='ready',owner=NULL,lease_until=0,error=NULL
        WHERE scope=? AND concept_id=? AND config_id=? AND input_hash=? AND owner=?`,
        encode(vector), this.root, job.concept_id, this.configId, job.input_hash, owner).changes;
      return wrote ? "ready" : "superseded";
    } catch (error) {
      const safe = error instanceof EmbeddingError ? error : new EmbeddingError("index_unavailable", true);
      const budget = safe.code === "daily_budget_exhausted";
      const retry = budget || (safe.retryable && job.attempts < 4);
      const next = budget ? Date.parse(new Date(this.now()).toISOString().slice(0, 10)) + 86_400_000
        : this.now() + Math.min(300_000, 1000 * 2 ** job.attempts) + Math.floor(Math.random() * 1000);
      this.run(`UPDATE okf_search_chunks SET state=?,error=?,next_attempt=?,owner=NULL,lease_until=0,
        attempts=attempts-? WHERE scope=? AND concept_id=? AND config_id=? AND input_hash=? AND owner=?`,
        retry ? "retry" : "failed", safe.code, next, budget ? 1 : 0, this.root, job.concept_id, this.configId, job.input_hash, owner);
      return safe.code;
    }
  }

  private current(doc: Document) {
    try { return hash(readFileSync(join(this.root, `${doc.concept_id}.md`), "utf8")) === doc.source_hash; }
    catch { return false; }
  }
  containsObject(objectId: string) {
    return this.documents().some(doc => okfObjectId(`okf:${doc.concept_id}`) === objectId && this.current(doc));
  }
  private eligible(doc: Document, opts: SearchOptions) {
    const fm = JSON.parse(doc.frontmatter) as Record<string, unknown>;
    const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : [];
    return (!opts.type || String(fm.type ?? "").toLowerCase() === opts.type.toLowerCase()) &&
      (opts.status ? statusOf(fm) === opts.status : statusOf(fm) !== "deprecated") &&
      (!opts.minTrust || meetsTrust(fm, opts.minTrust)) &&
      (!opts.staleOnly || isStale(fm, new Date(this.now()))) &&
      (!opts.tags?.length || opts.tags.some(t => tags.some(tag => tag.toLowerCase() === t.toLowerCase()))) &&
      (!opts.group || (shelfFor(tags).group ?? "Everything else") === opts.group);
  }
  async search(opts: SearchOptions = {}) {
    let indexing = this.reconcile();
    const query = opts.query?.trim() ?? "";
    let vector: number[] | undefined;
    let reason = !this.config.enabled ? "disabled" : opts.includeBody === false ? "header_only" : "no_ready_vectors";
    if (query && this.config.enabled && opts.includeBody !== false && indexing.ready) {
      try {
        this.reserve(query, "query");
        vector = normalize(await this.provider.embed(query, "query"), this.config.dimensions);
        reason = "";
      } catch (e) { reason = e instanceof EmbeddingError ? e.code : "provider_unavailable"; }
      indexing = this.reconcile();
    }
    const docs = this.documents().filter(d => this.eligible(d, opts));
    const needle = query.toLowerCase();
    const lexical = docs.filter(d => !query || `okf:${d.concept_id}\n${d.header}${opts.includeBody === false ? "" : `\n${d.body}`}`.toLowerCase().includes(needle));
    lexical.sort((a, b) => Number(b.title.toLowerCase() === needle) - Number(a.title.toLowerCase() === needle) || a.concept_id.localeCompare(b.concept_id));
    const ranks = new Map<string, { score: number; channels: string[]; excerpt?: string; cosine?: number }>();
    const add = (id: string, rank: number, channel: string, extra = {}) => {
      const held = ranks.get(id) ?? { score: 0, channels: [] };
      held.score += 1 / (60 + rank); held.channels.push(channel); Object.assign(held, extra); ranks.set(id, held);
    };
    lexical.forEach((d, i) => add(d.concept_id, i + 1, "substring"));
    const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 32) ?? [];
    if (terms.length && opts.includeBody !== false) {
      const match = terms.map(t => `"${t.replaceAll('"', '""')}"`).join(" AND ");
      const fts = this.all<{ subject_id: string }>(`SELECT subject_id FROM search WHERE search MATCH ? AND kind='okf_search'
        ORDER BY bm25(search,5.0,1.0)`, match);
      const lookup = new Map(docs.map(d => [this.key(d.concept_id), d.concept_id]));
      let rank = 0;
      for (const hit of fts) { const id = lookup.get(hit.subject_id); if (id) add(id, ++rank, "fts"); }
    }
    if (vector) {
      const scored = this.vectorScores(docs, vector);
      scored.slice(0, 50).forEach((hit, i) => add(hit.id, i + 1, "semantic", { cosine: hit.score, excerpt: hit.excerpt }));
    }
    const results = docs.filter(d => ranks.has(d.concept_id) && this.current(d)).sort((a, b) => {
      const exact = (d: Document) => query && (d.title.toLowerCase() === needle || d.concept_id.toLowerCase() === needle || `okf:${d.concept_id}`.toLowerCase() === needle) ? 1 : 0;
      return exact(b) - exact(a) || ranks.get(b.concept_id)!.score - ranks.get(a.concept_id)!.score || a.concept_id.localeCompare(b.concept_id);
    }).map(doc => {
      const fm = JSON.parse(doc.frontmatter) as Record<string, unknown>;
      const ranked = ranks.get(doc.concept_id)!;
      const fields = extractFields(doc.body);
      const matchedIn = [doc.title.toLowerCase().includes(needle) ? "title" : "",
        String(fm.description ?? "").toLowerCase().includes(needle) ? "blurb" : "",
        (Array.isArray(fm.tags) ? fm.tags : []).some(t => String(t).toLowerCase().includes(needle)) ? "tag" : "",
        fields.some(f => `${f.label} ${f.value}`.toLowerCase().includes(needle)) ? "fact" : "",
        opts.includeBody !== false && doc.body.toLowerCase().includes(needle) ? "prose" : "",
        ...ranked.channels.filter(c => c !== "substring")].filter(Boolean);
      const pos = doc.body.toLowerCase().indexOf(needle);
      const snippet = opts.includeBody === false ? undefined : (ranked.excerpt ?? doc.body.slice(Math.max(0, pos - 80), Math.max(0, pos - 80) + 400)).slice(0, 400);
      return { id: okfObjectId(`okf:${doc.concept_id}`), conceptId: doc.concept_id, uri: `okf:${doc.concept_id}`,
        title: doc.title, name: doc.title, description: String(fm.description ?? ""), blurb: String(fm.description ?? ""),
        type: String(fm.type ?? ""), tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
        status: statusOf(fm), trust: trustTier(fm), stale: isStale(fm, new Date(this.now())),
        group: shelfFor(Array.isArray(fm.tags) ? fm.tags.map(String) : []).group ?? "Everything else",
        sourceSha256: doc.source_hash, score: ranked.score, cosine: ranked.cosine, matchedIn,
        facts: fields.filter(f => `${f.label} ${f.value}`.toLowerCase().includes(needle)).map(f => ({ label: f.label, value: f.value, provenance: provenanceOf(sourceEntries(fm)) })),
        ...(snippet ? { snippet, excerpt: snippet } : {}) };
    });
    return { query, mode: vector ? "hybrid" : "lexical", reason: reason || undefined, indexing,
      matched: results.length, results: results.slice(0, opts.limit ?? 20) };
  }
  private vectorScores(docs: Document[], vector: number[]) {
    const chunks = this.all<Chunk>("SELECT * FROM okf_search_chunks WHERE scope=? AND config_id=?", this.root, this.configId);
    const scores: { id: string; score: number; excerpt: string }[] = [];
    for (const doc of docs) {
      const held = chunks.filter(c => c.concept_id === doc.concept_id);
      if (doc.approved_config !== this.configId || !held.length || held.some(c => c.state !== "ready" || !c.vector)) continue;
      let best = { id: doc.concept_id, score: -Infinity, excerpt: "" };
      for (const c of held) {
        try {
          const values = decode(c.vector!, this.config.dimensions);
          const score = values.reduce((sum, value, i) => sum + value * vector[i]!, 0);
          if (score > best.score) best = { id: doc.concept_id, score, excerpt: c.excerpt };
        } catch { best = { id: doc.concept_id, score: -Infinity, excerpt: "" }; break; }
      }
      if (Number.isFinite(best.score)) scores.push(best);
    }
    return scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }
  /** Local candidate discovery only. No remote embedding or consolidation. */
  neighbors(conceptId: string, expectedSourceSha256: string, limit = 20) {
    const indexing = this.reconcile();
    const docs = this.documents().filter(d => this.eligible(d, {}));
    const source = docs.find(d => d.concept_id === conceptId);
    const held = this.all<Chunk>("SELECT * FROM okf_search_chunks WHERE scope=? AND concept_id=? AND config_id=?", this.root, conceptId, this.configId);
    if (this.writeInProgress() || !source || source.source_hash !== expectedSourceSha256 || !held.length || held.some(c => !c.vector || c.state !== "ready")) {
      return { status: "unavailable", indexing, candidates: [] };
    }
    const best = new Map<string, { id: string; score: number; excerpt: string }>();
    for (const chunk of held) for (const hit of this.vectorScores(docs.filter(d => d !== source), decode(chunk.vector!, this.config.dimensions))) {
      if (hit.score > (best.get(hit.id)?.score ?? -Infinity)) best.set(hit.id, hit);
    }
    return { status: "ready", indexing, configId: this.configId, candidates: [...best.values()].sort((a, b) => b.score - a.score)
      .slice(0, Math.min(100, Math.max(1, limit))).map(hit => ({ ...hit, uri: `okf:${hit.id}`,
        sourceSha256: docs.find(d => d.concept_id === hit.id)!.source_hash })) };
  }
}
