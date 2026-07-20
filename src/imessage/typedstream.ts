// Pure-TS decoder for the NSArchiver "typedstream" blobs Messages stores in
// message.attributedBody (spec §7). Since macOS Ventura many messages have a
// NULL `text` column and carry their body only here, so this is load-bearing
// for reading history at all. Zero dependencies (privacy requirement) and it
// never throws — failures come back as a null text so the pipeline keeps going.

const PLUS = 0x2b; // marker byte that precedes the payload string's length
const TERMINATOR = 0x86;
const BACKREF = 0x84;

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const STREAMTYPED = ascii("streamtyped");
const NSSTRING = ascii("NSString");

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const utf8Lossy = new TextDecoder("utf-8");

export interface DecodedBody {
  text: string | null;
  // Which decode path produced the text; callers log every "B" hit — a rising
  // Tier B rate is the canary for Apple changing the serialization (§7.4).
  tier: "A" | "B" | null;
}

export function decodeAttributedBody(blob: Uint8Array | null | undefined): DecodedBody {
  if (!blob || blob.length === 0) return { text: null, tier: null };
  try {
    const tierA = decodeTierA(blob);
    if (tierA !== null) return { text: tierA, tier: "A" };
    const tierB = decodeTierB(blob);
    if (tierB !== null) return { text: tierB, tier: "B" };
  } catch {
    // MUST NOT throw into the pipeline (§7.5)
  }
  return { text: null, tier: null };
}

// Tier A (§7.3): locate the NSString payload via its 0x2B marker, then read an
// explicit length prefix and decode exactly that many UTF-8 bytes.
function decodeTierA(blob: Uint8Array): string | null {
  if (blob.length < 2 + STREAMTYPED.length) return null;
  if (blob[0] !== 0x04 || blob[1] !== 0x0b || !matchesAt(blob, STREAMTYPED, 2)) return null;

  // The payload sits after an NSString class reference, with the 0x2B marker a
  // few control bytes past the name (§7.2). The class table can mention
  // NSString more than once and attribute metadata after the payload can too,
  // so take the first occurrence that has a 0x2B within a short window rather
  // than trusting a single global search.
  let pos = -1;
  for (let at = indexOfSeq(blob, NSSTRING, 0); at !== -1; at = indexOfSeq(blob, NSSTRING, at + 1)) {
    const windowEnd = Math.min(blob.length, at + NSSTRING.length + 16);
    for (let k = at + NSSTRING.length; k < windowEnd; k++) {
      if (blob[k] === PLUS) {
        pos = k + 1;
        break;
      }
    }
    if (pos !== -1) break;
  }
  if (pos === -1 || pos >= blob.length) return null;

  const len = readLengthPrefix(blob, pos);
  if (len === null || len.value < 0 || len.next + len.value > blob.length) return null;
  try {
    return utf8Strict.decode(blob.subarray(len.next, len.next + len.value));
  } catch {
    return null; // invalid UTF-8 at that position ⇒ we misparsed; let Tier B try
  }
}

// Length prefix widths and signedness per §7.3 step 3 — all little-endian and
// SIGNED. Getting the width wrong truncates ≥128-byte messages; getting the
// signedness wrong misreads them, so negative values are rejected upstream.
function readLengthPrefix(
  blob: Uint8Array,
  pos: number,
): { value: number; next: number } | null {
  const marker = blob[pos]!;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (marker === 0x81) {
    if (pos + 3 > blob.length) return null;
    return { value: view.getInt16(pos + 1, true), next: pos + 3 };
  }
  if (marker === 0x82) {
    if (pos + 5 > blob.length) return null;
    return { value: view.getInt32(pos + 1, true), next: pos + 5 };
  }
  if (marker === 0x83) {
    if (pos + 9 > blob.length) return null;
    const value = view.getBigInt64(pos + 1, true);
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { value: Number(value), next: pos + 9 };
  }
  return { value: (marker << 24) >> 24, next: pos + 1 }; // the byte itself, as signed int8
}

// Tier B (§7.4): heuristic fallback — split on "NSString", skip the 6-byte
// control + length region, trim at the first terminator/backref control byte.
function decodeTierB(blob: Uint8Array): string | null {
  const at = indexOfSeq(blob, NSSTRING, 0);
  if (at === -1) return null;
  const start = at + NSSTRING.length + 6;
  if (start >= blob.length) return null;
  let end = start;
  while (end < blob.length && blob[end] !== TERMINATOR && blob[end] !== BACKREF) end++;
  const text = utf8Lossy.decode(blob.subarray(start, end)).trim();
  return text.length > 0 ? text : null;
}

function matchesAt(haystack: Uint8Array, needle: Uint8Array, at: number): boolean {
  if (at + needle.length > haystack.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (haystack[at + i] !== needle[i]) return false;
  }
  return true;
}

function indexOfSeq(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const last = haystack.length - needle.length;
  for (let i = Math.max(0, from); i <= last; i++) {
    if (matchesAt(haystack, needle, i)) return i;
  }
  return -1;
}
