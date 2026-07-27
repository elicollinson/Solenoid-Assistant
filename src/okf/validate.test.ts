import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openBundle, type Bundle } from "./bundle";
import { validateBundle } from "./validate";

let dir: string;
let bundle: Bundle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "okf-validate-"));
  bundle = openBundle(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function put(rel: string, contents: string): Promise<void> {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  await Bun.write(join(dir, rel), contents);
}

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("errors — the three structural rules (§11)", () => {
  test("a concept with no frontmatter block", async () => {
    await put("a.md", "# just markdown\n");
    const report = await validateBundle(bundle);
    expect(report.conformant).toBe(false);
    expect(codes(report.errors)).toEqual(["unparseable"]);
  });

  test("unparseable YAML", async () => {
    await put("a.md", "---\ntype: [unclosed\n---\n\nx\n");
    expect(codes((await validateBundle(bundle)).errors)).toEqual(["unparseable"]);
  });

  test("a missing or empty type", async () => {
    await put("a.md", "---\ntitle: No type\n---\n\nx\n");
    await put("b.md", "---\ntype: '  '\n---\n\nx\n");
    const report = await validateBundle(bundle);
    expect(codes(report.errors)).toEqual(["missing_type", "missing_type"]);
    expect(report.conceptCount).toBe(2); // still counted, just not conformant
  });

  test("a nested index.md must carry no frontmatter (§8)", async () => {
    await put("sub/a.md", "---\ntype: M\n---\n\nx\n");
    await put("sub/index.md", "---\nokf_version: \"0.2\"\n---\n\n# Concepts\n");
    expect(codes((await validateBundle(bundle)).errors)).toEqual(["index_frontmatter"]);
  });

  test("a root index.md may declare okf_version and nothing else (§12)", async () => {
    await put("a.md", "---\ntype: M\n---\n\nx\n");
    await put("index.md", "---\nokf_version: \"0.2\"\n---\n\n# Concepts\n");
    expect((await validateBundle(bundle)).conformant).toBe(true);

    await put("index.md", "---\nokf_version: \"0.2\"\ntitle: Nope\n---\n\n# Concepts\n");
    expect(codes((await validateBundle(bundle)).errors)).toEqual(["index_frontmatter"]);
  });

  test("log.md date headings must be ISO 8601 (§9)", async () => {
    await put("log.md", "# Bundle Update Log\n\n## July 25, 2026\n* **Update**: x\n\n## 2026-07-20\n* **Update**: y\n");
    const errors = (await validateBundle(bundle)).errors;
    expect(codes(errors)).toEqual(["log_date"]);
    expect(errors[0]?.message).toContain("July 25, 2026");
  });
});

describe("info — things §11 says MUST NOT be rejected", () => {
  test("a broken link is reported but does not fail the bundle", async () => {
    await put("a.md", "---\ntype: M\n---\n\nSee [b](/b.md), which nobody has written yet.\n");
    const report = await validateBundle(bundle);
    expect(report.conformant).toBe(true);
    expect(report.errors).toEqual([]);
    expect(codes(report.info)).toEqual(["broken_link"]);
  });

  test("unknown types, unknown keys, and every missing optional family are fine", async () => {
    await put(
      "a.md",
      "---\ntype: Some Type Nobody Registered\nacme_custom: { deeply: [nested] }\n---\n\nx\n",
    );
    const report = await validateBundle(bundle);
    expect(report.conformant).toBe(true);
    expect(report.info).toEqual([]);
  });

  test("an external or directory link is never called broken", async () => {
    await put("a.md", "---\ntype: M\n---\n\n[x](https://example.com) [y](sub/) [z](references/a.py)\n");
    expect((await validateBundle(bundle)).info).toEqual([]);
  });

  test("an empty bundle is conformant", async () => {
    expect(await validateBundle(bundle)).toMatchObject({ conformant: true, conceptCount: 0 });
  });
});
