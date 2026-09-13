# OKF search and memory reflection

`okf_search` and `knowledge_search` share one local index: substring/FTS5 results plus Google Cloud Gemini embeddings when enabled. OKF Markdown remains authoritative. The existing worker processes durable embedding jobs, one chunk per five-second tick. Search uses local exact cosine matching and reports indexing coverage and lexical fallback reasons.

**Memory reflection** appears in the existing Workflows screen. Run it on demand or schedule it through the usual workflow controls. It finds related memories using the same vectors, uses the application's existing Agent/model routes to synthesize cited facts, connections and differences, and writes a linked overview through `okf.write` permission. Original accounts and their source references remain intact. Model assertions remain unverified. Ambiguous identities and conflicting explicit entity identifiers stay separate.

There is no history page, proposal inbox, new login, or separate dream enable flag. The normal workflow run shows its changes and any failures. Its seeded `okf.write` permission is `allow`; existing `ask` and `deny` behavior remains available through Workflows. When set to `ask`, the existing deferred-write mechanism holds the exact update and checks source versions again before writing it.

## Setup

1. Keep the application's existing Google credentials available to both server and worker. The shared loader preserves this order:
   `MODEL_ARMOR_CREDENTIALS_JSON` → `GOOGLE_APPLICATION_CREDENTIALS_JSON` → `MODEL_ARMOR_CREDENTIALS_BASE64` → `GOOGLE_APPLICATION_CREDENTIALS_BASE64` → standard ADC. No duplicate key, credential file or new mount is required for inline credentials. A malformed selected source fails without switching identities; errors omit secret values. `GEMINI_API_KEY` is still only for the voice integration.
2. Enable `aiplatform.googleapis.com` in the billed project and grant the service account `roles/aiplatform.user` (including `aiplatform.endpoints.predict`). This was verified with live synthetic requests after IAM/API setup on 2026-09-12. The earlier 403 diagnosis is resolved for that tested account/project.
3. Set `OKF_EMBEDDINGS_ENABLED=true`. Project selection is `OKF_EMBEDDING_PROJECT` → `GOOGLE_CLOUD_PROJECT` → `MODEL_ARMOR_PROJECT_ID` → `GCP_PROJECT`; configure the override only if a different project is needed. Defaults are `OKF_EMBEDDING_LOCATION=global`, `OKF_EMBEDDING_MODEL=gemini-embedding-2`, `OKF_EMBEDDING_DIMENSIONS=768`, and `OKF_EMBEDDING_DAILY_TOKENS=100000`. Model Armor's region is not reused. Explicit model, location, dimension, and project settings remain supported; keep both processes consistent. The older `gemini-embedding-001` model is also supported.
4. Apply the normal setup steps:

   ```sh
   bun install --frozen-lockfile
   bun run db:migrate
   bun run db:sync-workflows
   bun run okf:embeddings doctor
   bun run okf:embeddings smoke --confirm
   ```

   `doctor` checks configuration presence locally. `smoke --confirm` sends one fictional sentence, never reads memories, and reports vector size/norm. It is a billable embedding request. Start/restart the usual server and worker processes afterward; the server alone does not drain the queue.
5. Existing memories need one deliberate backfill; new or edited memories enroll automatically:

   ```sh
   bun run okf:embeddings plan
   bun run okf:embeddings backfill --confirm --max-jobs=20
   bun run okf:embeddings status
   ```

   `plan` is local. Backfill enrolls **all** eligible current memories; `--max-jobs` bounds only the immediate invocation. The existing worker continues remaining jobs within the daily cap. For synthetic checks, use `--root=/absolute/path/to/temporary/bundle` and a separate `DATABASE_URL`; the app worker processes the normal root.

No `WRITE_HISTORY_KEY`, `WRITE_HISTORY_TOKEN`, `DREAM_ENABLED`, extra model key, or new service is needed. Reflection uses the same model/screening configuration as the rest of the application.

## Writes, recovery and undo

All app OKF creates, patches, moves and deprecations use a small internal file journal. Multi-file updates stage and validate first, save versioned JSON before/after images with SHA-256 integrity checks, then publish files. Cooperating server/worker writers share a durable bundle lock. Search and graph projections wait while an authoritative write is incomplete. Refresh failures remain retryable; startup and the worker retry saved interrupted writes and pending refreshes. Recovery never reruns the model or overwrites a conflicting newer file.

This is internal recovery state, not an application-wide activity log. It stores no generic tool arguments, credentials, row snapshots, remote receipts or review plans. Completed captures expire after 30 days; partial writes and pending refreshes stay pinned. There is no application-level encryption or key-management process. Protect the existing database and backups using the same access controls as other stored memories.

`createOkfUndoTool` implements conditional local undo (and undoing an inverse provides redo). **It is deliberately unregistered**: no UI, agent tool group, workflow, or deferred resolver exposes it. It refuses later file edits or references to a created page. Notifications and other external effects are outside this feature.

The migration is one generated `0012_memory_reflection` SQL/snapshot/journal entry after main’s merged Collections `0009`/`0010` and Pushover `0011` chain. Those features have no changes in this PR’s review diff. The actual inspected app databases contained no old history tables; unreleased encryption/proposal migrations and conversion tooling were discarded. Do not reuse disposable databases created from the superseded draft migration chains.

## Limits

- Reflection examines at most 12 seeds and makes at most five synthesis attempts per run, with two to six source accounts per group and a 32,000-character model-input budget. Captured writes currently stage a bundle up to 32 MiB, with 256 KiB per changed file and 2 MiB per saved change. It is bounded organization, not exhaustive clustering. No initial schedule is enabled.
- Exact evidence quotations, coverage and cross-source citations are validated. These checks cannot prove that generated prose interprets a quotation correctly. Uncertain identities are skipped; differing facts remain separately attributed, and original detail is preserved. There is no judged corpus benchmark yet.
- Document and semantic-query text go to Google when embeddings are enabled. Reflection input goes to the application's configured model route and existing screening/tracing mechanisms. Vector storage and search remain local. Disabled embeddings and provider/budget failures retain lexical search; automatic reflection needs ready vectors.
- Model/dimension changes never mix vector spaces and require backfill for unchanged memories. Queued retries reserve UTF-8 bytes as a conservative shared daily token ceiling; ambiguous requests are not refunded. `backfill --confirm --retry-failed` retries permanent failed jobs after configuration is corrected.
- File locking coordinates app writers, not arbitrary external editors. A concurrent manual edit can still race between file checks and replacement. Detected conflicts preserve content and need an explicit ordinary edit; no automatic three-way merge is attempted.
