# Host sources: collection, retention, and local catch-up

The iCloud-synced Mac mini supplies Messages, Contacts, and its own screenshots.
The assistant owns collection code, the ingestion API, classification consumer,
source tables, and tools. Mini-cloud owns the pinned macOS LaunchAgent deployment
and container storage. Only the host collector opens Apple databases. Tools and
workflows read the application source tables; they do not fall back to this Mac's
Apple libraries.

## Deployment

1. Deploy the assistant image containing migration `0007_host_sources`. Back up
   the application database first using mini-cloud's `scripts/backup-solenoid`.
2. Add independent randomly generated credentials of at least 32 characters to
   mini-cloud's encrypted `secrets/prod.env`: `SOLENOID_SOURCE_INGEST_TOKEN` and
   `SOLENOID_SOURCE_READ_TOKEN`. Preserve every existing setting. Enable the
   consumer with `SOLENOID_SOURCE_CONSUMER_ENABLED=true`.
3. Pin `mini_cloud_collector_revision` to the assistant commit and set
   `mini_cloud_collector_enabled: true` in mini-cloud. Review `make plan`, then
   apply through its normal pipeline. Its role installs osxphotos and a user
   LaunchAgent, using the existing Bun installation and verified Caddy CA.
4. Grant the collector runtime access in macOS Privacy & Security if required.
   Collection must run as the logged-in iCloud user. After a reboot, log in to
   that account; this is a LaunchAgent, not a pre-login system daemon.
5. Check the Workflows source-status panel and collector logs. Messages and
   Contacts must show a successful collection before their workflows can run.
   Screenshots enter the tools only after the classification queue accepts them.

Collection runs at login and every 15 minutes. The first run defaults to 30 days
of messages/screenshots and the current complete contact list. That initial date
is persisted; subsequent scans reconcile the covered history, including late
arrivals, edits, and deletions. API upserts deduplicate unchanged records.
This implementation scans the covered window each run rather than relying on an
Apple change feed. Large multi-year histories will need a more efficient scan.
Use `SOURCE_BACKFILL_FROM` to explicitly expand coverage; setting
`SOURCE_BACKFILL_DAYS=0` on an initial run scans from 2001.

The app API uses separate write and read credentials over HTTPS. It owns SQLite
writes. The collector holds an exclusive process lock, submits bounded batches,
and acknowledges each source only after a complete successful inventory. A
failed scan is retried; no database file is copied or remotely mounted.

`bun run db:sync-workflows --register-only` registers the five code-defined
workflows without creating schedules or granting permissions. Mini-cloud runs
this after a healthy deployment. Configure schedules and permissions in the UI.
To migrate old screenshot processing receipts explicitly, run
`bun scripts/source-import-receipts.ts .screenshots`; it leaves the old JSON file unchanged.

## Screenshot retention

The existing Photos filters select screenshots and exclude hidden, shared, and
syndicated items. The classifier accepts **Book, Movie, TV Show, Game, Music**.
Rejected, unknown-category, and quarantined items are discarded.

Uploads initially live in shared temporary staging, a 512 MiB tmpfs volume in
mini-cloud. Staging is excluded from its normal backup volume list. A worker
classifies one candidate at a time, with leases and retry backoff. Interrupted
or failed staging expires after 24 hours; missing bytes can be re-uploaded on a
later collector run. Outages do not count as classification rejection.

Accepted original bytes move into the existing backed-up `solenoid-screenshots`
volume under `source-assets/`. Rejected bytes are deleted from staging and any
retained asset location. Pending filename/metadata and classification content
are removed; a hash/status receipt remains to avoid uploading the same rejected
image again. Classification input/output is suppressed from application traces
and logs while evaluating candidates. This does not control the model provider's
own retention policy.

The collector deletes its temporary exports after a run and clears exports from
an interrupted run at its next start. **It never deletes originals in Apple
Photos or iCloud.** Accepted assets remain available after downstream ingestion.
Upstream deletion hides the source record; existing accepted assets and backups
have the standard backup retention policy, not a secure-erasure guarantee.

Deduplication uses SHA-256 of the original image bytes. Store those bytes once;
base64 is generated only for a vision request. Base64 alone does not deduplicate
and adds roughly one third to the payload size. No thumbnails are generated.
Uploads are capped at 20 MiB each. At five screenshots/day, monthly retained
storage is approximately `150 × average bytes × accepted fraction`; for 2 MiB
images and 40% acceptance, that is 120 MiB/month before backups. Current code
retains original quality rather than resizing screenshot text.

## Local catch-up

Set these in the local instance's ignored environment configuration:

```dotenv
SOURCE_REMOTE_URL=https://solenoid.home.arpa
SOURCE_READ_TOKEN=<read-only credential>
SOURCE_CONSUMER_ENABLED=false
# Optional; default 512 MiB disposable image cache.
SOURCE_CACHE_MAX_MB=512
```

Trust the mini-cloud CA on the client, or set `NODE_EXTRA_CA_CERTS` to its verified
public root certificate. Never disable certificate verification.

```sh
bun run source:catch-up
# Optional: download accepted images into the bounded cache for offline use.
bun run source:catch-up --prefetch
```

Run catch-up before using an instance that has been offline. It pulls current
source rows in cursor-ordered pages, including updates and tombstones. Only
source tables change: local chats, workflow runs, schedules, permission decisions,
and experimental outputs remain local. Each page and its cursor commit together.
The source-status panel displays upstream collection age and coverage. No
background local catch-up is installed, and catching up never launches workflows.

Images are fetched on demand through the authenticated source API. The local
cache evicts its oldest downloads as it approaches the configured budget;
`--prefetch` therefore does not promise every image remains cached if the library
exceeds that budget. Missing images fail explicitly when offline. Catch-up removes
cached objects whose records were deleted or rejected upstream.

If the remote database identity changes, catch-up stops. Use
`bun run source:catch-up --reset` to replace only the replicated source tables.
Do not run catch-up against the ingestion server's database. Local classification
and ingestion outputs do not automatically sync back to production.
