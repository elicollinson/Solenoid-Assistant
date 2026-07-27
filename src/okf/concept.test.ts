import { describe, expect, test } from "bun:test";
import { mergeFrontmatter, orderFrontmatter, parseConcept, parseDocument, serializeConcept } from "./concept";

const DOC = `---
type: Metric
title: Revenue
tags: [finance]
---

# Definition

Recognized revenue.
`;

describe("parseDocument", () => {
  test("splits frontmatter from body", () => {
    const { frontmatter, body } = parseDocument(DOC);
    expect(frontmatter).toEqual({ type: "Metric", title: "Revenue", tags: ["finance"] });
    expect(body).toBe("# Definition\n\nRecognized revenue.\n");
  });

  test("a document with no frontmatter yields null, not an error", () => {
    const { frontmatter, body } = parseDocument("# Just markdown\n");
    expect(frontmatter).toBeNull();
    expect(body).toBe("# Just markdown\n");
  });

  test("empty frontmatter block parses as an empty mapping", () => {
    expect(parseDocument("---\n---\nbody\n").frontmatter).toEqual({});
    expect(parseDocument("---\n\n---\nbody\n").frontmatter).toEqual({});
  });

  test("a horizontal rule in the body is not mistaken for a delimiter", () => {
    const { frontmatter, body } = parseDocument("---\ntype: X\n---\n\nabove\n\n---\n\nbelow\n");
    expect(frontmatter).toEqual({ type: "X" });
    expect(body).toBe("above\n\n---\n\nbelow\n");
  });

  test("tolerates CRLF, a BOM, and trailing spaces on the delimiters", () => {
    const { frontmatter, body } = parseDocument("\uFEFF--- \r\ntype: X\r\n--- \r\nbody\r\n");
    expect(frontmatter).toEqual({ type: "X" });
    expect(body).toBe("body\n");
  });

  test("a file that is only frontmatter has an empty body", () => {
    expect(parseDocument("---\ntype: X\n---\n").body).toBe("");
    expect(parseDocument("---\ntype: X\n---").frontmatter).toEqual({ type: "X" });
  });

  test("malformed YAML throws rather than silently losing metadata", () => {
    expect(() => parseDocument("---\ntype: [unclosed\n---\nbody\n")).toThrow(/not valid YAML/);
  });

  test("a non-mapping frontmatter block is rejected", () => {
    expect(() => parseDocument("---\n- a\n- b\n---\nbody\n")).toThrow(/must be a YAML mapping/);
  });

  test("parseConcept rejects a document with no frontmatter (§11.1)", () => {
    expect(() => parseConcept("a/b", "# no frontmatter\n")).toThrow(/no YAML frontmatter/);
  });
});

describe("serializeConcept", () => {
  test("round-trips a document unchanged", () => {
    const parsed = parseConcept("metrics/revenue", DOC);
    expect(serializeConcept(parsed)).toBe(DOC);
  });

  test("preserves unknown producer-defined keys (§4.1)", () => {
    const doc = "---\ntype: X\nacme_internal_id: 42\nnested: { a: 1 }\n---\n\nbody\n";
    const parsed = parseConcept("x", doc);
    const out = serializeConcept(parsed);
    expect(out).toContain("acme_internal_id: 42");
    expect(parseDocument(out).frontmatter).toEqual(parsed.frontmatter);
  });

  test("a concept with no body ends after the closing delimiter", () => {
    expect(serializeConcept({ frontmatter: { type: "X" }, body: "   \n\n" })).toBe("---\ntype: X\n---\n");
  });

  test("canonical field order regardless of insertion order", () => {
    const yaml = serializeConcept({
      frontmatter: { sources: [], zzz: 1, description: "d", type: "T", title: "x" },
      body: "",
    });
    expect(yaml.split("\n").slice(1, 5)).toEqual(["type: T", "title: x", "description: d", "sources: []"]);
    expect(yaml).toContain("zzz: 1");
  });

  test("orderFrontmatter keeps unknown keys in their original relative order", () => {
    expect(Object.keys(orderFrontmatter({ b: 1, type: "T", a: 2 }))).toEqual(["type", "b", "a"]);
  });
});

describe("mergeFrontmatter", () => {
  test("undefined leaves a key alone, null removes it", () => {
    expect(mergeFrontmatter({ a: 1, b: 2, c: 3 }, { a: 9, b: undefined, c: null })).toEqual({ a: 9, b: 2 });
  });

  test("lists are replaced wholesale, not appended", () => {
    expect(mergeFrontmatter({ tags: ["a", "b"] }, { tags: ["c"] })).toEqual({ tags: ["c"] });
  });
});
