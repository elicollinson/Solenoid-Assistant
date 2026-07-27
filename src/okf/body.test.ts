import { describe, expect, test } from "bun:test";
import { applyBodyOp, findSection, parseSections, sectionContent } from "./body";

const BODY = `# Schema

| Column | Type |
|--------|------|
| id     | STRING |

## Notes

Nested under Schema.

# Examples

    SELECT 1
`;

describe("parseSections", () => {
  test("finds headings and their extents", () => {
    const sections = parseSections(BODY);
    expect(sections.map((s) => [s.title, s.level])).toEqual([
      ["Schema", 1],
      ["Notes", 2],
      ["Examples", 1],
    ]);
  });

  test("a subsection travels with its parent", () => {
    const schema = findSection(BODY, "Schema");
    expect(schema).toBeDefined();
    expect(sectionContent(BODY, schema!)).toContain("Nested under Schema.");
  });

  test("ignores '#' lines inside a fenced code block", () => {
    const body = "# Computation\n\n```python\n# not a heading\nx = 1\n```\n\n# Notes\n\nreal\n";
    expect(parseSections(body).map((s) => s.title)).toEqual(["Computation", "Notes"]);
  });

  test("handles tilde fences and unclosed fences", () => {
    expect(parseSections("# A\n\n~~~\n# hidden\n~~~\n\n# B\n").map((s) => s.title)).toEqual(["A", "B"]);
    expect(parseSections("# A\n\n```\n# hidden\n").map((s) => s.title)).toEqual(["A"]);
  });

  test("strips closing hashes and matches case-insensitively", () => {
    expect(parseSections("## Schema ##\n").map((s) => s.title)).toEqual(["Schema"]);
    expect(findSection("# Schema\n", "  sChEmA ")).toBeDefined();
  });

  test("a body with no headings has no sections", () => {
    expect(parseSections("just prose\n")).toEqual([]);
  });
});

describe("applyBodyOp", () => {
  test("replace swaps content and keeps the heading", () => {
    const out = applyBodyOp(BODY, { op: "replace", section: "Examples", content: "SELECT 2" });
    expect(out).toContain("# Examples\n\nSELECT 2");
    expect(out).not.toContain("SELECT 1");
    expect(out).toContain("# Schema"); // untouched
  });

  test("replace on a parent section removes its subsections", () => {
    const out = applyBodyOp(BODY, { op: "replace", section: "Schema", content: "new" });
    expect(out).not.toContain("## Notes");
    expect(out).toContain("# Examples");
  });

  test("append adds to the end of a section without disturbing the next one", () => {
    const out = applyBodyOp(BODY, { op: "append", section: "Examples", content: "SELECT 2" });
    expect(out).toContain("SELECT 1");
    expect(out).toContain("SELECT 2");
    expect(out.indexOf("SELECT 1")).toBeLessThan(out.indexOf("SELECT 2"));
  });

  test("add creates a new section at the end", () => {
    const out = applyBodyOp(BODY, { op: "add", section: "Joins", content: "on id" });
    expect(out.endsWith("# Joins\n\non id")).toBe(true);
  });

  test("add honors a heading level", () => {
    expect(applyBodyOp("# A\n\nx\n", { op: "add", section: "B", content: "y", level: 3 })).toContain("### B");
  });

  test("add on an empty body does not leave leading blank lines", () => {
    expect(applyBodyOp("", { op: "add", section: "Definition", content: "text" })).toBe("# Definition\n\ntext");
  });

  test("add refuses to duplicate an existing section", () => {
    expect(() => applyBodyOp(BODY, { op: "add", section: "Schema", content: "x" })).toThrow(/already exists/);
  });

  test("delete removes the section and its content", () => {
    const out = applyBodyOp(BODY, { op: "delete", section: "Examples" });
    expect(out).not.toContain("Examples");
    expect(out).toContain("# Schema");
  });

  test("replaceAll rewrites the body", () => {
    expect(applyBodyOp(BODY, { op: "replaceAll", content: "  fresh  " })).toBe("fresh");
  });

  test("a missing section fails loudly and names what is available", () => {
    expect(() => applyBodyOp(BODY, { op: "replace", section: "Joins", content: "x" })).toThrow(
      /No section "Joins".*Schema, Notes, Examples/s,
    );
    expect(() => applyBodyOp("prose only", { op: "append", section: "Joins", content: "x" })).toThrow(
      /body has no headings/,
    );
  });

  test("repeated edits do not accrete blank lines", () => {
    let body = "# A\n\nx\n";
    for (let i = 0; i < 5; i++) body = applyBodyOp(body, { op: "append", section: "A", content: `line ${i}` });
    expect(body).not.toMatch(/\n\n\n/);
  });

  test("replacing with empty content leaves a bare heading", () => {
    expect(applyBodyOp("# A\n\nx\n\n# B\n\ny\n", { op: "replace", section: "A", content: "" })).toBe(
      "# A\n\n# B\n\ny",
    );
  });
});
