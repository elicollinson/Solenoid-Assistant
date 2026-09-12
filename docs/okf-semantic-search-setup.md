# Enable OKF semantic search

The feature combines local substring/FTS5 retrieval with Google Cloud Gemini embeddings. Markdown remains authoritative. Saves enqueue work locally; the existing worker embeds one chunk per five-second tick. Search reports its mode, fallback reason, and indexing coverage. Embeddings are **disabled by default**.

## Setup checklist

1. **Choose a billed Google Cloud project and enable the Vertex AI API** (`aiplatform.googleapis.com`). Google documentation now also calls this Gemini Enterprise Agent Platform. An administrator can run:

   ```sh
   gcloud services enable aiplatform.googleapis.com --project=YOUR_PROJECT_ID
   ```

2. **Grant the application service account inference access in that project.** In IAM & Admin → IAM, grant **Vertex AI User** (`roles/aiplatform.user`; the current UI may say Gemini Enterprise Agent Platform User). An administrator can instead run:

   ```sh
   gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
     --member=serviceAccount:YOUR_SERVICE_ACCOUNT_EMAIL \
     --role=roles/aiplatform.user
   ```

   The relevant inference permission is `aiplatform.endpoints.predict`. Project API enablement is an administrator operation; the application does not need Owner or API administration permissions. If your organization uses custom roles, quota projects, VPC Service Controls, or model restrictions, its administrator must allow this inference request and any required service consumption on the billing/quota project. [Cloud setup](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start), [IAM requirements](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/access-control).

3. **Supply Application Default Credentials to both server and worker.** An existing valid service-account JSON key can be reused after changing its IAM binding; permission changes do not require a new key. Set `GOOGLE_APPLICATION_CREDENTIALS` to the credential file's absolute path. Do not commit that file. Standard ADC also supports an attached/federated identity or local user ADC when appropriately configured. [ADC lookup](https://docs.cloud.google.com/docs/authentication/application-default-credentials).

   The voice integration uses `GEMINI_API_KEY`, which this adapter does not use. Model Armor has separate project/credential settings; an API key or Model Armor role alone does not establish Vertex inference access. The adapter does not implicitly select `MODEL_ARMOR_PROJECT_ID` or read Model Armor inline credentials. To reuse its service account, point standard ADC at that credential file and explicitly select the project below.

   During development, the main checkout's referenced service-account file was accessible. **One synthetic `gemini-embedding-2` request using that account/project returned HTTP 403.** No private memory text was submitted. This establishes that live embedding access still needs verification; the status alone does not identify which API/IAM/organization restriction caused it.

4. **Configure the feature** in the app's `.env`:

   ```dotenv
   OKF_EMBEDDINGS_ENABLED=true
   OKF_EMBEDDING_PROJECT=YOUR_PROJECT_ID
   OKF_EMBEDDING_LOCATION=global
   OKF_EMBEDDING_MODEL=gemini-embedding-2
   OKF_EMBEDDING_DIMENSIONS=768
   OKF_EMBEDDING_DAILY_TOKENS=100000
   GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/credentials.json
   ```

   `GOOGLE_CLOUD_PROJECT` is the only project fallback. Supported models are Embedding 2 and `gemini-embedding-001`; dimensions are 768, 1536, or 3072. For Embedding 2 use `global`, `us`, or `eu`; `us-central1` is available for the older text-model path, subject to Cloud availability. Global routing does not promise regional processing. [Model locations](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/embedding-2), [location policy](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations).

   For Docker, the existing compose file mounts `.env`, but a host credential path is not automatically accessible inside a container. Mount the credential file read-only at a fixed container path for **both server and worker**, and set `GOOGLE_APPLICATION_CREDENTIALS` to that container path. Keep server and worker model/project/dimension settings identical. Apply the same environment/secret mount convention to your actual deployment manifests. This PR does not deploy or change infrastructure secrets.

5. **Apply migrations and check configuration**, from the app checkout, against the intended database:

   ```sh
   bun install --frozen-lockfile
   bun run db:migrate
   bun run okf:embeddings doctor
   bun run okf:embeddings smoke --confirm
   ```

   `doctor` prints configuration presence, never credentials. `smoke --confirm` makes exactly one synthetic request, reads no OKF files, and reports vector dimensions/norm. It is a paid request if successful; a short sentence costs much less than one cent at the listed rate. HTTP 403 means the project/account request was refused; check steps 1–3 and organization restrictions before retrying. The locked SDK 2.21.0's actual Embedding 2 endpoint and response mapping were verified with a local mock HTTP server; a successful Cloud smoke test remains a rollout prerequisite.

6. **Inspect and intentionally enroll existing memories**:

   ```sh
   bun run okf:embeddings plan
   bun run okf:embeddings backfill --confirm --max-jobs=20
   bun run okf:embeddings status
   ```

   `plan` performs a local reconciliation and shows eligible/ready/pending/unindexed counts, total chunks, and a conservative full-rebuild input/cost ceiling. It does not call Google. `backfill --confirm` authorizes indexing all current, non-deprecated memories; it processes up to the requested number of jobs immediately. **All remaining enrolled jobs persist and the running worker continues them within the daily cap.** `--max-jobs` limits that CLI invocation, not the total enrollment. Use `--root=/absolute/path/to/bundle` only for deliberate alternate bundles; the app worker processes the default OKF root.

   Initial discovery deliberately leaves old memories unindexed. New writes and later detected changes are enrolled automatically. A crash after file save is repaired from the pre-write inventory on the next reconciliation. If the database was unavailable before the first-ever inventory, an explicit backfill may be needed; the save result reports indexing failure rather than pretending embedding succeeded.

7. **Run/restart both app processes** using the normal host/deployment workflow. The embedding queue is serviced by `bun run start:worker`; the server alone does not drain it. Neither process is started by the setup CLI. Changing environment settings requires restarting both processes. First use the synthetic smoke test and `plan` before enabling a live worker if you want to inspect costs first.

## Cost, privacy, and recovery

Cloud's observed Embedding 2 text rate is **$0.20 per million input tokens**. For example, 10,000 chunks averaging 500 billed tokens cost about $1 to index; 10,000 queries averaging 40 tokens cost about $0.08. These are illustrative sizes, not measurements of this user's corpus. The pricing page still labels Embedding 2 Preview while the model card lists the GA identifier, so verify the selected SKU. [Cloud pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing).

The daily cap reserves **UTF-8 input bytes as a conservative token ceiling**, shared across queries, worker retries, configurations, and bundles in the database. The default 100,000 ceiling corresponds to at most approximately $0.02 of Embedding 2 input at the listed rate; it may index fewer chunks than a token-based estimate. Failed/ambiguous requests are not refunded locally. SDK automatic retries are disabled; queue retries are bounded and separately reserved. Budget exhaustion pauses jobs until the next UTC day and makes queries fall back to lexical search. A successful manual smoke request is separate from this queue accounting.

Both document text and semantic query text leave the machine for Google processing. Search vectors and original chunk excerpts stay in the local database and its backups. Google prohibits model training on Cloud customer data without permission but documents retention exceptions; this is not a promise of zero retention. [Cloud data governance](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention).

Operational behavior:

- Changed chunks become pending immediately; a document's semantic results are withheld until all its current chunks are ready. Unchanged chunk inputs reuse their vectors, including metadata-only changes.
- Moves, external deletions, and parse failures retire stale local search rows. Failed directory scans do not delete the old index or return it as current. Deprecation excludes current search; an explicit OKF status filter can still find historical text.
- Network/429/5xx failures retry with backoff; credentials/invalid-output failures remain visible. After correcting a failed configuration, `backfill --confirm --retry-failed` explicitly re-enrolls the current corpus and resets failed jobs. Check `status` afterward.
- Changing model or dimension gives a different embedding configuration. Existing memories need explicit backfill; incompatible vectors are never compared. Restart all processes together to avoid conflicting configurations. Old configurations are retained locally for now; no automatic vector purge or backup erasure is implemented.
- Disable with `OKF_EMBEDDINGS_ENABLED=false` and restart both processes. Local keyword/FTS search remains available and no new document/query calls are made. A request already dispatched to Google cannot be recalled.
- The local `KnowledgeIndex.neighbors(conceptId, expectedSourceSha256, limit)` seam returns distinct memory candidates and source hashes for a future dream workflow. It performs no remote call or memory consolidation. No ready-event outbox is implemented in this PR.

## PR integration order and implementation scope

Agreed migration order: **Collections `0009_collections` and `0010_collection_imports` → Pushover `0011_pushover_reminders` → semantic search `0012_okf_semantic_search`**. This standalone branch starts at `0008_log_monitoring`; its new journal entry uses timestamp `1789236471885`. Before merging it after the companion PRs, rebase and reconcile/regenerate the combined schema snapshot chain and journal, preserving the earlier migrations. Renaming files alone is insufficient. Re-run schema tests and generation against the combined schema, including the aggregate table-count assertion. Do not deploy this branch's isolated journal over a database already migrated from the companion branches before that integration.

The implementation uses dedicated rebuildable search tables and the existing shared FTS5 table, without changing the general-purpose embeddings table layout or the legacy UI projection. Search reads current source snapshots; `knowledge_read` refreshes its detailed projection before reading. General UI/list projection cleanup and graph-link reconciliation remain separate work. The backend is a simple exact cosine scan; sqlite-vec/ANN, query caching, reranking, a judged relevance benchmark, and automatic consolidation are not included. See the [research spike](okf-semantic-search-spike.md) for the design rationale and later scale/evaluation options.
