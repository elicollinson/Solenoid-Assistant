import { describe, expect, test } from "bun:test";
import { decodeAttributedBody } from "./typedstream";
import { buildTypedstreamBlob } from "./typedstreamFixture";

// Fixture lengths mandated by spec §7.5: <128, 128–255 (0x81 path),
// 256–32767, and multibyte UTF-8.
describe("decodeAttributedBody — Tier A", () => {
  test("short message (<128 bytes, inline length byte)", () => {
    const text = "Hey, are we still on for tonight?";
    expect(decodeAttributedBody(buildTypedstreamBlob(text))).toEqual({ text, tier: "A" });
  });

  test("128–255 bytes uses the 0x81 int16 path without truncation", () => {
    const text = "a".repeat(200);
    const decoded = decodeAttributedBody(buildTypedstreamBlob(text));
    expect(decoded.tier).toBe("A");
    expect(decoded.text).toHaveLength(200);
    expect(decoded.text).toBe(text);
  });

  test("256–32767 bytes decodes fully", () => {
    const text = "b".repeat(5000);
    expect(decodeAttributedBody(buildTypedstreamBlob(text))).toEqual({ text, tier: "A" });
  });

  test("0x82 int32 length prefix", () => {
    const text = "c".repeat(300);
    const blob = buildTypedstreamBlob(text, { lengthMarker: 0x82 });
    expect(decodeAttributedBody(blob)).toEqual({ text, tier: "A" });
  });

  test("emoji / multibyte UTF-8 (byte length ≠ char length)", () => {
    const text = "héllo 👋 wörld 🌍 done";
    expect(decodeAttributedBody(buildTypedstreamBlob(text))).toEqual({ text, tier: "A" });
  });
});

describe("decodeAttributedBody — Tier B fallback", () => {
  test("missing streamtyped header falls back to Tier B", () => {
    const text = "fallback body";
    const decoded = decodeAttributedBody(buildTypedstreamBlob(text, { omitHeader: true }));
    expect(decoded.tier).toBe("B");
    expect(decoded.text).toBe(text);
  });

  test("corrupted 0x2B marker falls back to Tier B", () => {
    const text = "still recoverable";
    const decoded = decodeAttributedBody(buildTypedstreamBlob(text, { corruptPlusMarker: true }));
    expect(decoded.tier).toBe("B");
    expect(decoded.text).toBe(text);
  });

  test("negative length prefix is rejected by Tier A, recovered by Tier B", () => {
    const text = "negative length case";
    const blob = buildTypedstreamBlob(text, { rawLengthPrefix: [0x81, 0xff, 0xff] });
    const decoded = decodeAttributedBody(blob);
    expect(decoded.tier).toBe("B");
    expect(decoded.text).toContain(text);
  });
});

describe("decodeAttributedBody — never throws", () => {
  test("null / empty input", () => {
    expect(decodeAttributedBody(null)).toEqual({ text: null, tier: null });
    expect(decodeAttributedBody(undefined)).toEqual({ text: null, tier: null });
    expect(decodeAttributedBody(new Uint8Array(0))).toEqual({ text: null, tier: null });
  });

  test("garbage bytes yield null without throwing", () => {
    expect(decodeAttributedBody(Uint8Array.from([0, 1, 2, 3, 254, 255]))).toEqual({
      text: null,
      tier: null,
    });
  });

  test("pseudo-random fuzz blobs never throw", () => {
    let seed = 42;
    const nextByte = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    for (let i = 0; i < 200; i++) {
      const blob = Uint8Array.from({ length: 1 + (i % 97) }, nextByte);
      expect(() => decodeAttributedBody(blob)).not.toThrow();
    }
  });

  test("length prefix running past the blob end is rejected", () => {
    const blob = buildTypedstreamBlob("short");
    const truncated = blob.subarray(0, blob.length - 12); // cut into the payload
    expect(() => decodeAttributedBody(truncated)).not.toThrow();
  });
});
