# OKF dream workflow: evidence-backed links and consolidation

Date: 2026-09-12. Status: research/design spike, not implemented.
Checkout inspected: `bbb927ea71b1b0ba3d6ec0b29b27d48ebeab1114`.

Follow-up planning: [Shared write history and supported undo](./write-history-undo-plan.md)
defines the prerequisite for applying dream mutations. Its shared write executor,
versioned adapters and grouped history replace the need for a dream-only journal;
this spike's identity, provenance, conflict and detail-retention gates still apply.

## Recommendation

Build a bounded background workflow that **proposes useful links and a canonical entity overview while retaining the original memories**. For the dad/preferences/movies scenario, organize memories around a Dad page with cited sections and links to the detailed records. Being about the same person is sufficient reason to consider a link; it is insufficient reason to merge the pages. Merge only redundant records of the same assertion or event, after showing what survives and obtaining approval. Use deprecation with a successor link instead of deletion.

Call this “Memory reflection” in technical interfaces; “Dream” can be its user-facing name. Its mechanisms are retrieval, entity resolution, evidence-grounded synthesis, duplicate detection, and reviewed maintenance. This is external memory processing, not model training or a claim about biological dreaming.

The first implementation should produce proposals only. A second stage can apply approved link/overview changes once provenance, stale-proposal protection, projection consistency, and undo work. Keep automatic merging out of the initial release. A provider-neutral neighbor interface connects this design to the separate Gemini embeddings/local vector search spike; this document does not choose another embedding provider.

This investigation read repository code and public sources. It did not inspect an actual memory bundle, call paid models, send private memories to a new service, change memories, or create a live schedule. No applicable `AGENTS.md` was found in this checkout or its inspected ancestor paths. Counts mentioned in code comments describe earlier data and are not measurements of the user's current memories.

## What research supports

These are primary research or maintainer sources. The design below adapts their mechanisms; their evaluations do not establish that unattended merging is safe for Solenoid.

| Source | Established mechanism or reported result | What to take, and its limit |
| --- | --- | --- |
| Park et al., **Generative Agents**, UIST 2023, §§4.1–4.2, 6.5 | Retrieves memories using relevance, recency, and importance; periodically generates higher-level reflections citing supporting records. Ablations evaluate simulated behavior. | Use cited synthesis alongside original records. The paper also reports fabricated embellishments; behavioral believability is not a factual-integrity benchmark. Its importance threshold is an experimental choice, not a recommended Solenoid setting. [Paper](https://arxiv.org/html/2304.03442v2) |
| Xu et al., **A-Mem**, 2025, §§3.2–3.3 | Uses embedding similarity to retrieve candidate notes, then model reasoning to generate links and evolve memory descriptions. | Closest architectural match to neighbor-based linking. Retrieval nominates candidates; a second decision determines whether a meaningful connection exists. Reported QA improvements do not validate destructive page merges or identity precision. [Paper](https://arxiv.org/html/2502.12110v1) |
| Rasmussen et al., **Zep**, 2025, §§2.2–2.3 and appendix | Separates entity resolution from fact resolution; records episode connections and both system and real-world temporal information. Detects potentially contradictory edges. | Borrow evidence lineage and time-aware assertions without adopting its service or graph database. Solenoid should retain unresolved contradictory accounts rather than automatically deciding which account wins. [Paper](https://arxiv.org/html/2501.13956v1) |
| Lin et al., **Sleep-time Compute**, 2025 | Studies offline computation over context before future questions arrive, including amortizing work over related queries. | Supports moving useful preparation outside interactive latency. Its reasoning-task results do not measure memory consolidation, and extra background compute is not automatically cheaper overall. [Paper](https://arxiv.org/abs/2504.13171) |
| Letta maintainers, **Sleep-time Compute** | Describes background agents modifying the primary agent's memory and preparing information from documents. | A concrete product pattern, not a standardized “dream” protocol or independent proof of reliability. [Maintainer article](https://www.letta.com/blog/sleep-time-compute/) |
| LangMem maintainers, **Core Concepts** | Distinguishes semantic collections/profiles and episodic memories; supports memory extraction and consolidation outside the response path. | Keep overview/profile and episodic detail as complementary representations. The documentation supplies an integration pattern, not a safety guarantee. [Documentation](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) |

“Reflection,” “background memory formation,” and “sleep-time compute” have specific descriptions in these systems; they are related but not identical. Here, consolidation means improving organization and retrieval, with compression only where demonstrated to preserve meaning. All limits and release gates below are proposed Solenoid choices, not numbers established by these papers.

## Repository reality and integration gaps

Repository links below are relative to this report so they survive another checkout.

| Area | Verified implementation | Consequence |
| --- | --- | --- |
| Source of truth | [OKF store](../src/okf/store.ts), [concept parsing](../src/okf/concept.ts): Markdown with YAML; concept ID is its path. Unknown frontmatter survives parsing/patching. | Write accepted knowledge to files and rebuild projections. Avoid renaming canonical pages casually: URI-derived object and field IDs change with paths. |
| Writes | Store exposes create, patch, move, deprecate; body operations include section edits and whole-body replacement. Create requires sources for nonhuman actors by default. Writes stamp the bound actor/time; agents cannot write `verified`. `sources` patches replace the whole list. | Prefer narrow section edits; explicitly union source lists. There is no native merge operation, revision precondition, or batch approval. |
| Atomicity/history | [Atomic writer](../src/okf/bundle.ts) uses temporary file plus rename. The store serializes operations per instance; index and log updates are separate writes. Moves write a destination, remove the source, and update other files sequentially. | Per-file atomic replacement is not crash-atomic multi-file mutation, nor a lock across server/worker instances. `log.md` records events, not reconstructible before-images. |
| Projection | [Reindexer](../src/db/okf/reindex.ts), [schema](../src/db/schema/okf.ts), [refresh](../src/db/okf/refresh.ts) project objects, fields, conflicts, links and sync state. Changed field values get new IDs; missing fields are retired during normal reindex. | This preserves old field rows in an existing DB, but a full rebuild cannot reconstruct lost source text from a prior file version. Archive/journal evidence outside a disposable projection. |
| Facts/provenance | [Field extractor](../src/db/okf/fields.ts) recognizes certain bold label/value lines, not arbitrary prose. The indexer assigns each field provenance from the page's entire `sources` list and `assertedAt` from page `generated.at`. Any recognized user author makes all extracted fields `user`. | A mixed summary can incorrectly present an inference as something the user said. Updating a link also changes the page timestamp used as assertion time. Do not treat these columns as claim-level truth or event time. |
| Verification | [Trust derivation](../src/okf/trust.ts) recognizes any human verification event; patch retains old `verified` while restamping generated time. Reindex does not populate `verifiedAt` in its object upsert. | An old human review is not confirmation of new summary text. Review must bind to content hash; accepting organization must not silently verify all its claims. This needs deliberate UI/projection handling before synthesis is applied. |
| Conflicts | Extractor flags different values sharing a case-insensitive label on one page. | It misses prose and cross-page contradictions and can mistake valid list values for conflicts. It does not reason about entity, event, or overlapping time. |
| Links | [Store link parser](../src/okf/links.ts) resolves relative/root paths. Reindex uses a separate regex helper, `relatedConcepts`, over the whole body despite its Related-section comment; it strips a leading slash but does not resolve relative paths. It inserts `references` edges without reconciling removed edges. | An added/removed Markdown link can disagree with the UI graph. Unify extraction and reconcile only projection-owned edges before apply/undo. Initially render proposed links as `/memories/example.md`, but that alone does not solve stale edges. |
| Recall | Store search and [knowledge tools](../src/tools/knowledge.ts) use case-insensitive substring matching. The knowledge tool scans projected objects/fields. [Search schema](../src/db/schema/search.ts) declares embeddings, but references under `src`/`scripts` only define the table. OKF reindex does not populate FTS. | Do not claim semantic retrieval is already available. Proposal experiments can use a stub or lexical/graph neighbors, explicitly labeled. Vector readiness is a dependency. |
| Workflow execution | [Catalog](../src/workflows/catalog.ts), [registry](../src/workflows/registry.ts), [runner](../src/workflows/runner.ts), [scheduler](../src/workflows/schedule.ts), [worker](../src/worker.ts): database schedules, restricted RRULE-to-cron translation, timezone/jitter, 30-second schedule reload, run records and cancellation. Worker skips a scheduled run already in flight; manual concurrent runs remain possible. | Add a catalog entry and registry implementation for `okf-reflection`; use existing scheduling, plus a bundle lease for this workflow. A row without an implementation cannot run. |
| Approval | [Permissions](../src/workflows/permissions.ts) resolve workflow rule, global rule, then `ask`; OKF tool names map to `okf.write`. `ask` persists a deferred call and feed decision. [Deferred execution](../src/workflows/deferred.ts) rechecks permission and schema. The gate is in [agent tool dispatch](../src/core/rawAgent.ts), not inside `OkfStore`. | Reuse the review surface but extend it for a whole proposal. Direct store calls need an explicit gated application boundary. Changing a capability to allow can auto-settle pending calls: stale-hash and proposal-specific checks must still run. |

## Choosing work and finding candidates

Use incremental, bounded passes instead of an all-pairs nightly rewrite.

1. Snapshot file hashes, parsed content and known link targets; record parse errors. Keep proposals outside the OKF bundle so a proposal is never indexed as accepted knowledge. Track a per-file processed hash, not just a timestamp watermark, to catch hand edits and equal-time changes.
2. Select up to **20 seeds per pass**: approximately 12 new/semantically changed pages, 4 unresolved identity/conflict or user-requested organization candidates, and 4 older underlinked pages chosen by deterministic rotation. Unused quota can move to another pool. User-pinned do-not-touch pages may be read as evidence but get no edits. Deprecated pages participate only as historical evidence/possible successor targets.
3. Separate observation-body changes from generated overview/link changes. Do not make last night's link patch a new episode that triggers another night of reflection. Periodically sweep old records anyway; exclude the workflow's own accesses from any popularity signal. Access frequency can suggest usefulness, but never justify forgetting rare personal detail.
4. For each seed, union top **12 distinct-page vector neighbors**, lexical/alias matches, explicit entity references, and existing one-hop links. Keep exact entity matches even when vocabulary differs. Use reciprocal-rank fusion for candidate ranking so unlike lexical/vector scores need not share a scale; record each retrieval reason. Cap/deduplicate evidence into at most **10 groups**, initially at most **6 pages per group**. Oversized groups are marked incomplete and split by event/topic; they cannot support a claim of complete consolidation.
5. Load authoritative full text for the selected pages and relevant cited originals; a vector chunk is a locator, not sufficient evidence for merging. Apply a context budget. If essential evidence cannot fit, defer that action rather than silently dropping qualifiers.
6. Rank proposals by concrete retrieval/navigation benefit, new evidence, ambiguity and likely review effort. Return at most **5 proposals** per pass, including explicit “keep separate” decisions in the internal manifest. No universal cosine threshold means “same person” or “duplicate”; tune retrieval recall on fixtures and validate identities independently.

Cache no-op and rejected pair/group decisions by evidence hashes and policy version. A new relevant page or changed entity assignment invalidates dependent caches even if the seed itself is unchanged. Keep a durable “different entities”/“do not combine” decision until evidence changes or the user revisits it; do not repeatedly ask the same question nightly.

### Neighbor contract with the embeddings spike

Illustrative interface only; it is not implemented:

```ts
type NeighborRequest = {
  conceptId: string;
  expectedContentSha256: string;
  limitPages: number;
  snapshotId: string;
};
type NeighborResult = {
  status: "ready" | "partial" | "unavailable";
  indexVersion: string;
  embeddingSpace: { model: string; dim: number; normalization: string };
  hits: Array<{
    conceptId: string;
    contentSha256: string;
    rank: number;
    score: number;
    chunks: Array<{ ordinal: number; textSha256: string; locator: string }>;
  }>;
  skipped: Array<{ conceptId: string; reason: string }>;
};
```

The embeddings work owns model selection, chunking, versioning, vector update/removal on file lifecycle changes, and local neighbor performance. This workflow owns candidate selection, identity judgments and proposals. Agree on whether embedded content excludes generated Related/overview sections to avoid reinforcement; return actual source hashes even if embeddings use normalized text hashes. Reject incompatible vector spaces and stale hits, collapse chunk hits by page, and require a freshness/coverage report. Changed files awaiting vectors can use lexical candidates with an explicit partial-coverage result; they are not marked fully processed. Never embed a private query through a new service as an implicit fallback. A seed vector lookup should reuse indexed vectors where possible.

Companion-spike coordination on 2026-09-12 proposes Google Cloud Gemini embeddings stored locally, initially 768-dimensional exact cosine scans plus FTS5, with durable post-write jobs and reconciliation for hand edits, moves and deletions. These are provisional recommendations, not existing capabilities. This design is compatible: document-vector neighbors can populate the contract directly, with a single document locator when chunking is absent; hybrid lexical retrieval can use FTS5 once populated. Do not assume approximate search is needed or that a vector score is merge authorization. The companion also independently identified stale objects and links in reindexing, reinforcing the reconciliation prerequisite.

## Entity identity and action policy

Maintain separate answers to: **Does this mention the same real-world entity? Does it express the same fact/event? Would combining its presentation help?** A similarity cluster answers none of those questions alone.

An identity proposal records entity type, mention/speaker scope, candidate canonical page, supporting spans, competing identities and an outcome of `same`, `different`, or `uncertain`. Strong anchors are a previously confirmed canonical reference, explicit identity statement, or trusted stable source identifier. Names, tags, genre preferences and embeddings are supporting retrieval signals. “Dad” means the speaker's dad: a message quoting another person saying “my dad” must not resolve to the user's father. Different people liking the same movie is a negative identity fixture. A high model confidence score cannot substitute for evidence, and similarity connected components must not create transitive identity merges.

| Situation | Proposed action |
| --- | --- |
| Same person, distinct preferences, films or events | Link to the canonical person page and add a cited overview entry; retain detail pages. |
| Different entities, meaningful explicit relationship | Add a labeled relationship link with evidence; preserve each entity. |
| Shared topic but no useful relationship | Usually no change. Optional topic overview only when it helps a concrete question. |
| Same entity and demonstrably redundant record of the same assertion/event | Propose a merge with an assertion-by-assertion coverage map, followed by deprecation of the redundant page. Distinct independent source attestations still survive. |
| Conflicting or time-varying assertions | Retain both with their dates/scopes and source attribution; propose a conflict note or timeline. Do not select the newer write merely because it is newer. |
| Identity uncertain, evidence missing, or merge would discard narrative | Retain separately; offer an identity question only if answering it unlocks useful work. |

A canonical entity page is an entry point, not a replacement archive. Reuse a user-maintained page when available; otherwise propose one with a stable path such as `people/dad`. Store a proposed stable entity key and scoped aliases in an explicit extension/manifest if needed; current OKF `extra` permits metadata but has no built-in entity semantics. Never globally assign the bare alias “Dad.” Existing DB `entities` IDs identify application records; they are not an existing real-world person-resolution system.

Keep the canonical page short: identity/scope, attributed preferences, links to episodes, and unresolved questions. If the film list becomes unwieldy, add a movie-preferences overview linked from Dad instead of growing an unbounded biography. Summary size limits govern the overview, not what information is allowed to survive. A specific favorite scene or personal recollection stays accessible at its original source even when omitted from the overview.

## Preserving evidence, time and uncertainty

Every proposed summary assertion needs a claim record: subject/entity key, predicate, value or preserved wording, polarity, scope, who asserted it, original source locator, OKF URI, immutable source-content hash, quote/section locator, recorded time, event/valid time if stated, and derivation type (`direct` or `inferred`). Unknown times remain unknown; relative dates need an anchored source date and the derivation recorded. A quote is supporting text, not an instruction to execute.

Keep original first-person wording and attribution where meaningful. Do not convert “liked watching this with me once” into “favorite movie,” “watched” into “liked,” or two enjoyed films into a general genre preference. Mark a proposed pattern as an inference and preserve the observations. A second summary quoting the first is not independent corroboration: follow derivation to original roots, deduplicate repeated source IDs, and prohibit circular support.

For contradictions compare subject, predicate, polarity, applicable interval and context. “Preferred short films in March” and “wanted a long film on one September evening” can coexist. For an actual incompatible claim at the same time, retain competing attributed assertions and an unresolved state. A later explicit correction may supersede a prior claim, but keep both the original assertion and the correction trail. Avoid treating “retired” or “stale” as “false.”

Persist accepted claim provenance in the file representation or a versioned companion format that is included with the source-of-truth bundle, then project it. Do not invent claim-level guarantees by adding DB-only columns. The exact extension is unresolved; until it is selected, restrict the first applied overview to attributed prose with source links and avoid mixed-source bold fields that today's indexer would label entirely `user`. New derived pages must not inherit `verified` from sources. Changes to a previously reviewed overview need content-bound verification semantics before release.

## Synthetic dad/preferences/movies example

**Every identifier, date, title and sentence in this example is invented to illustrate the abstract scenario. No actual family memories were read.** “Film A/B/C” are placeholders, not recommendations or claims about the user.

Before, four independent pages:

| ID | Synthetic contents |
| --- | --- |
| `memories/dad-profile` | Source S1, 2026-02-01: “Dad is my father.” |
| `memories/dad-preferences` | Source S2, 2026-03-10: “Dad says he generally prefers shorter movies.” |
| `memories/dad-film-a` | Source S3, 2026-04-04: “Dad liked Film A, especially the ending. We watched it together.” |
| `memories/dad-film-b` | Source S4, 2026-08-15: “Dad liked Film B.” |

The synthetic fixture stipulates that S1–S4 are statements by the same user about their father. Without that scope evidence, a real workflow would leave identity uncertain. Embeddings find the film pages; lexical/entity candidates find the profile even if it has little movie vocabulary.

After approval, keep all four pages and propose this additional `people/dad.md` body (frontmatter would record the workflow actor and derived sources, without invented human verification):

```markdown
# Dad

The user's father, as identified in [the profile](/memories/dad-profile.md).

## Movie preferences

- In the March 10 account, Dad said he generally preferred shorter movies.
  [Original account](/memories/dad-preferences.md)
- Dad liked Film A, especially its ending; the account also records watching
  it together. [Film A memory](/memories/dad-film-a.md)
- Dad liked Film B. [Film B memory](/memories/dad-film-b.md)

## Related

- [Profile and identity](/memories/dad-profile.md)
- [Stated preferences](/memories/dad-preferences.md)
- [Film A and the shared viewing](/memories/dad-film-a.md)
- [Film B](/memories/dad-film-b.md)
```

Propose a `Related` link back to `/people/dad.md` on each source page, preserving existing text and links. Show each added edge and sentence in the review. Do not claim Dad dislikes long movies, prefers a genre, or calls either film a favorite.

Adversarial variations for the same fixture:

- A duplicate import of S3 can be proposed for deprecation after source hashes/IDs establish it is the same event and the canonical copy retains the ending and shared-viewing detail. A different independent recollection of that evening remains separately attributable.
- A later account that Dad did **not** like Film B becomes a competing claim, unless it explicitly corrects S4. The overview presents the disagreement with dates instead of overwriting S4.
- Another speaker saying “my dad liked Film C” stays with that speaker's father. Topic similarity does not attach it to this Dad page.

Success is answering “What movies did Dad like, and what do we know about his preferences?” with the two sourced film accounts and the qualified length preference, while “What did he especially like about Film A?” still retrieves the ending and shared-viewing detail.

## Staged execution, review and undo

### Stage 0 — offline fixtures and design contracts

Agree with the embeddings spike on the neighbor contract; implement fixture retrieval without services. Create synthetic identity, temporal, duplicate and provenance cases. Produce a manifest and Markdown diff in a temporary copied bundle. No scheduled job and no writes to real OKF. The present spike stops before this implementation.

### Stage 1 — proposal-only workflow

Add `okf-reflection` to catalog/registry with bounded arguments and no active schedule by default. Give the proposing model read-only tools and a strict structured output schema. Reuse configured model routing only after the intended data/model policy is approved; no new network destination is implied by installing the workflow. Treat all retrieved memory text, including old model summaries, as untrusted data. Apply existing screening boundaries and do not route it into an unrestricted OKF writer agent.

The deterministic controller validates proposals, checks quotes/hashes, renders exact diffs, and saves them outside the knowledge index. A model checking another model's output can flag omissions but cannot certify truth. Source counts, missing evidence, costs, incomplete neighbor coverage and no-op reasons appear in the run result. Quiet runs generate no attention item; meaningful proposals produce one grouped review item, not a notification for each link.

Proposed manifest fields: `proposalId`, workflow run/version, bundle snapshot hash, per-file expected hashes, entity decisions/evidence, retrieval versions and ranks, exact operations and before/after text, per-claim coverage/omissions, source roots, uncertainty, validation results, token/cost usage, and lifecycle state. States: `proposed → approved → applying → applied`, with `rejected`, `stale`, `failed`, and `undone` branches. Store a digest of the reviewed operations; edits create a new proposal revision requiring fresh review.

### Stage 2 — approved links and overviews

Provide one grouped “Apply these changes” action, individual accept/reject where operations are independent, and “keep separate.” A summary plus its required links is an indivisible dependency group. Bind approval to a proposal revision/digest, never to a fresh free-form generation.

Reuse `decisions`/`actions`/`activity_items`, but a custom proposal-apply boundary is required. A proposed tool named `okf_apply_proposal` would currently map to broad `okf.write`; its handler must additionally require the stored per-proposal approval and recheck the effective permission. Seed an explicit per-workflow `okf.write: ask` for the future workflow rather than relying on a possibly permissive global rule. A broad allow or automatic deferred-call settlement must not count as approval of an unreviewed merge. Separate future permissions for links/synthesis/merges require an explicit capability mapping change, not merely invented dotted names.

Before any mutation: acquire a bundle-wide lease honored by every participating writer; check cancellation, effective permissions, decision state, all expected hashes and target nonexistence for creates. Stale evidence or intervening edits cause a new proposal; do not silently rebase an approved summary. A lease among application writers cannot prevent arbitrary external editors, so recheck hashes immediately before replacement and detect divergence during recovery.

Application requires a durable journal with before-images, expected after-images, operation order and recovery state. Use the store's invariants, including actor stamps, source preservation, index regeneration and log entries. A staged temporary bundle can validate the whole result before mutation. If a crash interrupts commit, recovery completes or reverses journaled operations before the UI treats the proposal as applied. Do not claim ACID behavior across Markdown and SQLite: mark the projection dirty during apply and reindex after file commit, retrying projection failure without reapplying the proposal.

Before this stage ships, unify link extraction, remove obsolete projection-owned links, and reconcile removed/moved objects so undo does not leave phantom DB records. Preserve unrelated evidence/manual links. Make historical verification explicit for changed content. Apply/reindex success must be reflected separately in run status.

Undo uses journal before-images only when current files match this proposal's after-hashes; intervening user changes require a reviewed reverse patch. For newly created pages with no later edits/references, remove only those transaction-created artifacts through a dedicated rollback path, then reconcile projections. Otherwise retain the page with a reversal/deprecation note and offer conflict-aware undo. Preserve append-only audit events; record a new undo event rather than erasing history. Rebuild indexes and invalidate/recompute changed vectors. Backup/journal retention is a product decision, but it must be long enough to cover the offered undo window.

### Stage 3 — reviewed duplicate consolidation, then optional bounded automation

Only after the integrity gates pass, support copying all unique assertions/source roots into an appropriate retained record and deprecating a redundant page with its body intact and a successor link. Existing inbound references remain meaningful. Do not use move as a merge substitute or delete episodic sources merely to reduce page count.

A future daily pass at a user-selected quiet hour can use the existing daily RRULE, configured timezone and jitter; no such row is created by this spike. Skip unchanged input, cap pending proposals, use exponential retry for transient failures, persist checkpoints and prohibit overlapping passes with a durable lease. Cancellation stops generation and new commits; once commit begins, finish/recover the journal before releasing the lease. After enough reviewed data, a separate user opt-in might permit simple evidence-backed links. Keep merging and uncertain entity resolution under review.

## Evaluation and operating budget

Build a labeled synthetic suite first: approximately 80 candidate pairs across confirmed same-entity/different-event, true duplicate, same-topic/different-entity, quoted “Dad,” temporal changes, contradiction, independent corroboration, and malicious embedded instructions; plus at least 20 multi-page groups and 30 answerable/unanswerable questions. Include rare narrative details and mixed user/inferred provenance. Later use a user-approved private local fixture set to measure realism; synthetic results alone are not production evidence.

Compare with the same answer model, context budget and question set: (A) current substring retrieval, (B) vector neighbors alone, (C) lexical/vector/graph retrieval plus proposed links, (D) C plus overview. Evaluate before/after questions and ablate identity checks. Score retrieval separately from generated-answer quality so a better model does not hide missing evidence.

| Criterion | Proposed release gate / measurement |
| --- | --- |
| Candidate recall | At least 95% of labeled useful pairs appear within the bounded candidate pool; report by identity/topic/time category and tune limits if needed. |
| Entity safety | Zero false same-entity decisions in the adversarial fixture gate; report precision and abstention separately. Zero observed failures in a small set is not proof of zero risk. |
| Useful links | At least 95% reviewer precision; report useful link recall, duplicate edges and navigational clutter. |
| Summary grounding | Every new factual assertion has matching evidence and correct attribution/polarity/time; zero unsupported strengthened claims in the gate. |
| Detail retention | Every annotated unique assertion and narrative detail remains retrievable in retained sources; 100% coverage map for any merge. A shorter summary is not itself success. |
| Temporal/conflict fidelity | Preserve all labeled unresolved disagreements; no current fact inferred solely from write recency, and no preference treated as timeless without support. |
| Retrieval benefit | Measure evidence recall, citation correctness and answer accuracy, especially multi-hop and detail questions. Require no regression on detail/unanswerable subsets and a predeclared improvement target of 10 percentage points on organization questions. |
| Repeatability | Identical evidence/configuration yields a no-op after apply; no duplicate proposals on restart, no repeated questions after rejection, no summary-as-new-evidence loop. |
| Integrity/recovery | Fixture reindex agrees with Markdown after create/link removal/deprecation/undo; injected failures at each write boundary recover, stale approvals refuse, concurrent changes survive, and replay does not reapply. |
| Review burden | Track acceptance, edits needed, rejection reasons, pending backlog and median review time. Initial usability target: under two minutes per grouped proposal; cap review queue at ten. |

Repeatability means stable inputs, recorded outputs, deterministic application and idempotent replay. It does not mean an LLM will reproduce identical prose. Pin model identifier, prompt/schema/policy versions, retrieval space, candidate order, snapshot, timezone and all sampled outputs. Low temperature alone is insufficient. Cache accepted/no-op outcomes by evidence dependency hash; rerun only when evidence or policy changes.

Initial per-pass ceilings: 20 seeds, 240 vector neighbor hits before deduplication, 10 groups, 5 review proposals, one proposing call per group and at most one checking call per actionable group, 40,000 total input tokens and 8,000 total output tokens across calls/retries, and five minutes wall-clock time. These are experiment limits, not measured runtime. Token caps override group counts; large evidence sets defer. A pass with no changes should use zero model calls. Perform one projection refresh/snapshot, not a full reindex for every seed.

Cost accounting is provider-independent:

`pass cost = input_tokens × input_price/1e6 + output_tokens × output_price/1e6 + incremental_embedding_cost + local_compute/storage_cost`

At the proposed ceilings this is `0.040 × input_price + 0.008 × output_price`, with prices expressed per million tokens, plus the other terms. Thirty capped passes multiply those generation terms by 30. Track retry/checker tokens within the same ceiling. The adjacent spike owns verified embedding prices and incremental re-embedding volume; do not assume background processing is free or claim a dollar cost without selecting and checking the actual generation route. Cache immutable evidence; do not repeatedly embed unchanged pages after link-only edits if the agreed embedding representation excludes links.

Log IDs, hashes, stage timings, counts, usage and validation outcomes by default; avoid duplicating full personal source text into general-purpose logs/traces. The runner currently records workflow output in tracing, so return proposal identifiers/summaries appropriate for that destination rather than unrestricted memory bodies. Keep full review evidence in the protected local proposal store.

## Decisions and implementation order

Recommended defaults are concrete enough for a follow-up implementation; none requires an answer merely to finish this research spike.

1. **Provenance format:** choose a versioned file-level claim extension or bundled companion format, with stable claim IDs and original source/version locators. Recommended: explicit claim records with readable cited prose, avoiding a DB-only truth layer.
2. **Canonical identity:** choose whether to add stable entity keys now or start with confirmed canonical-path references. Recommended: stable keys in an OKF extension, scoped aliases and no automatic identity union; avoid path moves initially.
3. **Trust semantics:** define how review binds to a content version and distinguish approval of organization from verification of factual accuracy. Required before updating previously reviewed summaries.
4. **Provider/data budget:** reuse an authorized configured generation route, with per-pass ceilings and an explicit private-memory data policy; keep embedding selection with the adjacent spike.
5. **Apply/undo infrastructure:** decide journal location/retention and coordinate all writers on locking. Required before applying multi-file proposals. Proposed retention: 30 days minimum, subject to user preference and storage policy.
6. **Cadence and autonomy:** start manual proposal-only, then opt-in daily proposals. Evaluate approved links before considering automatic links. Merges remain individually reviewed.

Suggested implementation sequence: (1) fixtures and neighbor adapter contract; (2) proposal-only controller and run artifact; (3) provenance/verification and projection fixes; (4) grouped review with hash-bound approval, journal, recovery and undo; (5) reviewed canonical overviews/links; (6) duplicate-only consolidation trials. Each phase can ship independently with the later mutation modes disabled. The existing OKF architecture is sufficient to host this approach; replacing it with a new memory service is unnecessary for the spike's objective.
