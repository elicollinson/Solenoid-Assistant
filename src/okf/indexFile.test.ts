import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openBundle, type Bundle } from "./bundle";
import { declaredVersion, regenerateIndex, regenerateIndexChain, renderIndex } from "./indexFile";
import { listDirectory } from "./scan";

let dir: string;
let bundle: Bundle;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "okf-index-"));
  bundle = openBundle(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function put(rel: string, contents: string): Promise<void> {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  await Bun.write(join(dir, rel), contents);
}

const concept = (extra = "") => `---\ntype: Metric\ntitle: Revenue\ndescription: Money in.\n${extra}---\n\nbody\n`;

describe("renderIndex", () => {
  test("lists concepts with their descriptions and groups as directory links", async () => {
    await put("revenue.md", concept());
    await put("finance/profit.md", concept());
    const listing = await listDirectory(bundle, "");
    expect(renderIndex(listing, false)).toBe(
      "# Concepts\n\n* [Revenue](revenue.md) - Money in.\n\n# Groups\n\n* [finance](finance/)\n",
    );
  });

  test("a bundle-root index declares the format version, a nested one carries no frontmatter (§8, §12)", async () => {
    await put("revenue.md", concept());
    const listing = await listDirectory(bundle, "");
    // Quoted, as §12 writes it — bare 0.2 would parse back as a float.
    expect(renderIndex(listing, true).startsWith('---\nokf_version: "0.2"\n---\n\n')).toBe(true);
    expect(renderIndex(listing, false).startsWith("#")).toBe(true);
  });

  test("falls back to the filename when a concept has no title, and flags deprecated ones", async () => {
    await put("untitled.md", "---\ntype: Metric\n---\n\nbody\n");
    await put("old.md", "---\ntype: Metric\ntitle: Old\ndescription: Was.\nstatus: deprecated\n---\n\nbody\n");
    const rendered = renderIndex(await listDirectory(bundle, ""), false);
    expect(rendered).toContain("* [untitled](untitled.md)\n");
    expect(rendered).toContain("* [Old](old.md) - Was. (deprecated)");
  });
});

describe("regenerateIndex", () => {
  test("writes index.md and keeps it in step with the directory", async () => {
    await put("a.md", concept());
    await regenerateIndex(bundle, "");
    expect(await Bun.file(join(dir, "index.md")).text()).toContain("* [Revenue](a.md)");

    await put("b.md", concept());
    await regenerateIndex(bundle, "");
    const text = await Bun.file(join(dir, "index.md")).text();
    expect(text).toContain("a.md");
    expect(text).toContain("b.md");
  });

  test("removes index.md once the directory has nothing to list", async () => {
    await put("a.md", concept());
    await regenerateIndex(bundle, "");
    rmSync(join(dir, "a.md"));
    await regenerateIndex(bundle, "");
    expect(await Bun.file(join(dir, "index.md")).exists()).toBe(false);
  });

  test("a directory of reference material is not advertised as a group (§6.3)", async () => {
    await put("a.md", concept());
    await put("references/attesters/revenue.py", "# code\n");
    await regenerateIndex(bundle, "");
    expect(await Bun.file(join(dir, "index.md")).text()).not.toContain("references");
  });

  test("index.md is never listed as a concept in its own index", async () => {
    await put("a.md", concept());
    await put("log.md", "# Bundle Update Log\n");
    await regenerateIndex(bundle, "");
    const text = await Bun.file(join(dir, "index.md")).text();
    expect(text).not.toContain("index.md");
    expect(text).not.toContain("log.md");
  });

  test("regenerating an unchanged index leaves the file byte-identical", async () => {
    await put("a.md", concept());
    await regenerateIndex(bundle, "");
    const before = await Bun.file(join(dir, "index.md")).text();
    await regenerateIndex(bundle, "");
    expect(await Bun.file(join(dir, "index.md")).text()).toBe(before);
  });

  test("a missing directory is a no-op, not a crash", async () => {
    await regenerateIndex(bundle, "gone/missing");
    expect(await Bun.file(join(dir, "gone/missing/index.md")).exists()).toBe(false);
  });
});

describe("regenerateIndexChain", () => {
  test("indexes every ancestor up to the root", async () => {
    await put("finance/metrics/revenue.md", concept());
    await regenerateIndexChain(bundle, "finance/metrics");
    expect(await Bun.file(join(dir, "finance/metrics/index.md")).text()).toContain("revenue.md");
    expect(await Bun.file(join(dir, "finance/index.md")).text()).toContain("[metrics](metrics/)");
    expect(await Bun.file(join(dir, "index.md")).text()).toContain("[finance](finance/)");
  });

  test("declaredVersion reads the root declaration back", async () => {
    await put("a.md", concept());
    await regenerateIndexChain(bundle, "");
    expect(await declaredVersion(bundle)).toBe("0.2");
  });
});
