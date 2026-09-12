# Shared write history and supported undo

Date: 2026-09-12. Status: proposed design and implementation plan; no production changes.
Inspected checkout: `bbb927ea71b1b0ba3d6ec0b29b27d48ebeab1114`.
Companion: [OKF dream workflow spike](./okf-dream-workflow-spike.md).

## Recommendation and scope

Build one shared write-history service, then add reversible adapters for specific operations. Every supported entry point should record **who requested a write, what actually happened, what resources changed, and whether a supported reversal is available**. A history entry alone must never imply that a write can be undone.

The user should be able to open a logical change such as “Organized Dad's movie memories,” inspect its steps, and undo eligible steps or the group. An internal SQL statement or individual file rename is not necessarily a safe undo unit. Dependencies determine which steps can be reversed independently. Restoring yesterday's state must preserve today's edits: the default is a revision-checked inverse with a preview, followed by a new history entry. Divergence produces a reviewed reverse patch or a refusal, never a silent overwrite.

Deliver in this order:

1. Broad, durable write history with accurate outcomes and explicit unsupported/irreversible labels.
2. Conditional undo for a small set of app-owned local mutations, using tested adapters.
3. Recoverable grouped OKF operations and their undo, then dream mutations after the original spike's provenance, identity and conflict prerequisites.

This is planning only. No actual memories, schedules, notifications, external pages, deployments or other implementations are changed. Screenshot collections/Notion import, Pushover reminders and Gemini embeddings are active neighboring work described by the originating task. Their new implementation code is not present in this checkout; the examples below specify integration contracts rather than claiming those adapters already exist. Existing screenshot ingestion, source storage and the unused embeddings schema are present. No user decision is needed to continue the plan: proposed defaults appear below, with alternatives at the end.

## What exists and what it does not guarantee

| Existing seam | Verified behavior | Implication |
| --- | --- | --- |
| [`WriteJournal` in rawAgent](../src/core/rawAgent.ts) | Its entire state is `{ started: number }`, scoped to an agent invocation. It increments before dispatch and suppresses switching model routes after any write starts. | Useful fallback protection, not a durable journal, deduplication ledger, before-image store or undo mechanism. Preserve this protection; rename it `WriteAttemptGuard` when the new journal arrives. |
| Tool dispatch | `invokeTool` validates arguments, consults consent, executes, then screens the output. Cancellation can end the wait while a write continues. Output screening can fail after the side effect completed. | Record mutation outcome separately from response delivery, screening and run outcome. A failed tool response is not proof of no write. |
| [`AgentTool` / `defineTool`](../src/core/tools.ts) | Has `kind: read | write`, schema and execute; no resource plan, inverse, reconciliation or stable operation ID. | Add a code-owned capability descriptor and a shared executor; do not infer undo from a verb or model-generated prose. |
| [`consent`](../src/core/consent.ts), [workflow permissions](../src/workflows/permissions.ts) | Ambient gate is consulted by agent dispatch. Workflow rules fall back to global then `ask`; no ambient gate exists outside its context. | Auditing and authorization are different concerns. Central execution needs an explicit authorization context for agent, user, workflow and system callers. It cannot silently treat absence as approval. |
| [Deferred writes](../src/workflows/deferred.ts), [UI routes](../src/http/routes/ui.ts) | Deferred execution rechecks permission and schema then calls `tool.execute` directly. UI uses an in-process `answering` set for duplicate clicks. Auto-settlement can execute previously deferred calls after a capability is allowed. | Bring this path into the durable executor; an in-memory set cannot arbitrate two processes or survive a crash. Require approval of the exact reversal plan in addition to today's effective policy. |
| [Gemini live voice](../src/chat/geminiLive.ts) | Registers a wrapper around `tool.execute` and directly invokes it; this path does not traverse `rawAgent.invokeTool` or its schema/consent checks. | A rawAgent-only hook misses voice writes. Route voice through shared validation, authorization, execution and recording without relying on model compliance. |
| [UI routes](../src/http/routes/ui.ts) and [mutation modules](../src/db/mutations) | Some user actions call domain mutations directly, e.g. permissions, workflow instructions and recommendation answers. Worker/services also make direct writes. | A tool audit alone is incomplete app history. Adopt a shared mutation context in domain services as they are onboarded; publish coverage, rather than pretending every DB statement is tracked. |
| [Workflow schema](../src/db/schema/workflows.ts), [runner](../src/workflows/runner.ts) | Runs/steps/logs/effects exist. `runEffects` has `reversible` and `revertedAt`, but the normal runner records textual `note` effects after completion. No corresponding general inverse execution was found. | Reuse UI correlation, not the reversible flag as authority. Store mutation history independently of workflow deletion; [workflow pruning](../src/db/mutations/pruneWorkflows.ts) can cascade run records away. |
| [Action schema](../src/db/schema/decisions.ts) | Has an optional unique `idempotencyKey` on the action record and invocation metadata. | Deduplicating an action row is not an atomic claim on execution and cannot prove an external request ran only once. |
| [Log monitor state](../src/logMonitoring/state.ts), [GitHub client](../src/logMonitoring/github.ts) | Persists leases, pending scan windows and a `posting` reservation before POST; marker-based reconciliation avoids blind retry after uncertain issue creation. | A useful existing pattern for outcome reconciliation and durable checkpoints. It is scoped to log incidents and contains no inverse change history. Keep it; attach shared operation IDs rather than replacing its protocol. |
| [OKF store](../src/okf/store.ts), [atomic writer](../src/okf/bundle.ts) | Per-instance serialization, per-file temporary write/rename, separate index/log side effects; no batch transaction or expected-hash precondition. Deprecation preserves the body. | Save the full write set before mutation, including derived side effects. Independent store instances and manual editors can race. Existing `log.md` is narrative chronology, not sufficient restore data. |
| [SQLite connection](../src/db/index.ts) | WAL, foreign keys, busy timeout and `synchronous=NORMAL`. | Ordinary database transactions can atomically include local mutation/history, but the present setting does not promise survival of every recent commit through power loss. Neither SQLite WAL nor traces are user undo history. |

Also preserve the dream spike's findings: file path changes affect derived IDs; reindex can retain removed objects/links and mishandle relative links; page-wide sources can misattribute inferred claims; generated page time is not claim/event time; old verification can survive new content. Undo must reconcile projections without destroying evidence and must not falsely verify a different claim.

## Capabilities: history is broad, reversal is explicit

Use a trusted registry keyed by tool/service name **and adapter version**. Defaults for an unknown write: history only, reversibility unknown, no automatic retry after dispatch. MCP tools currently all use `kind: write` conservatively in the [MCP adapter](../src/mcp/adapter.ts); history should say “remote call; effects not classified” until a trusted adapter classifies them. Do not weaken consent classification based on an untrusted remote description.

Each adapter declares:

- Resource scope and lock keys; typed argument/result validation; safe history summaries and redaction rules.
- Supported operation variants and their actual write set, including linked rows, generated indexes, tombstones and queued jobs.
- Reversal capability: `conditional_local_inverse`, `compensating_action`, `irreversible`, `derived_rebuild`, or `unknown`. Capability at recording time and current eligibility are separate.
- Capture method: exact snapshots, schema-aware field patch, stable membership delta, remote resource IDs/revision tokens, or metadata only.
- Reconciliation and retry policy: transactional local, provider idempotency key, reliable remote lookup, or never auto-retry when uncertain.
- Versioned prepare/apply/inspect/planInverse methods; undo and redo never execute code stored in history.

| Concrete operation | What can be offered | Limits |
| --- | --- | --- |
| App-owned screenshot collection: add an existing screenshot membership | Remove the same created membership if it still belongs to that operation and has not been independently changed. Restore a removed membership when its screenshot/collection still exists. | Preserve screenshot assets, classification and unrelated membership/order changes. An import group can contain remote steps that are not locally reversible. Adapt to the neighboring implementation's real schema before enabling. |
| Edit an app-owned collection title or an open reminder's due date | Restore the changed fields under resource revision/field preconditions, using the domain adapter. | Triggered notification state and delivery records are separate. Existing reminder completion settles decisions and has no reopen mutation; do not implement “undo completion” by restoring only one row. Start with simpler edits. |
| Import a collection item into Notion | Potential separate compensation: trash the exact app-created page after inspection and explicit approval. | Remote changes may have been seen or edited; trashing is not erasing the import's history. Notion currently exposes `in_trash` true/false and no permanent page deletion API. Pin API/adapter versions; do not assume an MCP tool is available merely because the REST API supports it. [Notion documentation](https://developers.notion.com/reference/trash-page) |
| Send a Pushover notification | Record request/result, safe target alias, accepted/unknown outcome and receipt when supplied. Disable Undo for delivered alerts. | A notification cannot be made unseen. Emergency receipt cancellation can stop remaining retries; it does not recall prior delivery. TTL is not general undo. Canceling future local delivery before dispatch is a distinct reversible queue operation. [Pushover API](https://pushover.net/api) |
| Generate Gemini embeddings; update local vectors/FTS | Record generation/cost lineage; invalidate/rebuild the derived index for the restored source revision. | Undo cannot retract an already transmitted input or refund a model call. A stale vector job must not overwrite vectors for a newer source. No new embedding calls are implicit in preview; reuse retained compatible vectors or queue authorized rebuilds. |
| OKF patch/create/deprecate/move | Exact or schema-aware inverse once all files, links and metadata are captured and guarded. | Move and create reversal must check dependents. Existing delete-free user semantics remain; removing a transaction-created, untouched file requires an explicit rollback adapter. |
| Unclassified remote write or multi-system operation | Honest activity/outcome history; reconciliation/manual follow-up where supported. | Never present a universal Undo button or invoke guessed “opposite” tools. |

Local DB rollback, compensating external actions, and crash recovery have different meanings. The service shares their audit format and planning UI, not a fiction that they are one cross-system transaction.

## Shared boundary and outcome model

Introduce an injected `WriteExecutor` in `src/core` with persistence supplied by an application service. Keep the provider-generic agent free of a required global DB import. Both tool callers and non-tool mutations enter the same execution context. Direct internal substeps use the parent's step ID and report resource changes; they do not recursively generate duplicate top-level audit operations.

Proposed sequence:

1. Assign a logical operation/step ID and server-owned idempotency key, validate input, record an allowlisted intent summary. Record rejected validation as `not_dispatched` without retaining malformed raw inputs.
2. Resolve authorization using the actual actor/route/workflow. Record denial or deferral without reporting a mutation. Deferred intent retains its ID, but eventual execution uses a new attempt and fresh policy/evidence checks.
3. Adapter identifies resources; take ordered resource locks or an appropriate transaction; inspect current revisions and prepare capture. Record durable before/expected-after data before a nontransactional mutation. Abort before dispatch when required history cannot be persisted.
4. Atomically claim execution with an operation-scoped unique idempotency key. Persist `dispatch_started` before leaving the local transaction for an external call. A reused key with different typed arguments is a conflict; identical-looking independently requested sends are different operations, not deduplicated by message text.
5. Apply; record authoritative outcome/changed resources before output screening. An adapter must interpret provider/application-level errors, not just “Promise resolved.” Preserve remote IDs before returning text to the model. The current generic MCP conversion loses structured effect information; only a versioned provider adapter can assert a known commit.
6. Deliver/screen the response separately. `response_blocked` or a canceled caller does not replace `committed` with `failed`. A still-running write is observed to completion where possible; otherwise outcome remains unknown pending reconciliation.

Separate state dimensions avoid misleading history:

- **Execution:** `not_dispatched`, `prepared`, `dispatch_started`, `committed`, `no_effect`, `partial`, `outcome_unknown`. A known local transaction rollback is `no_effect`; an exception after a network request is usually `outcome_unknown` until inspected.
- **Response:** `delivered`, `blocked`, `failed`, `caller_cancelled`, `pending`.
- **Reversal eligibility:** `available`, `needs_review`, `blocked_dependency`, `expired`, `unsupported`, `already_reversed`, `outcome_unresolved`.

Do not turn a canceled run into an instruction to undo its committed effects. Cancellation requests stop future steps; actual rollback/compensation requires the adapter and, where appropriate, fresh approval. Keep the existing fallback guard until durable outcome/dispatch records can provide at least the same conservatism across routes.

## Durable model and storage

Use new history tables in the existing local SQLite database, outside rebuildable OKF projection tables and outside cascading workflow ownership. History records keep immutable contextual identifiers/labels; optional joins may become null without deleting the history. Authoritative append-only events drive query projections; small mutable current-state/lease tables are permitted for coordination.

| Proposed record | Required content |
| --- | --- |
| `write_operations` | ID, label, initiating actor and origin (chat/voice/UI/workflow/system), conversation/run/trace links, requested intent, group policy, created time, inverse-of/redo-of, approved-plan digest. |
| `write_steps` | Stable step ID, operation/parent step, ordinal, dependency IDs, tool/service and schema/adapter versions, actor, safe args summary/digest, idempotency key, attempt IDs, capability snapshot, authority reference. |
| `write_events` | Append-only sequence, step/attempt, event kind, timestamp, execution and response details, error category, safe receipt/reference, recorder version. Separate DB commit order from event/source time. |
| `write_resources` | Resource type and stable ID, locator before/after (including path moves), observed revision, source content hash, expected/result hash, before/after payload references or inverse delta, field scope, created-by-step, dependency references. Explicit absent sentinel for create/delete. |
| `write_payloads` | Immutable versioned, compressed and encrypted small snapshots/patches, integrity digest, encoding, byte counts, key ID, expiration/pinning and redaction state. |
| `write_execution_claims` / leases | Unique idempotency scope, owner/attempt, fencing generation, heartbeat, expiry, result reference. Used to arbitrate processes, not as evidence that a remote effect occurred. |
| `write_reversal_plans` | Exact original step set, closure of required dependents, current inspected versions, inverse diff, conflicts, capability warnings, digest/expiry and approval; relation to execution when applied. |

Start with bounded text/JSON payloads in SQLite so local DB changes and their snapshots/events can commit together. Do not copy screenshot binaries into every event: reference immutable app-owned assets, pin them while an inverse needs them, and disclose when an original asset is unavailable. Add external encrypted blob storage only when measured sizes justify the extra crash/backup protocol. A snapshot reference must not be garbage-collected while any live inverse, recovery operation or approved plan depends on it.

Retention proposal: 30 days of reversible payloads, 180 days of minimal metadata, with pinning for unresolved/partial recovery and explicit user-kept changes. Display expiration before offering undo; expired data means history only. Set an initial 256 KiB per-resource and 2 MiB per-operation capture budget for ordinary text/JSON adapters. Larger changes must use an explicit large-payload path or be rejected before execution if they require undo; history-only writes record a bounded summary. Never silently downgrade a reviewed reversible change to irreversible because a snapshot is too large.

Default security: same authenticated local API access as protected application data; owner-only storage permissions; encrypt payloads before persistence using a deployment-provisioned key kept outside DB/backups (OS key store or mounted secret, without assuming a particular host). If a key is missing, metadata-only phase still works; reversible writes requiring capture remain disabled. Redact credentials before capture: snapshots never include API tokens, auth headers, secret config fields or arbitrary remote payloads. Store credential references, not values. Use opaque target aliases in list views and keyed digests for sensitive argument matching; content hashes are identifiers inside protected storage, not public anonymization.

Audit is append-only for normal writers, not secretly permanent retention. Authorized privacy deletion removes payloads/keys and records a minimal redaction marker; purge policies also cover backups/WAL and say when backups expire. No hash chain can promise tamper-proof storage against an administrator with both DB and keys. Do not send snapshots to logs, Phoenix, models or embedding search. History previews render escaped inert text and never execute stored instructions. Old memory snapshots must not enter active knowledge retrieval.

## Concurrency, commit and recovery

### Local database adapters

In one short SQLite transaction: verify expected revision/field state, write domain changes plus complete resource capture and commit event, and schedule required derived work in an outbox. Allocate IDs before mutation. Include linked domain rows and secondary effects; never restore the whole database to undo one edit. Use a monotonic resource revision where possible and compare canonical field hashes as additional evidence. Transactions serialize local writers, but stale reads must still be detected inside the write transaction. SQLite documents serializable writes and snapshot behavior in WAL mode. [SQLite isolation](https://www.sqlite.org/isolation.html)

For the durable write-ahead/recovery guarantee, explicitly use and test `synchronous=FULL` on all participating writer connections rather than assuming the current `NORMAL` setting survives power loss. SQLite documents that WAL with NORMAL can lose recent committed transactions after power failure while remaining consistent; FULL adds durability synchronization. This has a performance cost and does not make external files transactional. Benchmark the change rather than changing it in this plan. [SQLite synchronous settings](https://www.sqlite.org/pragma.html#pragma_synchronous)

### OKF and other file adapters

Before grouped files can be changed, migrate every app-owned OKF writer to a shared bundle serialization boundary across server and worker. Use one writer authority per bundle in the initial design, durable claims for requests and fencing checks on ownership handoff; do not assume lease expiration itself stops an old process mid-write. Acquire the bundle exclusively through commit/recovery and do not transfer ownership until the old writer is stopped or reconciled. Locks on multiple independent resources are ordered to avoid deadlocks.

Protocol:

1. Under the writer boundary, capture full source versions, validate preconditions and stage all resulting files. Save the complete plan and before/after bytes durably in the journal before changing originals. Include new/removed paths and expected absence. Validate the staged bundle.
2. Mark operation applying, then replace files using temporary files on the same filesystem. Flush file and directory metadata as required by the selected platform's durability contract; test the actual host/filesystem. Record per-resource progress. Current `writeFileAtomic` alone is not that contract.
3. Preserve existing append-only OKF logs: append a uniquely identified event for this operation. Regenerate directory indexes deterministically. Do not replay log text twice or roll back the entire log and erase unrelated history.
4. When all authoritative files match expected after-images, record committed. Enqueue projection/vector reconciliation keyed by resulting source hashes. Projection failure becomes “Saved; search refresh pending,” not a second source mutation or a false failed save.

On startup, recover unfinished local operations before serving their resources as mutable. Compare each file to before/after hashes: all before → no effect; all after → finalize commit; a recognized mixture → default to completing the persisted approved plan, or restoring before-images if completion is impossible and restoration is safe. Any unexpected state → conflict/manual review, no overwrite. Keep recovery deterministic and use no LLM. A partial group's already committed independent steps remain visible; recovery does not manufacture atomicity across unrelated systems.

Manual editors do not honor app locks. Immediately recheck before replacement and inspect afterwards, but acknowledge the residual check/rename race. Initial guarantees cover cooperating app writers; when external edits are possible during commit, do not promise strict lost-update prevention. Detect known divergence, preserve competing versions and pause for review. A stronger guarantee requires exclusive ownership/editor integration or a versioned file-store architecture. The UI can offer repair from captured versions if an external race is detected, but cannot guarantee recovery of a version never observed.

### Remote effects and derived jobs

Remote dispatch uses durable reservation before the request and a stable provider key/marker only where supported. Lost replies remain unknown; inspect via a documented lookup when available. Absence in an eventually consistent or incomplete search is not proof of no effect. Replaying a queued request is allowed only when its adapter can establish safe idempotence. No exactly-once claim across arbitrary APIs. Compensation is its own newly approved write and may fail or have an unknown outcome.

Keep Gemini vector/FTS and other projections disposable. Outbox jobs name immutable source revision, representation/model version and operation ID; completion compares the current source before publishing results. Undo creates a new source revision and invalidates obsolete jobs. It does not rewind ingestion/log-monitor watermarks: doing so could reimport a removed record or resend a notification. Use a domain-specific suppression/tombstone or explicit reprocess request when the user wants a repeated import. Never automatically undo notification-delivery history as part of reverting reminder text.

## Undo, redo and logical steps

An operation groups a user intent; a step is an adapter-defined meaningful mutation; an attempt is a dispatch/retry; a resource change is a file/row delta. One step may contain many inseparable resources. Use a dependency DAG, not merely timestamp order. Steps relying on a newly created entity or moved path constrain reversal of that creation/move. Conservatively block when dependency coverage is incomplete. Default grouped undo is all supported required steps in reverse dependency order; independent steps can be selected individually after validation.

For a simple original transition **A → B**, inspect current state **C**:

- C has the recorded B revision/hash, and relevant dependencies are unchanged: preview **B → A**. Apply with the same precondition inside the transaction/writer boundary.
- C differs: show what changed after the original write. Default to no automatic undo. A versioned adapter may propose a three-way reverse patch using base B, desired A and current C, preserving disjoint edits. Semantic dependency checks still apply even when line-based patching finds no overlap.
- A recorded inverse already succeeded: display its result and offer redo if eligible. Do not repeatedly execute the inverse.
- Original effect is unknown, recovery incomplete, snapshot expired or adapter unavailable: no Undo; show why and a supported inspect/repair option.

Example: a dream operation adds a cited Film A entry to Dad's overview and links three original memories. The user subsequently adds a new preference to the overview. Group undo cannot restore the entire old file. It offers a reverse patch removing the generated entry/links while preserving the newer preference, with provenance and link validation. If the user edited that very entry, show a conflict. Removing a created Dad page that another page now references must keep or explicitly repair those references rather than leaving broken links.

Undo is a new operation with `inverseOf`; it records its own before/after revisions, initiating user and reason. Redo reverses that successful undo under current preconditions and policy; it does not replay the old model prompt or HTTP request. For an edited/manual reverse patch, redo means reversing the actual applied patch, not recreating the entire historical group. Another change can invalidate redo. The history is a branching dependency graph, not a single global Ctrl-Z stack.

For exact OKF restoration, restore historical concept bytes and preserve their source/verification context; append the restoration event to external mutation history and `log.md`. This records a restoration today without pretending the underlying facts were asserted today. For a partial reverse patch, stamp the responsible writer and retain claim provenance; do not inherit verification of different content. Reindex chronology must distinguish restoration from fresh evidence, and verification needs the version-bound treatment in the dream spike. No undo may rewrite an inferred preference as a user-confirmed fact.

Policy defaults: user-requested undo/redo needs review of its concrete diff and the current applicable write permissions; no automatic undo of successful writes just because a model checker dislikes the result. Recovery finishing an already approved exact local plan is separate from a new user reversal. External compensation always shows its destination/effect and requires specific approval. An allow rule or auto-settled deferred call cannot stand in for approval of a different reversal plan. Undo of permissions does not reopen past approvals or bypass the current authorization boundary.

## Review UI and proposed API

Add a Write history view, with entry points from activity, tool results, memory details and workflow runs. Show “Changed,” “No change,” “Sent,” “Outcome unknown,” or “Partially applied” based on recorded evidence. Display “Undo available until …,” “Review reversal,” “Cannot undo a delivered notification,” or “History only” separately. Group mixed operations honestly: “2 local changes can be reversed; 1 notification cannot be recalled.”

Detail shows origin/actor, time, tool/domain action, changed resources, exact before/after diff, evidence/provenance links, dependent changes and any response-screening failure. Technical IDs/hashes are expandable rather than the default explanation. Default list summaries contain no private message bodies. Preview reveals full captured content only to an authorized user, with appropriate retention notices. Keep plain English outcomes alongside trace/run links.

Proposed API, names subject to normal routing conventions:

| Endpoint | Behavior |
| --- | --- |
| `GET /api/write-history` | Cursor-paginated filtered summaries by target, operation, tool, workflow, status; includes coverage start/version. |
| `GET /api/write-history/:id` | Authorized steps, outcomes, capability/eligibility and resource diffs; no executable stored payloads. |
| `POST /api/write-history/:id/reversal-plans` | Select steps and intent (`undo`/`redo`/explicit compensation); inspect state, compute dependency closure and exact preview. Local planning may persist a plan but performs no domain or external writes. |
| `POST /api/write-reversal-plans/:id/apply` | Require plan digest, approval and idempotency key; recheck policy/current versions, atomically claim, return operation ID (202 if asynchronous). Stale plan → 409 with new preview required. |
| `GET /api/write-operations/:id` | Durable progress/recovery status; repeated polling cannot execute anything. |

Mutating routes require the app's authentication/authorization and CSRF/origin protections appropriate to its deployment; never use GET links to execute undo. Plan IDs and digests are preconditions, not credentials. Keep HTTP route validation and tool schema validation aligned. Notifications and ordinary audit appends do not recursively audit themselves; the service appends explicit internal events. Coverage should say which named entry points and tool families are protected, not imply retrospective history for writes made before rollout.

## Concrete implementation tasks and release gates

Tasks are prospective, in dependency order. They do not authorize deployment or mutation of personal data.

### Milestone A — useful broad history first

| ID | Task / affected seams | Acceptance evidence |
| --- | --- | --- |
| H01 | Inventory production write entry points: rawAgent, voice, deferred/API actions, domain mutations, worker jobs and MCP. Define registry defaults and publish coverage. | Tests enumerate registered write tools and mapped callers; unknown adapters say history only. Missing paths are listed, not silently covered. |
| H02 | Add noncascading history schema, metadata event API, operation context, pagination and migration. Integrate durable execution claims. | Repeated key returns one recorded attempt/result; same key/different args conflicts; deleting a workflow does not delete history. |
| H03 | Introduce injected shared executor and route agent, voice and deferred tools through it. Preserve consent, schema validation and fallback suppression; audit direct UI/domain entry points from H01. | Synthetic calls through each path show one mutation record and appropriate policy; deny/defer performs no domain write; double-click and two-process claims do not double-dispatch. |
| H04 | Capture truthful outcomes before result screening; reconcile unknown outcomes only via registered adapters. Keep log-monitor reservation protocol. | Success then output quarantine remains committed; timeout after dispatch remains unknown until inspected; no automatic retry of an uncertain remote effect. |
| H05 | Add History list/details and capability labels, linked to runs/targets; safe summaries/redaction and retention job. | Realistic synthetic local, remote, mixed and unknown histories render accurately; no unsupported Undo buttons; credentials absent from DB/log test fixtures. |

Milestone A can ship without inverse payloads or any Undo button. Call it write history, not universal mutation coverage or recovery. Fail closed for instrumented writes when the required intent reservation cannot be saved; if recording fails after dispatch, preserve the existing durable reservation as unresolved and alert. Do not retroactively fabricate before-images from current state.

### Milestone B — supported local inverse operations

| ID | Task / affected seams | Acceptance evidence |
| --- | --- | --- |
| U01 | Add bounded encrypted payload capture, revision/resource schema, key provisioning, retention pins and snapshot GC; evaluate FULL durability on writers. | Missing key/quota rejects reversible write before mutation; expiry disables undo; backup/restore includes necessary keys via separate approved process; no dangling snapshot references. |
| U02 | Implement one simple SQLite adapter, preferably collection membership when neighboring schema is ready; otherwise an open-reminder due-date edit. Include associated rows/outbox invariants. | Local domain write and before/after history commit together; unrelated edits survive; domain validation still holds after inverse. |
| U03 | Implement revision-checked inverse planning/application, dependency closure, policy review and idempotent apply API. | Concurrent edits between preview/apply yield 409; inverse executes once; restoring a create with new dependents is refused. |
| U04 | Add user-facing diff review, expired/unsupported/conflict states and versioned redo. Start with refusal on divergence; add three-way reverse patches only after fixtures pass. | A → B → user edit → undo preserves user text or requests review; redo reverses the actual successful undo, not the original arbitrary tool call. |
| U05 | Adopt adapter contracts in screenshot collection and notification/embedding work at their own integration points. | Notification send has no Undo; queued unsent cancellation is separate; restored source invalidates outdated embedding jobs; local import undo cannot resubmit remote import. |

Milestone B excludes completion/reopening of reminders, permission reversals and remote compensation until their invariants are modeled. Successful simple adapters do not make all tools reversible.

### Milestone C — grouped OKF, then dream

| ID | Task / affected seams | Acceptance evidence |
| --- | --- | --- |
| K01 | Establish one cooperating OKF writer boundary; durable group plan, staged validation, source hashes and snapshot capture for create/patch/deprecate, then move. | Cross-process app writes serialize; stale source/target collisions refuse; old owner cannot continue after handoff. Explicitly document external-editor limits. |
| K02 | Implement restart recovery and exact local inverse for multi-file writes; unique log event IDs, derived-index rebuild and projection/vector outbox. | Kill/inject failure before/after each journal/file boundary; recover before, after and mixed states without lost captured content, duplicate log entries or duplicate source apply. |
| K03 | Fix projection reconciliation and integrate content-bound verification, claim provenance and restoration chronology. | Relative links/removed edges and objects match source after undo; immutable evidence survives; no false user provenance/verification or changed event time. |
| K04 | Implement dependency-aware grouped apply/undo for a synthetic Dad overview plus source links; narrow reverse patch only after exact inverse is reliable. | Group undo preserves later user additions, blocks overlapping edits, retains source details and resolves all affected links; no LLM call in apply/recovery/undo. |
| K05 | Connect the existing proposal-only dream plan to shared history and reviewed group application. Keep merging individually reviewed. | All identity/conflict/detail-retention gates in the dream spike plus K01–K04 pass. No dream-specific parallel journal or independent undo subsystem. |

### Later, separately scoped

Add remote compensation adapters only when their API revision, permission, resource ownership, remote-edit detection and uncertain-result recovery are verified. Consider Notion trash/restore for app-created imports first, but do not block local undo waiting for it. Do not add an attempted “recall Pushover” adapter. Add larger encrypted blob storage only after size measurements. Revisit automated nonoverlapping reverse patches after manual review data supports them.

## Complexity, limits and decisions

Planning estimates for one engineer familiar with the code, including meaningful tests/UI and excluding deployment: A roughly 3–5 engineer-days; B another 5–8 for payload security and one local adapter; C another 7–12 for cooperating file writes, recovery/projection/trust integration and grouped undo. Total roughly 3–5 working weeks, with substantial uncertainty. Additional complex domain/remote adapters can take several days each. These are scope estimates, not commitments; H01 may uncover more direct write paths, and stronger external-editor guarantees require a separate architecture decision.

The shared event model is modest. The expensive parts are complete resource capture, current-state validation, crash recovery and domain semantics. Avoid full event-sourcing of the application or generic SQL reversal: neither is required for useful history, and neither knows whether a delivered notification or user-edited external page can be safely reversed. Git can supplement file history/backups but does not provide integrated authorization, DB membership undo or external outcome reconciliation.

Recommended defaults and open choices:

- **Coverage:** instrument all known production tool paths plus explicitly onboarded domain mutations. Block new registered write tools from shipping without a history descriptor; history-only is a valid descriptor.
- **First inverse:** collection membership if its new schema is available; otherwise open-reminder due date. Decide at implementation kickoff based on actual merged code, without coupling neighboring work now.
- **Conflict behavior:** refuse divergent exact undo first; offer reviewed reverse patches later. Never overwrite later edits by default.
- **Durability:** metadata and small encrypted snapshots in the existing DB; FULL for participating write connections; one cooperating OKF writer. Measure performance and verify the deployment's key/backup setup before enabling snapshots.
- **Retention:** 30-day inverse payloads and 180-day minimal metadata, visible and configurable. Privacy deletion overrides undo availability; unresolved recovery data requires explicit resolution before purge.
- **Remote actions:** history now, approved compensation later; delivered notifications remain irreversible. No network side effect is implicit in an undo preview or a local recovery operation.

This plan establishes the foundation before dream mutations. It preserves the dream spike's conservative identity, claim-level provenance, conflict and detail-retention requirements: even perfect undo would not justify merging different people or turning an inference into a fact.
