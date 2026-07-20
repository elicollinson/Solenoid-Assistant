// Test-only builder for synthetic typedstream blobs matching the anatomy in
// spec §7.2. Lives outside *.test.ts so both the decoder and reader tests can
// import it without re-registering each other's tests.

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

export function encodeLengthPrefix(len: number, marker?: 0x81 | 0x82): number[] {
  if (marker === 0x82 || (!marker && len > 32767)) {
    return [0x82, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >>> 24) & 0xff];
  }
  if (marker === 0x81 || len >= 128) {
    return [0x81, len & 0xff, (len >> 8) & 0xff];
  }
  return [len];
}

export interface BlobOptions {
  lengthMarker?: 0x81 | 0x82; // force a specific length-prefix width
  omitHeader?: boolean; // drop the streamtyped header (forces Tier B)
  corruptPlusMarker?: boolean; // replace the 0x2B payload marker (forces Tier B)
  rawLengthPrefix?: number[]; // override the encoded length prefix entirely
}

export function buildTypedstreamBlob(text: string, opts: BlobOptions = {}): Uint8Array {
  const utf8 = [...new TextEncoder().encode(text)];
  const bytes: number[] = [];
  if (!opts.omitHeader) bytes.push(0x04, 0x0b, ...ascii("streamtyped"), 0x81, 0xe8, 0x03);
  // Abbreviated class-definition section preceding the payload.
  bytes.push(0x84, 0x01, 0x40, ...ascii("NSMutableAttributedString"));
  bytes.push(...ascii("NSString"), 0x01, 0x95, 0x84, 0x01);
  bytes.push(opts.corruptPlusMarker ? 0x00 : 0x2b);
  bytes.push(...(opts.rawLengthPrefix ?? encodeLengthPrefix(utf8.length, opts.lengthMarker)));
  bytes.push(...utf8, 0x86);
  // Trailing attribute-dictionary-ish bytes that must be ignored.
  bytes.push(0x84, 0x02, 0x69, 0x49, 0x01, 0x92);
  return Uint8Array.from(bytes);
}
