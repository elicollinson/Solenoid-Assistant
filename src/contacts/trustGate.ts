// Read-only loader for macOS Contacts (spec Path A §4): direct SQLite reads
// of every AddressBook-v22.abcddb (root + Sources/<UUID>/), unioned into an
// in-memory lookup. This is the pipeline's prompt-injection boundary (§3):
// messages from unknown senders are dropped BEFORE any LLM sees them, so
// failure is closed — zero contacts loaded means construction throws.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/logger";
import type { Message } from "../imessage/reader";
import { lastTenDigits, normalizeEmail, normalizePhone } from "./normalize";

export interface TrustGate {
  isTrusted(sender: string): boolean; // sender = normalized handle, or "me"
  resolveName(sender: string): string | null;
  size(): { phones: number; emails: number };
  /** Keep message iff isFromMe || isTrusted(sender); enrich senderName (§6). */
  filter(messages: Message[]): Message[];
}

export interface TrustGateOptions {
  addressBookDir?: string;
  defaultCountryCode?: string;
  /** Override the closed-failure throw for genuinely-empty address books (§6). */
  allowEmpty?: boolean;
}

export const DEFAULT_ADDRESS_BOOK_DIR = `${process.env.HOME}/Library/Application Support/AddressBook`;
const DB_FILENAME = "AddressBook-v22.abcddb";

// §4.1: contacts usually live under Sources/<UUID>/ (iCloud, Google, ...),
// not the root db — reading only the root is the known zero-contacts trap.
export function discoverAddressBookDbs(dir = DEFAULT_ADDRESS_BOOK_DIR): string[] {
  const paths: string[] = [];
  const root = join(dir, DB_FILENAME);
  if (existsSync(root)) paths.push(root);
  const sourcesDir = join(dir, "Sources");
  if (existsSync(sourcesDir)) {
    let entries: string[];
    try {
      entries = readdirSync(sourcesDir);
    } catch (err) {
      // TCC denials on ~/Library surface as EPERM at the directory level,
      // before SQLite is ever involved (§4.2).
      if ((err as NodeJS.ErrnoException).code === "EPERM") throw fdaError(sourcesDir, err);
      throw err;
    }
    for (const entry of entries) {
      const candidate = join(sourcesDir, entry, DB_FILENAME);
      if (existsSync(candidate)) paths.push(candidate);
    }
  }
  return paths;
}

// §4.3 — undocumented Core Data schema; column renames land here as
// "no such table/column" and get a single clear diagnostic instead.
const PHONE_QUERY = `
SELECT r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, r.ZNICKNAME AS nickname,
       r.ZORGANIZATION AS org, p.ZFULLNUMBER AS value
FROM ZABCDRECORD r JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK`;

const EMAIL_QUERY = `
SELECT r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, r.ZNICKNAME AS nickname,
       r.ZORGANIZATION AS org, e.ZADDRESS AS value
FROM ZABCDRECORD r JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK`;

interface ContactRow {
  first: string | null;
  last: string | null;
  nickname: string | null;
  org: string | null;
  value: string | null;
}

function displayName(row: ContactRow): string | null {
  const fullName = `${row.first ?? ""} ${row.last ?? ""}`.trim();
  return fullName || row.nickname?.trim() || row.org?.trim() || null;
}

export function createTrustGate(options: TrustGateOptions = {}): TrustGate {
  const {
    addressBookDir = DEFAULT_ADDRESS_BOOK_DIR,
    defaultCountryCode = "1",
    allowEmpty = false,
  } = options;

  // value is null for contacts that have the handle but no usable name —
  // still trusted, resolveName falls back to the raw handle (§4.3).
  const phones = new Map<string, string | null>();
  const phonesLast10 = new Map<string, string | null>();
  const emails = new Map<string, string | null>();

  const put = (map: Map<string, string | null>, key: string, name: string | null) => {
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, name);
      return;
    }
    // First non-empty name wins across sources (§6).
    if (!existing && name) map.set(key, name);
    else if (existing && name && existing !== name) {
      log.debug(`contacts: name collision for ${key}: kept "${existing}", ignored "${name}"`);
    }
  };

  const dbPaths = discoverAddressBookDbs(addressBookDir);
  for (const dbPath of dbPaths) {
    const db = openReadOnly(dbPath);
    try {
      const phoneRows = runSchemaQuery(db, PHONE_QUERY, dbPath) as ContactRow[];
      for (const row of phoneRows) {
        if (!row.value) continue;
        const e164 = normalizePhone(row.value, defaultCountryCode);
        if (!e164) continue; // short code in Contacts — not a trust key (§5.3)
        const name = displayName(row);
        put(phones, e164, name);
        const last10 = lastTenDigits(row.value);
        if (last10) put(phonesLast10, last10, name);
      }
      const emailRows = runSchemaQuery(db, EMAIL_QUERY, dbPath) as ContactRow[];
      for (const row of emailRows) {
        if (!row.value) continue;
        put(emails, normalizeEmail(row.value), displayName(row));
      }
    } finally {
      db.close();
    }
  }

  // Closed-failure rule (§3, §6): an empty gate must never silently pass
  // messages through — it must refuse to construct.
  if (phones.size + emails.size === 0 && !allowEmpty) {
    throw new Error(
      `Trust gate loaded zero contacts from ${dbPaths.length} database(s) under ${addressBookDir}. ` +
        `Refusing to construct (closed failure — spec contactsRead §3). Likely causes: contacts live ` +
        `under Sources/<UUID>/ and were not found, Full Disk Access is missing, or the schema changed (§4.3). ` +
        `Pass allowEmpty: true only for a genuinely empty address book.`,
    );
  }
  log.info(
    `contacts: loaded ${phones.size} phones, ${emails.size} emails from ${dbPaths.length} database(s)`,
  );

  const lookup = (sender: string): { found: boolean; name: string | null } => {
    if (sender.includes("@")) {
      const key = normalizeEmail(sender);
      return emails.has(key)
        ? { found: true, name: emails.get(key) ?? null }
        : { found: false, name: null };
    }
    const e164 = normalizePhone(sender, defaultCountryCode);
    if (e164 && phones.has(e164)) return { found: true, name: phones.get(e164) ?? null };
    // Secondary last-10 lookup only on exact miss, never for short codes (§5.3).
    const last10 = lastTenDigits(sender);
    if (last10 && phonesLast10.has(last10)) {
      return { found: true, name: phonesLast10.get(last10) ?? null };
    }
    return { found: false, name: null };
  };

  return {
    isTrusted: (sender) => sender === "me" || lookup(sender).found,
    resolveName: (sender) => {
      const { found, name } = lookup(sender);
      return found ? (name ?? sender) : null;
    },
    size: () => ({ phones: phones.size, emails: emails.size }),
    filter(messages) {
      return messages
        .filter((m) => m.isFromMe || lookup(m.sender).found)
        .map((m) => (m.isFromMe ? m : { ...m, senderName: lookup(m.sender).name }));
    },
  };
}

// §7: contacts change rarely and pipeline runs are short-lived — build once
// per process and reuse.
let cachedGate: TrustGate | null = null;
export function getTrustGate(options?: TrustGateOptions): TrustGate {
  cachedGate ??= createTrustGate(options);
  return cachedGate;
}

function runSchemaQuery(db: Database, query: string, dbPath: string): unknown[] {
  try {
    return db.query(query).all();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such (table|column)/i.test(msg)) {
      // §8 canary: Apple renamed the Core Data schema in a macOS update.
      throw new Error(
        `Contacts schema mismatch in ${dbPath}: ${msg}. The undocumented ZABCD* schema ` +
          `(spec contactsRead §4.3) has likely changed in this macOS release — switch to ` +
          `Path B (Swift CNContactStore helper, §4 Path B).`,
      );
    }
    throw err;
  }
}

function openReadOnly(dbPath: string): Database {
  try {
    return new Database(dbPath, { readonly: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/authorization denied|SQLITE_CANTOPEN|unable to open/i.test(msg)) {
      throw fdaError(dbPath, err);
    }
    throw err;
  }
}

// §4.2: same FDA grant as chat.db, same per-binary/launchd caveats.
function fdaError(path: string, cause: unknown): Error {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Cannot read ${path}: ${msg}. The executing process needs Full Disk Access ` +
      `(System Settings → Privacy & Security → Full Disk Access). When running under ` +
      `launchd or as a compiled binary, the grant must be on that exact binary.`,
  );
}
