# OKF semantic search: Gemini embeddings with local retrieval

Research/design spike — 2026-09-12. Checkout: `bbb927e`. No production changes, paid API requests, or private-memory uploads were performed. Proposed thresholds and acceptance criteria below are engineering starting points, not measured retrieval quality.

Implementation follow-up: the [setup guide](okf-semantic-search-setup.md) records the subsequently authorized implementation, its actual scope, and Cloud validation result. The design below remains the original research proposal; not every later-stage option is implemented.

## Recommendation

Use **Google Cloud `gemini-embedding-2`, 768 dimensions, text only**, with normalized float32 vectors in the existing SQLite database. Start with an exact cosine scan in Bun and combine its rankings with SQLite FTS5 and exact title/identifier matching. Keep Markdown authoritative. A successful memory write should immediately schedule durable embedding work; cloud availability must not determine whether the memory is saved. Return `pending`, `ready`, or `failed` semantic-index status rather than implying a saved memory is already embedded.

Embedding 2 is the preferred *candidate for evaluation*, not an already validated winner on OKF. Google's Cloud model card lists it as GA, released April 22, 2026, and supports `global`, `us`, and `eu`. Choose its GA identifier, not `gemini-embedding-2-preview`. The newer model also leaves a route to multimodal retrieval, though this spike's implementation scope is Markdown text. [Cloud model card](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/embedding-2).

Keep `gemini-embedding-001` as the comparison/fallback **index configuration**, never as an automatic per-request substitute against Embedding 2 vectors. Reusing embeddings for local memory-neighbor discovery gives the companion dream workflow useful candidates without another Google request. Similarity alone cannot establish identity, preferences, contradiction, or permission to merge.

## What this checkout actually does

No applicable `AGENTS.md` was found in the checkout or inspected parent directories. Relevant code was read; actual memory contents and the production database were not needed.

| Code | Observed behavior and design consequence |
| --- | --- |
| `src/okf/store.ts:223` | `OkfStore.search` scans Markdown concepts, lowercases the query, matches substrings in title/description/id/body, boosts header matches, and preserves type/status/trust/tag/staleness filters. |
| `src/tools/knowledge.ts:309` | `knowledge_search` scans projected objects and live fields. Matching covers title, description, tags, facts, and optionally prose; order is recency and the loop stops at the limit. It explicitly documents lack of synonyms. |
| `src/okf/store.ts:280` onward | Create/patch/move/deprecate write files, indexes, and logs. No embedding enqueue hook. The write gate serializes only one store instance, not all processes. Moves change path-derived identity and can rewrite several other files. There is no hard-delete tool; deprecation preserves history. |
| `src/db/okf/reindex.ts:167` | Rebuildable projection upserts objects, fields, conflicts, links, and sync state inside a synchronous transaction; changed facts retire old rows to preserve evidence. It neither populates embeddings/FTS nor removes objects whose files disappear. Projected links are inserted without removing obsolete ones. |
| `src/db/okf/refresh.ts:9`, `src/index.ts:46` | UI list/detail reads trigger projection refresh. Agent knowledge tools directly query the DB. Freshness cannot depend on opening the UI. |
| `src/db/schema/search.ts:11`, `drizzle/0001_views-and-search.sql` | Existing embedding rows hold subject, ordinal, chunk text/hash, model, dimensions, vector, timestamp. Unique key is `(subject, ordinal, model)`, insufficient for simultaneous dimensions/prompt/chunker versions. FTS5 already exists with Porter/unicode61 tokenization; no application FTS writer was found beyond schema tests. |
| `src/db/index.ts:27`, `deploy/Dockerfile` | `bun:sqlite`/Drizzle, WAL, foreign keys, busy timeout; no extension loader. Docker pins Bun 1.3.6 on Linux. Native Mac development is another compatibility target. |
| `package.json`, `bun.lock`, `src/chat/geminiLive.ts:332` | `@google/genai` 2.21.0 is already locked; direct `google-auth-library` is 9.15.1. Existing Gemini Live uses an API key, while Model Armor has separate Cloud auth. Neither proves permission or correct credentials for embedding private memories. |

These are source observations, not a claim about live corpus size. During implementation, update both tool descriptions and use one retrieval service; otherwise the agent and UI will disagree about search capabilities.

## Google offering, limits, and cost

| Model | Current documented role/limits | Decision |
| --- | --- | --- |
| `gemini-embedding-2` | Multimodal; 8,192 total input tokens; default/up to 3,072 output dimensions; GA model and batch support on Cloud model card. | Evaluate as default for new indexing. |
| `gemini-embedding-001` | Text, multilingual and code; 2,048 tokens per text; up to 3,072 dimensions. | Text-only baseline; mature alternate index. |
| `text-embedding-005` | English/code; 2,048 tokens; up to 768 dimensions. | Lower-cost legacy comparison only if needed. |
| `text-multilingual-embedding-002` | Multilingual; 2,048 tokens; up to 768 dimensions. | No clear advantage for a new Gemini-based design. |

Sources: [Embedding 2 specifications](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/embedding-2), [Cloud text embedding model table](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/text-embeddings-api). Legacy `multimodalembedding@001` also exists, but its image/video workflow adds nothing needed for this text-memory scope. [Cloud multimodal guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-multimodal-embeddings).

**Retrieval configuration differs by generation.** Embedding 2 documents use `title: {title} | text: {content}`; search queries use `task: search result | query: {query}`. Do not send `taskType` for this model. Embedding 001 instead uses `RETRIEVAL_DOCUMENT` for stored chunks and `RETRIEVAL_QUERY` for search; optional `title` applies to documents. Its `QUESTION_ANSWERING` is an alternative query mode paired with document embeddings. `SEMANTIC_SIMILARITY` is a separate symmetric task, not the document-retrieval default. [Embedding 2 instructions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-multimodal-embeddings), [task types](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/task-types).

Google recommends dimensions 768, 1536, or 3072. Its Gemini model guide states that Embedding 2 normalizes reduced dimensions automatically, whereas 001 requires manual normalization below 3072. Normalize defensively at our adapter boundary regardless; reject zero, nonfinite, wrong-length, or truncated output. Store the requested dimension and full configuration with every vector. [Dimensions and normalization](https://ai.google.dev/gemini-api/docs/embeddings#ensuring-quality-for-smaller-dimensions). This Gemini API reference supports the model-level normalization claim; Cloud limits, billing, and auth come from Cloud documentation.

**Request sizing:** send one chunk per request initially. The 001 `:predict` reference explicitly permits one text, while the generic text guide advertises 250 texts/20,000 aggregate tokens and shows multi-text SDK examples. Do not infer batching behavior across endpoints. Embedding 2's documented REST call uses `:embedContent` with one `content`; combined parts can represent one semantic input. Validate output count and ordering before introducing multi-input requests. [001 endpoint reference](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/text-embeddings-api), [text guide](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-text-embeddings), [Embedding 2 request](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/get-multimodal-embeddings).

Published Cloud rates observed today:

| Input | Online | Batch |
| --- | --- | --- |
| Embedding 2 text | $0.20 / million tokens | $0.10 / million tokens |
| Earlier Gemini Embedding | $0.00015 / 1,000 input tokens, equivalent to $0.15 / million | $0.00012 / 1,000, equivalent to $0.12 / million |
| Other text embedding models | $0.000025 / 1,000 characters | $0.00002 / 1,000 characters |

Output embeddings have no additional output charge. **Documentation discrepancy:** the current pricing table still calls Embedding 2 “Preview,” while the model card calls the unqualified identifier GA; the earlier model's current table uses generic “count” wording. The older Cloud pricing rendering explicitly identifies tokens versus characters. Confirm the selected GA SKU before spending. Do not apply Gemini Developer API pricing to Vertex/Cloud. [Current Cloud pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing), [earlier explicit unit table](https://cloud.google.com/vertex-ai/generative-ai/pricing?hl=he).

Illustrative arithmetic at $0.20/million: 10,000 chunks averaging 500 billed tokens = 5 million tokens = **$1 initial online backfill**. Re-embedding 1,000 changed chunks = **$0.10**; 10,000 queries averaging 40 tokens = **$0.08**. These are invented workload sizes, including title/instruction tokens in the averages; retries, overlaps, model comparisons, storage, network, and taxes are extra. Dimensions reduce local bytes and compute, not input-token charges. A separate second embedding representation roughly doubles its document embedding work. Online queue processing is sufficient initially; Cloud Batch adds remote input/output staging and retention decisions for tiny absolute savings here.

Treat quotas as configuration, not constants. Current Cloud docs distinguish global embedding token/request limits and additional `predict` quotas. Start with two concurrent jobs, exponential backoff with jitter for 429/5xx, a durable daily token budget, and bounded retries. Reserve capacity for interactive queries. [Cloud quotas](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/quotas).

## SDK and privacy boundary

Use a dedicated adapter around the existing `@google/genai` dependency. The following is a **design sketch, not executed integration code**:

```ts
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  vertexai: true,
  project: config.project,
  location: config.location, // explicitly chosen: global, us, or eu
});

const response = await ai.models.embedContent({
  model: "gemini-embedding-2",
  contents: formattedSingleInput,
  config: { outputDimensionality: 768, autoTruncate: false },
});
const values = response.embeddings?.[0]?.values;
// Require one vector, exactly 768 finite numbers, nonzero norm,
// and no truncation; normalize and serialize explicitly as float32 LE.
```

The official JS SDK documents Cloud client selection and embedding configuration, including `autoTruncate`; the model guide documents Embedding 2's default silent truncation. Verify the locked SDK's Embedding 2 endpoint conversion and `autoTruncate: false` behavior in the authorized synthetic smoke test. If unsupported, fail the test and use a verified token-bound splitter/Cloud REST adapter, never silently ignore the cap. Dependency installation and SDK execution were not performed in this checkout. [SDK](https://googleapis.github.io/js-genai/release_docs/), [EmbedContentConfig](https://googleapis.github.io/js-genai/release_docs/interfaces/types.EmbedContentConfig.html).

Use Application Default Credentials, an explicitly billed project, and the Cloud API enabled for that project. Local development can use ADC; a deployed worker should use a dedicated identity with scoped permissions and securely supplied credentials/federation appropriate to its host. Cloud inference requires `aiplatform.endpoints.predict`; avoid owner credentials. Model Armor's credentials and Gemini Live's API key are not implicitly reused. [ADC setup](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/gcp-auth), [access control](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/access-control).

**Local vector retrieval still sends memory text and search-query text to Google to embed them.** Before enabling it, obtain authorization covering the selected memories, query text, project/location, and budget. A configuration default of `enabled=false` must prevent even query embedding calls. Private text, vectors, credentials, and raw request/response bodies should be omitted from telemetry; record IDs, counts, timings, configuration, and sanitized errors. Embeddings remain sensitive data in SQLite and backups.

Google's Cloud policy prohibits training/fine-tuning on customer data without permission, but documents circumstances for abuse-monitoring retention. That is not an unconditional zero-retention promise. Review the applicable project terms and logging settings before enabling private input. Likewise, an endpoint label alone does not guarantee residency; global routing cannot promise a chosen processing region. [Data governance](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention), [endpoint limitations](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations).

## Chunking, identity, and lifecycle

Proposed canonical document text: title, description, relevant tags, heading breadcrumb, and original section prose. Include explicit person names/aliases already present in the memory; never invent that “he” means the user's dad. Exclude generated timestamps, index listings, and operational logs. Preserve source text spans, field IDs, and provenance separately so results can cite the original memory.

Start with one chunk for a short page; split longer pages at headings, paragraphs, then sentences. Target 300–600 tokens, a 1,000-token ceiling including repeated context, and 40–80 tokens of overlap only when splitting continuous prose. These are evaluation candidates, not Google recommendations. Use a verified tokenizer/counting approach, and reject/re-split oversized input; character-count heuristics alone cannot guarantee limits across languages. No silently discarded page tail. Body search disabled should restrict results to a separate header representation (title/description/tags/live fact text), or use lexical-only matching initially; do not let body-derived vectors violate `includeBody=false`.

Extend the current schema through a reviewed migration:

- `embedding_configs`: ID, provider/API family, model ID, dimensions, document/query template versions, chunker version, normalization/encoding, and activation state. Treat these together as an embedding space. Changing model/prompt/dimensions creates a new configuration.
- `okf_search_state`: subject, source-file hash, canonical-text hash, current chunk-set generation, presence/parse status, indexed time, and error state. File hash detects any edit; canonical hash avoids paid work for timestamp-only changes. Existing `rev` comes from log counts and is not a sufficient concurrency token.
- `embedding_chunks`: subject, generation, stable section/content identity, ordinal, exact source span, canonical input hash, and input text. Identity must not be ordinal alone: inserting an early section must not recompute every unchanged section.
- Extend `embeddings` to reference configuration/chunk identity with unique `(configId, chunkId)` and enforce `length(vector) = 4 * dim`. Cache reuse is keyed by the complete input and configuration, including title. Copy/rebind unchanged vectors into the new generation without another API call.
- `embedding_jobs`: unique subject/generation/config work, state (`pending/running/retry/ready/failed/cancelled`), attempt count, next-attempt time, lease expiration, error code, and token reservation. Use transactional claims and recover expired leases. No network await inside a SQLite transaction.

| Event | Required behavior |
| --- | --- |
| Create | Save Markdown, update projection + FTS and enqueue jobs in one DB transaction after the file write. Worker embeds shortly afterward. File and DB cannot commit atomically; reconciliation repairs a crash between them. Report memory saved separately from indexing failure. |
| Patch | Immediately retire the old searchable generation, publish current lexical text, reuse identical canonical chunks, enqueue changed ones. Until ready, return lexical results rather than stale semantic claims. Publish a full new vector generation atomically after all required chunks succeed. |
| Move/rename | Path is identity: reconcile the old URI as absent and the new URI as present, including inbound-link rewrites. Preserve a move mapping for citations; reuse identical input vectors when eligible. Reprocess all rewritten files, not only the moved page. |
| Deprecate | Preserve the Markdown/history, exclude from default current-memory retrieval, and allow explicit historical search with status visible. Apply filters immediately; unchanged content vectors may remain stored. Do not silently relabel deprecated material current. |
| External deletion | Only a complete successful directory scan may establish absence. Cancel pending work, remove searchable FTS/vector/cache entries, and mark projection presence unavailable; retain evidence/history according to existing semantics. A failed mount/scan or parse error must never trigger mass deletion. |
| Parse failure | Preserve last-known history but mark the subject unavailable for current factual retrieval; surface degraded coverage. An old vector must not stand in for an unreadable new revision. |
| Reindex | Rebuild lexical projection and reconcile desired chunks with actual vectors. Unchanged input means zero embedding calls. Update FTS by subject transactionally; do not erase other source kinds from the shared FTS table. Reconcile file-derived links with an explicit origin marker, retaining independently authored edges. |
| Backfill | Dry-run inventory of eligible objects/chunks/token estimate first; then an explicitly authorized, resumable job with budget and progress. Skip unchanged vectors and deprecated/excluded material by default. Reads continue while coverage grows. |
| Model/dimension migration | Build a parallel config, evaluate, then atomically activate. Never compare vectors from incompatible configs. Keep the previous config for bounded rollback, then purge it deliberately. |
| Disable/forget | Disable stops jobs and query calls immediately. A separate authorized purge removes derived vectors/chunks/caches and follows backup retention; local deletion cannot retroactively undo a previous remote request. |

Integrate after every successful `OkfStore` mutation and in an explicit worker reconciliation pass, not just the UI refresh. Process-local callbacks need durable reconciliation for CLI edits, crashes, and multiple stores. Serialize projection work across server/worker using a DB lease or single owner. Workers recheck the current source/config/generation before dispatch and before committing a response; a late response from an older revision must be discarded, including after deletion. Searches must use the same eligible-source set for lexical and semantic paths.

## Local retrieval and hybrid ranking

| Implementation | Fit and tradeoff |
| --- | --- |
| Bun cosine scan over SQLite float32 BLOBs | Default. No new native dependency; exact and easy to validate. Normalize once and use dot product. Read/cache only vectors + IDs; retrieve prose only for finalists. Per-request cost is O(Nd); cache invalidation must observe DB generation across processes. |
| sqlite-vec scalar cosine on existing BLOBs | Small next step for native distance evaluation; still exhaustive. Adds extension packaging and connection initialization but avoids a new vector table initially. |
| sqlite-vec `vec0` (released v0.1.9) | More compact vector layout, exact KNN SQL and metadata filtering. Separate virtual-table migrations and synchronization are required. Development-branch ANN features need separate release/compatibility evaluation. |
| Separate local ANN service/library | Revisit only when measured workload exceeds exact retrieval's latency/memory budget. Adds another index lifecycle, backups, runtime, and approximate-recall evaluation. Unnecessary for a few hundred memories. |

The schema comment treating a swap to `vec0` as automatically providing ANN should be qualified in implementation. The latest non-prerelease returned by GitHub is **v0.1.9**; inspection of its source shows exhaustive chunk iteration. The inspected development commit **04d28bd** contains IVF/DiskANN implementations. Do not describe all sqlite-vec versions as lacking ANN, or assume development features are in the released package. [Release](https://github.com/asg017/sqlite-vec/releases/tag/v0.1.9), [released search implementation](https://github.com/asg017/sqlite-vec/blob/v0.1.9/sqlite-vec.c#L6624), [development source](https://github.com/asg017/sqlite-vec/blob/04d28bd21773981e2d266bbf6aa4efbd011eb4f6/sqlite-vec.c).

Cosine must be configured explicitly because the documented `vec0` default is L2. The docs also note SQLite-version differences for `LIMIT`; use explicit `k` in compatibility tests. [sqlite-vec KNN](https://alexgarcia.xyz/sqlite-vec/features/knn.html). No sqlite-vec binary was installed or tested for this spike.

The package has a documented `bun:sqlite` recipe using `sqliteVec.load(db)`. On macOS, Apple SQLite does not support loadable extensions; configure a compatible SQLite dylib **before opening any connection**. Do not copy an Intel Homebrew path onto Apple Silicon. Pin/test extension binaries for Darwin arm64 and deployed Linux architecture; load on every relevant connection, preserve FTS5/WAL/foreign keys, and run transaction/reopen tests. [Bun recipe](https://alexgarcia.xyz/sqlite-vec/js.html#bun), [Bun extension loading](https://bun.sh/docs/runtime/sqlite#loadextension).

**Initial thresholds:** below 10,000 active chunks, use Bun scan. Between 10,000 and 100,000, benchmark a packed cache/worker and sqlite-vec on the deployment host. Above 100,000, or earlier if local retrieval p95 exceeds 50 ms or cache RAM exceeds 128 MiB, reassess the backend; count alone does not mandate ANN. At 768 dimensions each vector consumes 3,072 raw bytes: 10k ≈ 29.3 MiB; 100k ≈ 293 MiB, excluding metadata/caches. 1536 and 3072 dimensions use 2× and 4× that space.

Local evidence: Bun 1.3.6, SQLite 3.54.0; FTS5 creation succeeded in an isolated in-memory DB. A synthetic packed-float32 dot-product/top-10 microbenchmark (768 dimensions, three warmups, 20 samples) produced p95 **0.61 / 5.09 / 27.26 / 55.39 ms** for **1k / 10k / 50k / 100k** vectors. It excludes SQLite decoding, real model vectors, filters, concurrent load, cold starts, and cloud calls; it is not a production benchmark or a relevance test. Never perform large synchronous scans on the request loop without measuring responsiveness.

Hybrid retrieval proposal:

1. Resolve exact URI/title/known alias matches locally. Preserve a bounded substring branch for partial names because FTS tokenization is not substring matching.
2. Query FTS5 with safe, escaped user terms and title weighting; retrieve top 50 eligible memories. FTS5 supports BM25 and snippets; lower BM25 scores rank better. Handle literal punctuation without exposing raw MATCH syntax. [SQLite FTS5](https://www.sqlite.org/fts5.html).
3. Embed the query under the active configuration and scan all eligible vectors, not only lexical candidates. Gather top 50 distinct memory candidates; use the best matching chunk per memory so long pages do not dominate.
4. Fuse document ranks using reciprocal rank fusion, initially `sum(1 / (60 + rank))`; then apply a deterministic exact-title/URI preference and stable tie-breaking. The fusion constant and candidate counts are design defaults to tune. Never add raw cosine scores to BM25 values.
5. Return 10 results with matching excerpt, URI, source hash, contributing channels, status/staleness, and provenance pointers. Read the actual memory before answering. Scores are relevance signals, not confidence that a fact is true.

If disabled, offline, quota-limited, incomplete, or query embedding fails, return lexical results with `mode: lexical` and a reason/coverage field. Cache query vectors briefly by query + complete config; cached vectors do not bypass current-source filtering. Embedding-only retrieval cannot reliably determine that no relevant memory exists, so calibrate abstention using negative examples rather than a universal cosine cutoff.

## Interface for the companion dream workflow

Proposed contract, independent of storage backend:

```ts
type NeighborRequest = {
  subjectId: string;
  expectedSourceSha256: string;
  configId: string;
  limit: number; // default 20, distinct memories
  excludeSubjectIds?: string[];
};
type NeighborResult = {
  configId: string;
  generation: string;
  status: "ready" | "pending" | "unavailable";
  coverage: { readySubjects: number; eligibleSubjects: number };
  candidates: Array<{
    subjectId: string;
    uri: string;
    sourceSha256: string;
    status: string;
    stale: boolean;
    score: number; // document/document cosine, not query retrieval confidence
    supportingPairs: Array<{
      sourceChunkId: string;
      targetChunkId: string;
      excerpt: string;
      fieldIds: string[];
    }>;
  }>;
};
// knowledgeNeighbors(request): Promise<NeighborResult>
```

Use stored document vectors to shortlist local neighbors, exclude self/deprecated/unavailable sources, and group by target memory using maximum chunk-pair similarity initially. This document-to-document use is a heuristic candidate generator and needs its own evaluation; query/document retrieval performance does not validate it. If a later experiment uses symmetric similarity/clustering embeddings, create a distinct configuration and account for extra paid work. Do not mix representations silently.

Publish an idempotent `memory.embedding.ready` event containing subject, source hash, configuration, and generation after commit. The dream consumer can process only changed memories and their top neighbors instead of running an O(N²) all-pairs scan nightly. Missing vectors return `pending`; this interface never embeds text remotely as a side effect. The consumer records a candidate pair by both source hashes, re-reads both original pages, and checks hashes again before proposing any change.

For the user's example, a page about Dad, a page of his preferences, and a page listing movies he liked may become neighbor candidates. Matching movies is insufficient evidence that two pages describe the same person; include explicit names/relationships, existing links, and sources. Candidate relations should distinguish “about the same person,” “liked this movie,” and “possibly duplicate.” The companion workflow owns proposals, conflict preservation, and authorization for links/consolidation. This service supplies evidence and candidates only.

## Validation and staged implementation

1. **Local foundation:** implement config/chunk/job schemas, FTS writer, eligibility/presence reconciliation, and injected fake embedding provider. Test create/update/move/deprecate/delete, parse/mount failure, restart after file-write/DB gap, expired job leases, duplicate events, partial backfills, out-of-order responses, and model migration. Acceptance: no deleted/old-generation result; identical reindex causes zero provider calls; lexical search works with embedding disabled.
2. **Authorized synthetic Cloud check:** explicitly approve a small spend cap and project/location. Use invented text only to verify the locked JS SDK on Bun 1.3.6, auth, endpoint, vector count/dimensions, normalization, task formatting, token/truncation behavior, timeout handling, and selected SKU. Compare Embedding 2/001 at 768 and 1536; keep 3072 only if quality justifies its local cost.
3. **Relevance evaluation:** start with 50–100 human-labeled synthetic/redacted queries, then an approved representative memory sample. Compare current substring baseline, FTS, vector-only, and hybrid. Include synonyms, exact names/movie titles, multi-hop family references, negative/no-answer queries, multilingual examples, stale/deprecated memories, conflicting facts, and pronoun ambiguity. Measure Recall@10, MRR@10/nDCG@10, exact-name success, unsupported-answer rate, coverage, local/API p50/p95, and cost per query/indexed chunk. Initial gate: improve paraphrase Recall@10 by at least 15 percentage points without reducing exact-name success; zero eligibility/freshness violations. Thresholds should be revised with dataset size and confidence intervals.
4. **Authorized backfill and rollout:** dry-run inventory/cost review, then resumable bounded backfill and shadow retrieval. Activate hybrid only after the evaluation gate; expose pending/failed counts and oldest job age. Keep lexical mode as instant rollback. No background retry may spend beyond the configured cap.
5. **Dream/backend follow-up:** validate neighbor precision@20 on related/unrelated memory pairs independently; require source evidence for proposed links and protect against false merges. Benchmark sqlite-vec on actual Mac/Linux targets only if exact scans breach the budget. Any ANN replacement must measure recall against the exact-scan oracle.

Work proposed here belongs under `src/okf/`, `src/db/okf/`, a new embedding/retrieval adapter module, worker startup, and the two tool groups, with migrations and focused tests. This spike adds only this report.

## Uncertainties to resolve before activation

- Cloud docs disagree in places: Embedding 2 GA versus Preview pricing label, generic versus endpoint-specific request limits, and older SDK samples mixed into current pages. Treat the selected endpoint/model behavior and billing SKU as explicit smoke-test outputs.
- The existing locked SDK's Bun/Embedding 2 behavior, project permissions, account-specific retention, effective quota, and location policy were not tested. No real API call was authorized here.
- Real corpus count/chunk distribution, retrieval relevance, and deployment-host latency are unmeasured. Microbenchmark timings cannot determine final scale thresholds.
- Existing projection deletion/link cleanup and cross-process write/reindex coordination need implementation decisions before claiming complete lifecycle support.
- Confirm whether saved-memory feedback should merely show `pending` or optionally wait a short bounded interval for embedding readiness. The recommended default is durable asynchronous work with immediate local lexical visibility.

All external references above are primary vendor/project documentation, accessed 2026-09-12. Several Vertex AI documentation URLs now redirect to Gemini Enterprise Agent Platform branding; API selection remains explicit in the design.
