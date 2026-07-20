// Read-only incremental reader for the macOS Messages database (spec §3–§11).
// Opens ~/Library/Messages/chat.db, runs the canonical query past a cursor,
// and normalizes rows into the stable `Message` shape.
import { Database } from "bun:sqlite";
import { decodeAttributedBody } from "./typedstream";
import { log } from "../core/logger";

export interface Message {
  sourceId: string; // message.guid — stable unique ID, used for dedup
  body: string; // text ?? decoded attributedBody
  sender: string; // E.164 phone or lowercase email; "me" if is_from_me
  senderName: string | null; // enriched later by the contacts layer
  conversationId: string; // chat_identifier
  isFromMe: boolean;
  service: "iMessage" | "SMS" | string;
  timestamp: Date; // UTC
  hasAttachments: boolean;
}

export interface FetchOptions {
  dbPath?: string;
  // Messages occasionally inserts rows dated slightly in the past (device
  // sync), so the query window overlaps the cursor by this much; consumers
  // dedupe on sourceId (§10). The returned cursor is NOT affected by overlap.
  overlapSeconds?: number;
  // Inclusive upper bound on message.date, for bounded historical windows.
  // Unbounded (cursor semantics, §10) when omitted.
  untilAppleNs?: bigint;
}

export interface FetchResult {
  messages: Message[];
  // max message.date seen (Apple-epoch ns); equals `since` when no rows.
  newCursor: bigint;
}

export const DEFAULT_DB_PATH = `${process.env.HOME}/Library/Messages/chat.db`;

const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200; // 2001-01-01T00:00:00Z in Unix seconds
const NS_PER_SECOND = 1_000_000_000n;

export function unixSecondsToAppleNs(unixSeconds: number): bigint {
  return BigInt(Math.floor(unixSeconds) - APPLE_EPOCH_OFFSET_SECONDS) * NS_PER_SECOND;
}

export function appleNsToDate(value: bigint): Date {
  // Databases created before macOS 10.13 stored seconds, not nanoseconds;
  // branch on magnitude (§5).
  const ns = value < 10_000_000_000n ? value * NS_PER_SECOND : value;
  return new Date(Number(ns / 1_000_000n) + APPLE_EPOCH_OFFSET_SECONDS * 1000);
}

// Canonical query (§8) plus the row-filtering rules of §6: no tapbacks, no
// system events, no iMessage-app/sticker payloads.
const QUERY = `
SELECT
  m.guid           AS guid,
  m.text           AS text,
  m.attributedBody AS attributed_body,
  m.date           AS apple_ns,
  m.is_from_me     AS is_from_me,
  m.service        AS service,
  m.cache_has_attachments AS has_attachments,
  h.id             AS sender_handle,
  c.chat_identifier AS chat_identifier
FROM message m
LEFT JOIN handle h            ON h.ROWID = m.handle_id
LEFT JOIN chat_message_join j ON j.message_id = m.ROWID
LEFT JOIN chat c              ON c.ROWID = j.chat_id
WHERE m.date > $cursor
  AND m.date <= $until
  AND m.associated_message_type = 0
  AND m.item_type = 0
  AND m.balloon_bundle_id IS NULL
ORDER BY m.date ASC`;

// Effectively-unbounded default for $until (max int64), keeping one prepared
// query for both the cursor and the bounded-window call paths.
const NO_UPPER_BOUND = 9_223_372_036_854_775_807n;

interface Row {
  guid: string;
  text: string | null;
  attributed_body: Uint8Array | null;
  apple_ns: bigint;
  is_from_me: bigint;
  service: string | null;
  has_attachments: bigint;
  sender_handle: string | null;
  chat_identifier: string | null;
}

export function fetchMessages(sinceAppleNs: bigint, options: FetchOptions = {}): FetchResult {
  const { dbPath = DEFAULT_DB_PATH, overlapSeconds = 60, untilAppleNs = NO_UPPER_BOUND } = options;
  const db = openReadOnly(dbPath);
  try {
    const windowStart = sinceAppleNs - BigInt(overlapSeconds) * NS_PER_SECOND;
    const rows = db.query(QUERY).all({ $cursor: windowStart, $until: untilAppleNs }) as Row[];

    const seen = new Set<string>();
    const messages: Message[] = [];
    let newCursor = sinceAppleNs;
    for (const row of rows) {
      if (row.apple_ns > newCursor) newCursor = row.apple_ns;
      // A message can join to multiple chats via chat_message_join; keep first (§8).
      if (seen.has(row.guid)) continue;
      seen.add(row.guid);

      const body = row.text ?? decodeBody(row);
      // Attachment-only and undecodable rows are skipped, matching the prior
      // Python pipeline's policy (§6.4).
      if (!body) continue;

      const isFromMe = row.is_from_me === 1n;
      const sender = isFromMe ? "me" : normalizeHandle(row.sender_handle);
      messages.push({
        sourceId: row.guid,
        body,
        sender,
        senderName: null,
        conversationId: row.chat_identifier ?? (isFromMe ? "" : sender),
        isFromMe,
        service: row.service ?? "unknown",
        timestamp: appleNsToDate(row.apple_ns),
        hasAttachments: row.has_attachments === 1n,
      });
    }
    return { messages, newCursor };
  } finally {
    db.close();
  }
}

function decodeBody(row: Row): string | null {
  if (!row.attributed_body) return null;
  const { text, tier } = decodeAttributedBody(row.attributed_body);
  if (tier === "B") {
    // Canary for Apple changing the serialization format (§7.4).
    log.warn(`attributedBody decoded via Tier B fallback`, { "message.guid": row.guid });
  } else if (text === null) {
    log.warn(`attributedBody decode failed`, { "message.guid": row.guid });
  }
  return text;
}

function normalizeHandle(handle: string | null): string {
  if (!handle) return "unknown";
  // Phone handles are already E.164 in chat.db — pass through; emails lowercase (§9).
  return handle.includes("@") ? handle.toLowerCase() : handle;
}

function openReadOnly(dbPath: string): Database {
  try {
    // safeIntegers: message.date is Apple-epoch nanoseconds (~2^60), which
    // silently loses precision as a JS number — keep it a bigint end to end.
    return new Database(dbPath, { readonly: true, safeIntegers: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/authorization denied|SQLITE_CANTOPEN|unable to open/i.test(msg)) {
      // §3.2: the FDA grant attaches to the executing process — under launchd
      // that means the invoked binary itself, and it must be re-granted after
      // the binary is replaced.
      throw new Error(
        `Cannot open ${dbPath}: ${msg}. The executing process needs Full Disk Access ` +
          `(System Settings → Privacy & Security → Full Disk Access). When running under ` +
          `launchd or as a compiled binary, the grant must be on that exact binary.`,
      );
    }
    throw err;
  }
}
