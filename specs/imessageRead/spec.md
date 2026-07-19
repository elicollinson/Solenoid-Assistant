# Spec: Reading iMessage / SMS History from chat.db (Bun + TypeScript)

**Status:** Implementation-ready · **As-of:** July 2026 (sources Nov 2025 – Apr 2026)
**Scope:** Read-only extraction of message history from the macOS Messages database into normalized `Message` records, suitable for a Bun/TS reimplementation of the prior Python `IMessageSource`.

## 1. Goals

- Incrementally fetch messages newer than a cursor, normalized into a stable `Message` shape.
- Recover text for messages where the `text` column is NULL (attributedBody decoding).
- Never write to, lock, or corrupt the live database.
- Zero third-party runtime dependencies (privacy requirement: nothing that can phone home).

## 2. Non-Goals

- Sending messages (separate concern; use `osascript` → Messages.app).
- Parsing attachment *content* (only metadata/flags).
- Contact name resolution (see companion spec `spec-contacts-read.md`).
- Any use of Apple private APIs.

## 3. Environment & Permissions

### 3.1 Data source

- Path: `~/Library/Messages/chat.db` (SQLite, WAL mode, held open by Messages.app).
- Companion files: `chat.db-wal`, `chat.db-shm`.

### 3.2 Full Disk Access (TCC) — the historical "authorization denied" issue

- Reading chat.db requires **Full Disk Access**, granted in System Settings → Privacy & Security → Full Disk Access.
- The grant attaches to the **executing process**, not the user or the script:
  - Interactive dev: your terminal app (iTerm/Terminal) holds the grant → works.
  - launchd: no terminal in the chain. The binary that opens the file needs its own grant (previously bit us in Feb 2026: pipeline worked in terminal, failed under launchd with `authorization denied`).
  - `bun build --compile` binary: the compiled binary itself needs FDA.
- **Requirement:** the runbook for deployment MUST include granting FDA to the exact binary launchd invokes, and re-granting after the binary is replaced (TCC grants are per-binary identity; a rebuilt unsigned binary may need re-adding).
- Error signature when missing: `unable to open database ... authorization denied` (or `SQLITE_CANTOPEN`).

### 3.3 Open mode

- MUST open read-only:

```ts
import { Database } from "bun:sqlite";
const db = new Database(
  `${process.env.HOME}/Library/Messages/chat.db`,
  { readonly: true }
);
```

- Alternative (fully isolated snapshot, e.g. for batch/backfill jobs): copy `chat.db`, `chat.db-wal`, `chat.db-shm` together to a temp dir and open the copy. Copying only `chat.db` without the WAL loses recent messages.
- MUST NOT run any statement that writes (including `PRAGMA journal_mode` changes).

## 4. Schema Reference (tables actually needed)

| Table | Purpose | Key columns |
|---|---|---|
| `message` | One row per message/event | `ROWID`, `guid`, `text`, `attributedBody`, `date`, `is_from_me`, `handle_id`, `service`, `associated_message_type`, `associated_message_guid`, `item_type`, `cache_has_attachments`, `balloon_bundle_id`, `date_read`, `date_delivered` |
| `handle` | One row per counterpart identifier | `ROWID`, `id` (E.164 phone or email), `service` |
| `chat` | One row per conversation | `ROWID`, `guid`, `chat_identifier`, `display_name`, `service_name` |
| `chat_message_join` | message ↔ chat | `chat_id`, `message_id` |
| `chat_handle_join` | chat ↔ participants | `chat_id`, `handle_id` |
| `attachment` / `message_attachment_join` | attachment metadata | `filename`, `mime_type`, `transfer_name` |

Notes:

- The same human can appear as **multiple handle rows** (e.g. one for iMessage, one for SMS, one per email). Never treat `handle.ROWID` as a person identifier; use the normalized `handle.id` string.
- `message.guid` is the stable unique message ID — use it as `source_id` and for idempotency/dedup.
- Group chats: `chat.display_name` is often empty; fall back to `chat_identifier` (`chat`-prefixed GUID for groups, the handle for 1:1).

## 5. Timestamps (Apple epoch)

- `message.date` (and `date_read`, `date_delivered`) are **nanoseconds since 2001-01-01 00:00:00 UTC**.
- Conversion to Unix seconds: `date / 1_000_000_000 + 978307200`.
- Conversion of a Unix-seconds cursor into query space: `(unixSeconds - 978307200) * 1_000_000_000`. Prefer converting the cursor into Apple-epoch nanoseconds and comparing raw integers in SQL (keeps the `date` column index usable) rather than converting every row in SQL.
- Guard (acceptance test): timestamps rendering as `2001-01-01` ⇒ epoch offset not applied; `1970-xx` ⇒ nanosecond divide missing.
- Legacy note: databases created before macOS 10.13 stored seconds, not nanoseconds. If ingesting old exported DBs, branch on magnitude (values < 1e10 ⇒ seconds).

## 6. Row Filtering Rules

A row in `message` is not necessarily a message. Apply, in order:

1. **Tapbacks/reactions:** `associated_message_type` values in 2000–2005 are reactions (love/like/dislike/laugh/emphasize/question); 3000–3005 are their removals. For the pipeline: keep only `associated_message_type = 0` (plain messages). If reactions are ever wanted, they reference their target via `associated_message_guid`.
2. **System events:** `item_type != 0` rows include group renames, participant add/remove, etc. Keep `item_type = 0`.
3. **App/sticker messages:** non-NULL `balloon_bundle_id` indicates an iMessage app payload (Apple Pay, games, stickers). Decide policy: default = skip (body is usually not meaningful text).
4. **Empty rows:** `text IS NULL AND attributedBody IS NULL` with `cache_has_attachments = 1` ⇒ attachment-only message. Emit with empty body + attachment flag, or skip, per pipeline policy (previous Python pipeline skipped).

## 7. Body Extraction — text vs attributedBody

### 7.1 The problem

Since macOS Ventura (~late 2022), many messages store content only in `attributedBody` (a binary NSArchiver "typedstream" serialization of NSMutableAttributedString), leaving `text` NULL. Selecting only `text` silently drops these. Both columns MUST be selected and coalesced in the app layer: `body = text ?? decode(attributedBody)`.

### 7.2 typedstream blob anatomy (what the decoder targets)

Example prefix: `04 0b "streamtyped" 81 e8 03 ...` followed by class-definition
sections for `NSMutableAttributedString`, `NSAttributedString`, `NSObject`,
`NSMutableString`, `NSString`, then the payload:

```
... 4E 53 53 74 72 69 6E 67 01 95 84 01 2B <len-prefix> <utf8 bytes> 86 ...
      N  S  S  t  r  i  n  g              ^0x2B marker              ^terminator
```

Attribute dictionaries (`NSDictionary`, `__kIMMessagePartAttributeName`, mention/link metadata) follow the string and are ignored for plain-text extraction.

### 7.3 Decoder algorithm (Tier A — primary)

1. Verify the blob starts with the `streamtyped` header (bytes `04 0b` + ASCII `streamtyped`). If absent, fail to Tier B.
2. Scan for the last occurrence of ASCII `NSString` **before** the first `0x2B` (`+`) marker; position after the `0x2B`.
3. Read the length prefix at that position. **Widths and signedness matter** (a known bug class in existing TS decoders):
   - `0x81` ⇒ next 2 bytes, **signed int16 little-endian**
   - `0x82` ⇒ next 4 bytes, **signed int32 little-endian**
   - `0x83` ⇒ next 8 bytes, **signed int64 little-endian**
   - any other byte ⇒ that byte itself as **signed int8**
   Reject negative lengths; bounds-check `pos + len <= blob.length`. Getting this wrong truncates messages ≥128 bytes and misreads messages ≥256 bytes.
4. Decode `len` bytes as UTF-8. Expect terminator byte `0x86` after (do not require it strictly; some payloads vary).
5. Return the decoded string.

### 7.4 Tier B — fallback

If Tier A fails (marker not found, bounds violation, invalid UTF-8): split the blob on the ASCII sequence `NSString`, skip 6 bytes (control + length region), then heuristically trim at the first `0x86`/`0x84` control byte. Log every Tier B hit with the message `guid` — a rising Tier B rate is the canary for Apple changing the serialization.

### 7.5 Requirements

- Decoder MUST be pure TS over `Uint8Array`/`Buffer` — no native or npm dependency.
- Decoder MUST never throw into the pipeline; failures yield `null` body + a logged `guid`.
- Unit-test with fixture blobs at lengths: <128, 128–255 (`0x81` path), 256–32767, and one with emoji/multibyte UTF-8.

## 8. Canonical Query

```sql
SELECT
  m.ROWID          AS rowid,
  m.guid           AS guid,
  m.text           AS text,
  m.attributedBody AS attributed_body,
  m.date           AS apple_ns,
  m.is_from_me     AS is_from_me,
  m.service        AS service,
  m.cache_has_attachments AS has_attachments,
  h.id             AS sender_handle,
  c.chat_identifier AS chat_identifier,
  c.display_name   AS chat_display_name
FROM message m
LEFT JOIN handle h             ON h.ROWID = m.handle_id
LEFT JOIN chat_message_join j  ON j.message_id = m.ROWID
LEFT JOIN chat c               ON c.ROWID = j.chat_id
WHERE m.date > :cursor_apple_ns
  AND m.associated_message_type = 0
  AND m.item_type = 0
ORDER BY m.date ASC;
```

Notes:

- `handle_id` is NULL/0 when `is_from_me = 1` in some cases — sender for outgoing messages is "me", not a handle.
- A message can theoretically join to multiple chats via `chat_message_join`; dedupe on `guid`, keep first.
- Use prepared statements; the cursor is the only parameter.

## 9. Output Schema (normalized `Message`)

Mirror of the prior Python model — keep field parity so downstream logic ports:

```ts
interface Message {
  sourceId: string;        // message.guid
  body: string;            // text ?? decoded attributedBody
  sender: string;          // handle.id: E.164 phone or lowercase email; "me" if is_from_me
  senderName: string | null; // enriched later by contacts layer
  conversationId: string;  // chat_identifier (non-empty on group chats — join must work)
  isFromMe: boolean;
  service: "iMessage" | "SMS" | string;
  timestamp: Date;         // UTC, converted per §5
  hasAttachments: boolean;
}
```

Normalization rules: phone handles are already E.164 from chat.db — pass through; email handles lowercase.

## 10. Cursor / Incremental-Fetch Semantics

- Cursor = max `message.date` (Apple-epoch ns) seen, persisted between runs (file or SQLite state db).
- `fetch(since)` returns `(messages, newCursor)`; `newCursor` MUST advance even when zero messages are returned (use `since` unchanged in that case).
- Strictly-greater-than comparison + `guid` dedupe protects against boundary duplicates.
- Late-arriving rows: Messages occasionally inserts rows with a `date` slightly in the past (sync from other devices). Mitigation: overlap the window by 60s and rely on `guid` dedupe.

## 11. Failure Modes (from prior Python pipeline, carried forward)

| Symptom | Cause |
|---|---|
| `authorization denied` opening db | FDA not granted to the executing binary (see §3.2 — check launchd context specifically) |
| All timestamps 2001-01-01 | Epoch offset `978307200` not applied |
| All timestamps 1970 | Nanosecond divide missing |
| Many empty bodies | attributedBody not decoded (§7) |
| Bodies truncated at odd lengths | Length-prefix decoded at wrong width/signedness (§7.3 step 3) |
| `conversationId` always empty | `chat_message_join`/`chat` join broken |
| Duplicate messages across runs | Cursor comparison `>=` instead of `>`, or no `guid` dedupe |

## 12. Acceptance Criteria

- [ ] Fetch of last 48h returns > 0 messages on an active account
- [ ] Timestamps are UTC and recent (not 1970/2001)
- [ ] Phone senders are E.164 (`+1…`); email senders lowercase
- [ ] `conversationId` non-empty for at least one group chat
- [ ] `isFromMe` shows a mix of true/false
- [ ] Zero rows with `associated_message_type != 0` (no tapbacks) in output
- [ ] A message known to have NULL `text` (verify via `sqlite3` by hand) round-trips with correct body
- [ ] A ≥200-character message decodes without truncation (0x81/int16 path)
- [ ] Re-running with the same cursor produces zero duplicates
- [ ] Works under launchd (not just interactive terminal)
- [ ] `bun.lockb` diff for this module: no new dependencies