# Spec: Reading macOS Contacts for Handle Resolution & Trust Gate (Bun + TypeScript)

**Status:** Implementation-ready · **As-of:** July 2026 (sources Dec 2024 – May 2026; schema stable across recent macOS releases but undocumented — see §8)
**Scope:** Read-only access to the user's macOS Contacts to (a) resolve iMessage handles (phones/emails) to display names and (b) build the trusted-sender set that gates messages before any LLM sees them. Reimplementation of the prior Python `TrustGate` + `normalize_phone`.

## 1. Goals

- Load all contacts (local + iCloud/synced sources) into an in-memory lookup.
- `isTrusted(sender)` — membership check against known phones/emails.
- `resolveName(handle)` — handle → display name enrichment.
- Zero third-party runtime dependencies for the primary path.

## 2. Non-Goals

- Writing/creating/deleting contacts.
- Contact photos, addresses, birthdays, notes (notes additionally require a special Apple entitlement).
- Cross-source contact unification beyond simple key-level dedupe.

## 3. Security Context (why this exists)

The trust gate is the pipeline's **prompt-injection boundary**: messages from senders not in Contacts are dropped **before** LLM processing, so arbitrary inbound texts cannot steer the agent. Consequences:

- Failure MUST be closed: if zero contacts load (path wrong, schema changed), the gate MUST refuse to pass any non-`isFromMe` message and surface a loud error — never silently pass-through.
- `isFromMe` messages always pass the gate.

## 4. Implementation Paths

Two sanctioned approaches. **Path A is primary** (matches prior Python implementation, zero native code); **Path B is the architecturally proper upgrade** if schema fragility ever bites.

### Path A (primary): direct SQLite read of the AddressBook database

#### 4.1 Locations — MUST union all that exist

| Location | Contains |
|---|---|
| `~/Library/Application Support/AddressBook/AddressBook-v22.abcddb` | Local ("On My Mac") contacts |
| `~/Library/Application Support/AddressBook/Sources/<UUID>/AddressBook-v22.abcddb` | One per synced account (iCloud, Google, Exchange) |

Discovery algorithm:

1. Enumerate `Sources/`; collect every `<UUID>/AddressBook-v22.abcddb` that exists.
2. Also include the root `AddressBook-v22.abcddb` if present.
3. Open each read-only; union results.

**Known failure mode (previously bit us):** reading only the root db while contacts live in an iCloud source ⇒ zero or near-zero contacts loaded ⇒ trust gate drops everything. The prior Python symptom "all messages dropped / zero contacts loaded" maps here.

#### 4.2 Permissions

- Covered by the **same Full Disk Access grant** as chat.db — no separate Contacts TCC prompt for raw file reads. Same per-binary / launchd caveats as the Messages spec §3.2.

#### 4.3 Schema (Core Data artifact — undocumented)

| Table | Columns used | Meaning |
|---|---|---|
| `ZABCDRECORD` | `Z_PK`, `ZFIRSTNAME`, `ZLASTNAME`, `ZNICKNAME`, `ZORGANIZATION` | Contact records (also non-person rows — see filter below) |
| `ZABCDPHONENUMBER` | `ZFULLNUMBER`, `ZOWNER` | Phone numbers; `ZOWNER` → `ZABCDRECORD.Z_PK` |
| `ZABCDEMAILADDRESS` | `ZADDRESS`, `ZOWNER` | Emails; `ZOWNER` → `ZABCDRECORD.Z_PK` |

Canonical queries (per source db):

```sql
SELECT r.Z_PK, r.ZFIRSTNAME, r.ZLASTNAME, r.ZNICKNAME, r.ZORGANIZATION,
       p.ZFULLNUMBER
FROM ZABCDRECORD r JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK;

SELECT r.Z_PK, r.ZFIRSTNAME, r.ZLASTNAME, r.ZNICKNAME, r.ZORGANIZATION,
       e.ZADDRESS
FROM ZABCDRECORD r JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK;
```

Handling rules:

- Display name = `"${ZFIRSTNAME} ${ZLASTNAME}"` trimmed; fall back to `ZNICKNAME`, then `ZORGANIZATION`, then the raw handle.
- `ZFULLNUMBER` is free-form human input: `(937) 974-9491`, `937-974-9491`, `+1 937 974 9491`, extensions, unicode spaces. Normalize per §5 before keying. Some builds append trailing metadata (e.g. `_$!<Mobile>!$_` style labels live elsewhere, but stray non-digits occur) — normalization strips all non-digits, which absorbs this.
- Open every db `{ readonly: true }`.

### Path B (upgrade): Swift `CNContactStore` helper spawned from Bun

Use when Path A breaks on a macOS update, or when proper unified contacts / official permission semantics are wanted.

- Small Swift binary using the public Contacts framework; enumerates contacts, prints JSON to stdout.

```swift
// contacts-dump/main.swift — compile: swiftc -O -o contacts-dump main.swift
import Contacts
let store = CNContactStore()
let keys = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey,
            CNContactOrganizationNameKey,
            CNContactPhoneNumbersKey, CNContactEmailAddressesKey] as [CNKeyDescriptor]
var out: [[String: Any]] = []
try store.enumerateContacts(with: CNContactFetchRequest(keysToFetch: keys)) { c, _ in
  out.append([
    "givenName": c.givenName, "familyName": c.familyName,
    "nickname": c.nickname, "org": c.organizationName,
    "phones": c.phoneNumbers.map { $0.value.stringValue },
    "emails": c.emailAddresses.map { String($0.value) },
  ])
}
print(String(data: try JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
```

- Bun side: `JSON.parse(await new Response(Bun.spawn(["./contacts-dump"]).stdout).text())`.
- Permissions: triggers the real **Contacts** TCC prompt (separate from FDA), attributed to the responsible parent process. The prompt does not appear in embedded terminals (e.g. VS Code's) — first run MUST be from Terminal/iTerm or the launchd context that will own the grant.
- JSON output contract is the interface; the loader downstream of it is shared with Path A.
- Cache the dump (contacts change rarely); full enumeration is the expensive call.

## 5. Normalization Spec (shared by both paths — MUST match Messages-side handles)

iMessage handles arrive as clean E.164 (`+19375551234`) or lowercase-able emails; Contacts stores arbitrary human formatting. Both sides MUST normalize through the same functions.

### 5.1 `normalizePhone(raw: string): string | null`

1. Strip everything except digits (`/\D/g`).
2. Branch on digit count:
   - 10 digits → `+1` + digits (US default — matches prior pipeline; make the default country code a config value)
   - 11 digits starting with `1` → `+` + digits
   - 7–15 digits otherwise → `+` + digits
   - <7 digits → `null` (short codes: see §5.3)
3. Output is E.164-shaped; no validation beyond length.

Test vectors (from prior pipeline): `(937) 974-9491`, `937-974-9491`, `+1 937 974 9491`, `+19379749491`, `9379749491` — all ⇒ `+19379749491`.

### 5.2 `normalizeEmail(raw: string): string`

Trim + lowercase. (iMessage email handles are already lowercase; Contacts may not be.)

### 5.3 Secondary key — last-10-digits

International formatting mismatches (contact saved without country code while handle has one, or vice versa) defeat exact E.164 matching. Maintain a secondary lookup keyed on the last 10 digits; consult it only when the exact-E.164 lookup misses. Do not apply to handles with <10 digits (short codes) — those are untrusted by definition unless explicitly allowlisted in config.

## 6. TrustGate Behavior Contract

```ts
interface TrustGate {
  isTrusted(sender: string): boolean;   // sender = normalized handle, or "me"
  resolveName(sender: string): string | null;
  size(): { phones: number; emails: number };
}
```

- Construction: load all sources (§4.1), build `Map<key, name>` for phones (E.164 + last-10 secondary) and emails.
- `filter(messages)`: keep message iff `isFromMe || isTrusted(sender)`; enrich `senderName` on kept messages.
- **Closed-failure rule (§3):** if `size().phones + size().emails === 0`, construction MUST throw (configurable override flag for genuinely-empty address books, default off).
- Lookup precedence for names when the same key appears in multiple sources: first non-empty name wins; log collisions at debug.

## 7. Caching & Refresh

- In-memory cache built once per process run (pipeline runs are short-lived under launchd — rebuild each run is fine and picks up contact edits automatically).
- If used in a long-lived daemon: refresh on interval (e.g. 15 min) or on mtime change of any source `.abcddb`.

## 8. Fragility & Canaries (Path A)

The `Z*` schema is an undocumented Core Data artifact; Apple can rename tables/columns in any macOS release. Required guards:

- Startup canary: after load, assert `size()` roughly matches expectations (non-zero; optionally compare against a persisted last-known count and warn on >50% drop).
- Wrap schema queries so a `no such table/column` error produces a single clear diagnostic naming this spec's §4.3, not a stack trace.
- After every major macOS upgrade: run acceptance criteria before trusting the pipeline.
- If broken: switch to Path B (interface-compatible by design).

## 9. Failure Modes

| Symptom | Cause |
|---|---|
| Zero contacts loaded | Only root db read while contacts live under `Sources/<UUID>/`; or wrong path; or schema change |
| All messages dropped by gate | Normalization mismatch between handle format and Contacts format (§5) — check test vectors first |
| `senderName` always empty but gate passes | Name lookup keyed differently than trust lookup — both MUST share normalization |
| `authorization denied` on `.abcddb` | FDA missing for the executing binary (launchd context) |
| Contacts TCC prompt never appears (Path B) | First run happened in an embedded terminal — run from Terminal.app once |
| Trusted contact's messages dropped | Contact saved without country code and last-10 secondary lookup not implemented |

## 10. Acceptance Criteria

- [ ] All five §5.1 test vectors normalize to `+19379749491`
- [ ] Loaded phone/email counts are non-zero and roughly match Contacts.app's visible count
- [ ] Contacts from an iCloud source (not just "On My Mac") resolve — verify with a known iCloud-only contact
- [ ] `filter()` over last 48h of real messages: own messages survive; known contacts enriched with non-empty `senderName`; at least spam/unknown senders drop when present
- [ ] Spot check: no false drops of recognizable contacts
- [ ] Zero-contacts condition throws (closed failure), not silent pass-through
- [ ] Path A module has no npm dependencies; Path B's only external artifact is the locally compiled Swift binary
- [ ] Works under launchd, not just interactive terminal
