# App-owned screenshot collections

New screenshots save into `collection_items` and `collection_sources` in the
normal app database. A local transaction writes the item and screenshot receipt
together. Retrying the same screenshot UUID is idempotent. Repeated source URLs
within one collection attach another source to the item; URL fragments are
ignored. Without a usable URL, newly extracted items match normalized titles.
Different URLs remain separate even when their titles match. User edits and
archive choices survive later matching screenshots.

The five supported classifications are Books, Movies, TV, Games, and Music.
The original content card retains finer types such as Song, Album, and Musician.
This change does not extend the classifier to arbitrary shopping products.
It does not attempt to correct earlier extraction mistakes or merge ambiguous
same-title records. Titles, descriptions, and notes are editable in Collections.

## Historical import

The Notion integration is retired. Use the already saved version-1 collection
snapshot; the importer accepts local files only and has no network client or
credential configuration. It cannot fetch, modify, or delete external records.

Preview the saved snapshot without opening a destination database:

```sh
bun run import:collections --snapshot ./data/notion-collections.json
```

Keep the snapshot private and transfer it through the deployment's existing
private file-copy path. It includes original properties, cover references, and
nested block content, including fields not rendered in the list. Cover image
bytes, comments, and linked pages are not archived. Original hosted file URLs
may expire. Screenshot provenance absent from the original records cannot be
reconstructed from the snapshot. Keep this file and the isolated preview DB out
of Git and out of container images (`data/` is ignored by both).

Import first into a separate database for inspection:

```sh
bun run import:collections --snapshot ./data/notion-collections.json --apply --database ./data/collections-import.db
```

The destination is always explicit, so an environment variable cannot silently
select a running database. Each Notion page receives an immutable receipt in
`collection_imports`. Identical source URLs in the same collection share an item
but retain every original page snapshot. Without a source URL, separate Notion
page IDs remain separate items. Repeat imports skip known pages and verify every
receipt against the snapshot. A changed historical page causes verification to
fail instead of overwriting existing source data or user edits.

Before applying to an existing app database, make a consistent SQLite backup
(using SQLite's backup API or `VACUUM INTO`; do not copy a live WAL database file
alone). Then apply the same snapshot to that explicitly named database and check
that the imported + skipped and verified counts equal the snapshot count.
The Collections export contains every item, archived items, screenshot sources,
and complete imported snapshots. Keep backups/exports out of version control.
For rollback of a first import into an existing DB, restore its consistent backup
while the app is stopped. Do not replace a production database with the isolated
preview database; the latter has no existing application records.

## Integration and remaining retirement

The migrations in this worktree are `0009_collections` and
`0010_collection_imports`. Other tasks also add migrations from the same baseline.
When integrating, regenerate/resequence later migrations against the already
merged schema, retaining all earlier journal entries and a continuous snapshot
chain. Merely renaming SQL files does not reconcile Drizzle schema snapshots.

No deployment or modification of the running database is part of this change.
The rollout order is:

1. Integrate Collections migrations 0009/0010, followed by Pushover 0011 and
   semantic search 0012; regenerate the later snapshots against merged schema.
2. Deploy the new code/schema, then take a consistent backup of the live DB.
3. Privately transfer the saved snapshot to that instance. It needs no Notion
   connection or secrets.
4. Apply the snapshot with `--apply --database <live-db-path>`, then verify
   imported + skipped and verified counts against the snapshot. Browse Collections
   and export the result to check source records before considering cleanup.

The Notion agents, clients, write endpoint, authentication scripts, credential
configuration, and deferred-call fallback have all been removed. Old workflow
rows may retain historical descriptions or permissions until explicitly reviewed
or synchronized; boot does not rewrite them. Deferred actions naming removed
tools fail as unavailable and cannot reconnect Notion. Existing `.env` files may
still contain unused Notion variables; remove them during operational secret
cleanup, separately from this local code change. Original Notion data is untouched.

## API

- `GET /api/collections`: `collection`, `q`, `archived`, `offset`, `limit` (1–100).
- `PATCH /api/collections/:id`: title (`name`), description, notes, archived.
- `GET /api/collections/export`: complete versioned JSON including provenance.
- `GET /api/collections/sources/:id/image`: retained accepted local image only;
  returns 404 for missing or no-longer-accepted assets, never reads arbitrary paths.

These routes follow the app's existing UI network-access model. Source upload
and replication token routes are unchanged. Original extraction snapshots and
Notion fields are data, never instructions or HTML. Only HTTP(S) external links
are rendered as links or cover images.
