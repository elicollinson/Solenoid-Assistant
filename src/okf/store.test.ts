import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OkfStore } from "./store";
import { parseDocument } from "./concept";

let dir: string;
let clock: Date;
let store: OkfStore;

const ACTOR = "librarian/test-1";
const SOURCE = [{ id: "src", resource: "https://wiki.acme/x", title: "A source" }];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "okf-store-"));
  clock = new Date("2026-07-25T12:00:00Z");
  store = new OkfStore({ root: dir, actor: ACTOR, now: () => clock });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function read(rel: string): Promise<string> {
  return Bun.file(join(dir, rel)).text();
}

async function frontmatterOf(rel: string): Promise<Record<string, unknown>> {
  return parseDocument(await read(rel)).frontmatter ?? {};
}

/** Write a concept behind the store's back — for fixtures the store refuses to author. */
async function put(rel: string, contents: string): Promise<void> {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  await Bun.write(join(dir, rel), contents);
}

const seed = (id: string, overrides: Record<string, unknown> = {}) =>
  store.create({ id, type: "Metric", title: id, sources: SOURCE, ...overrides });

// --- create ---------------------------------------------------------------

describe("create", () => {
  test("writes a conformant concept and stamps identity and time itself", async () => {
    const result = await store.create({
      id: "metrics/revenue",
      type: "Metric",
      title: "Revenue",
      description: "Recognized revenue.",
      tags: ["finance"],
      sources: SOURCE,
      body: "# Definition\n\nSums amount.",
    });

    expect(result).toMatchObject({ id: "metrics/revenue", type: "Metric", trust: "unverified", status: "stable" });
    const fm = await frontmatterOf("metrics/revenue.md");
    expect(fm.generated).toEqual({ by: ACTOR, at: "2026-07-25T12:00:00Z" });
    expect(fm.type).toBe("Metric");
    expect(await read("metrics/revenue.md")).toContain("# Definition");
  });

  test("defaults stale_after to the configured horizon, and honors an explicit date or null", async () => {
    await seed("a");
    expect((await frontmatterOf("a.md")).stale_after).toBe("2026-10-23"); // +90d

    await seed("b", { staleAfter: "2027-01-01" });
    expect((await frontmatterOf("b.md")).stale_after).toBe("2027-01-01");

    await seed("c", { staleAfter: null });
    expect((await frontmatterOf("c.md")).stale_after).toBeUndefined();

    const noTtl = new OkfStore({ root: dir, actor: ACTOR, now: () => clock, defaultStaleAfterDays: null });
    await noTtl.create({ id: "d", type: "Metric", sources: SOURCE });
    expect((await frontmatterOf("d.md")).stale_after).toBeUndefined();
  });

  test("refuses to clobber an existing concept", async () => {
    await seed("a");
    expect(seed("a")).rejects.toThrow(/already exists.*okf_patch/s);
  });

  test("requires a non-empty type (§4.1)", () => {
    expect(store.create({ id: "a", type: "  ", sources: SOURCE })).rejects.toThrow(/`type` is required/);
  });

  test("requires provenance from an agent actor, but not from a human", async () => {
    expect(store.create({ id: "a", type: "Metric" })).rejects.toThrow(/`sources` is required/);

    const human = new OkfStore({ root: dir, actor: "human:eli", now: () => clock });
    await human.create({ id: "a", type: "Metric" });
    expect((await frontmatterOf("a.md")).generated).toMatchObject({ by: "human:eli" });
  });

  test("an agent cannot forge a trust tier through `extra` (§5.2, §5.3)", () => {
    expect(
      store.create({
        id: "a",
        type: "Metric",
        sources: SOURCE,
        extra: { verified: [{ by: "human:eli", at: "2026-07-25T00:00:00Z" }] },
      }),
    ).rejects.toThrow(/cannot be set through `extra`: verified/);
  });

  test("`extra` cannot restate a field the tool already owns, but carries anything else", async () => {
    expect(store.create({ id: "a", type: "Metric", sources: SOURCE, extra: { generated: {} } })).rejects.toThrow(
      /generated/,
    );

    await store.create({
      id: "computations/revenue",
      type: "Attested Computation",
      sources: SOURCE,
      extra: {
        runtime: "bigquery",
        parameters: [{ name: "year", type: "integer", required: true }],
        executor: { resource: "references/skills/run-on-bq.md", receipt: ["job_id", "executed_sql"] },
      },
    });
    const fm = await frontmatterOf("computations/revenue.md");
    expect(fm.runtime).toBe("bigquery");
    expect(fm.executor).toEqual({ resource: "references/skills/run-on-bq.md", receipt: ["job_id", "executed_sql"] });
  });

  test("normalizes the two ids models get wrong, and rejects the dangerous ones", async () => {
    await seed("/metrics/revenue.md");
    expect(existsSync(join(dir, "metrics/revenue.md"))).toBe(true);

    for (const id of ["../escape", "a/../../escape", "index", "metrics/log", "", "  ", "a\\b", "a//b/.hidden"]) {
      expect(seed(id)).rejects.toThrow();
    }
    expect(seed("index")).rejects.toThrow(/reserved filename/);
  });

  test("creates parent groups implicitly and indexes every ancestor", async () => {
    await seed("finance/metrics/revenue", { title: "Revenue" });
    expect(await read("finance/metrics/index.md")).toContain("* [Revenue](revenue.md)");
    expect(await read("finance/index.md")).toContain("[metrics](metrics/)");
    expect(await read("index.md")).toContain("[finance](finance/)");
    expect(await read("index.md")).toContain('okf_version: "0.2"');
  });

  test("logs the creation", async () => {
    await seed("a", { title: "Alpha" });
    expect(await read("log.md")).toBe(
      "# Bundle Update Log\n\n## 2026-07-25\n* **Creation**: Established [Alpha](/a.md).\n",
    );
  });
});

// --- read -----------------------------------------------------------------

describe("read", () => {
  test("returns frontmatter, body, and derived signals", async () => {
    await seed("a", { title: "Alpha", description: "d", body: "# S\n\nx" });
    const result = await store.read("a");
    expect(result).toMatchObject({
      id: "a",
      title: "Alpha",
      description: "d",
      status: "stable",
      trust: "unverified",
      stale: false,
      generatedBy: ACTOR,
      staleAfter: "2026-10-23",
    });
    expect(result.body).toContain("# S");
  });

  test("derives the trust tier from `verified`, including the bare-mapping form (§5.2, §5.3)", async () => {
    await put("machine.md", "---\ntype: M\nverified: { by: process:nightly, at: 2026-07-01T00:00:00Z }\n---\n\nx\n");
    await put(
      "human.md",
      "---\ntype: M\nverified:\n  - { by: process:nightly, at: 2026-07-01T00:00:00Z }\n  - { by: human:eli, at: 2026-07-02T00:00:00Z }\n---\n\nx\n",
    );
    expect((await store.read("machine")).trust).toBe("machine-confirmed");

    const human = await store.read("human");
    expect(human.trust).toBe("human-reviewed");
    expect(human.verifiedAt).toBe("2026-07-02T00:00:00Z"); // latest wins
  });

  test("staleness is a date comparison against the clock (§5.5)", async () => {
    await seed("a", { staleAfter: "2026-07-25" });
    expect((await store.read("a")).stale).toBe(true); // today >= stale_after
    clock = new Date("2026-07-24T12:00:00Z");
    expect((await store.read("a")).stale).toBe(false);
  });

  test("reports outbound links and whether each target exists", async () => {
    await seed("tables/orders");
    await seed("metrics/rev", {
      body: "[o](/tables/orders.md) [missing](/nope.md) [ext](https://x/y)",
    });
    const links = (await store.read("metrics/rev")).links ?? [];
    expect(links).toEqual([
      { text: "o", target: "/tables/orders.md", kind: "concept", id: "tables/orders", exists: true },
      { text: "missing", target: "/nope.md", kind: "concept", id: "nope", exists: false },
      { text: "ext", target: "https://x/y", kind: "external" },
    ]);
  });

  test("frontmatterOnly skips the body and links", async () => {
    await seed("a", { body: "# S\n\nx" });
    const result = await store.read("a", { frontmatterOnly: true });
    expect(result.body).toBeUndefined();
    expect(result.links).toBeUndefined();
  });

  test("a missing concept says so by name", () => {
    expect(store.read("nope")).rejects.toThrow(/No concept "nope"/);
  });

  test("a hand-written file with no frontmatter fails loudly rather than being half-read", async () => {
    await put("broken.md", "# just markdown\n");
    expect(store.read("broken")).rejects.toThrow(/no YAML frontmatter/);
  });
});

// --- list -----------------------------------------------------------------

describe("list", () => {
  test("lists a directory's concepts and its groups with counts", async () => {
    await seed("a", { title: "Alpha" });
    await seed("finance/b");
    await seed("finance/deep/c");

    const root = await store.list();
    expect(root.concepts.map((c) => c.id)).toEqual(["a"]);
    expect(root.groups).toEqual([{ path: "finance", concepts: 2 }]);

    expect((await store.list("finance")).concepts.map((c) => c.id)).toEqual(["finance/b"]);
  });

  test("never lists the reserved files as concepts", async () => {
    await seed("a");
    const root = await store.list();
    expect(root.concepts.map((c) => c.id)).toEqual(["a"]);
  });

  test("a directory holding only reference material is not a group (§6.3)", async () => {
    await seed("a");
    await put("references/attesters/revenue.py", "# code\n");
    expect((await store.list()).groups).toEqual([]);
  });

  test("an unknown group is an error, not an empty listing", () => {
    expect(store.list("nope")).rejects.toThrow(/No such group "nope"/);
  });

  test("a bundle that has not been written to yet lists as empty", async () => {
    const fresh = new OkfStore({ root: join(dir, "not-created-yet"), actor: ACTOR, now: () => clock });
    expect(await fresh.list()).toEqual({ path: "", concepts: [], groups: [] });
  });
});

// --- search ---------------------------------------------------------------

describe("search", () => {
  beforeEach(async () => {
    await seed("metrics/revenue", {
      title: "Revenue",
      description: "Recognized revenue.",
      tags: ["finance", "revenue"],
      body: "# Definition\n\nSums the amount column over the fiscal year.",
    });
    await seed("playbooks/oncall", {
      type: "Playbook",
      title: "Oncall",
      tags: ["oncall"],
      status: "draft",
      body: "Escalate to the revenue team.",
      staleAfter: "2026-01-01",
    });
    await put("plain.md", "---\ntype: Reference\ntitle: Plain\n---\n\nnothing special\n");
  });

  test("text matches the body, and head matches rank above body matches", async () => {
    const results = (await store.search({ query: "revenue" })).results;
    expect(results.map((r) => r.id)).toEqual(["metrics/revenue", "playbooks/oncall"]);
    expect(results[1]?.snippet).toContain("Escalate to the revenue team.");
  });

  test("filters by type, tags (any-of), and status", async () => {
    expect((await store.search({ type: "playbook" })).results.map((r) => r.id)).toEqual(["playbooks/oncall"]);
    expect((await store.search({ tags: ["oncall", "nope"] })).results.map((r) => r.id)).toEqual(["playbooks/oncall"]);
    expect((await store.search({ status: "draft" })).results.map((r) => r.id)).toEqual(["playbooks/oncall"]);
  });

  test("status 'stable' includes concepts that never declared one (§5.4)", async () => {
    const ids = (await store.search({ status: "stable" })).results.map((r) => r.id);
    expect(ids).toContain("plain");
    expect(ids).not.toContain("playbooks/oncall");
  });

  test("staleOnly finds what is due for a re-check", async () => {
    expect((await store.search({ staleOnly: true })).results.map((r) => r.id)).toEqual(["playbooks/oncall"]);
  });

  test("minTrust filters on the derived tier", async () => {
    expect((await store.search({ minTrust: "machine-confirmed" })).results).toEqual([]);
    await put("verified.md", "---\ntype: M\nverified: { by: human:eli, at: 2026-07-01T00:00:00Z }\n---\n\nx\n");
    expect((await store.search({ minTrust: "human-reviewed" })).results.map((r) => r.id)).toEqual(["verified"]);
  });

  test("no query and no filters returns the whole bundle", async () => {
    expect((await store.search()).matched).toBe(3);
  });

  test("limit caps the results but reports the true match count", async () => {
    const result = await store.search({ limit: 1 });
    expect(result).toMatchObject({ matched: 3, returned: 1 });
    expect(result.results).toHaveLength(1);
  });

  test("a query that matches nothing returns empty rather than everything", async () => {
    expect((await store.search({ query: "zzz-nonexistent" })).matched).toBe(0);
  });
});

// --- patch ----------------------------------------------------------------

describe("patch", () => {
  test("merges frontmatter, leaves omitted fields alone, and preserves unknown keys", async () => {
    await put(
      "a.md",
      "---\ntype: Metric\ntitle: Old\ndescription: keep me\nacme_internal: 42\n---\n\n# S\n\nbody\n",
    );
    await store.patch({ id: "a", title: "New" });
    const fm = await frontmatterOf("a.md");
    expect(fm).toMatchObject({ type: "Metric", title: "New", description: "keep me", acme_internal: 42 });
  });

  test("re-stamps `generated` but never touches `verified` (§5.2)", async () => {
    await put(
      "a.md",
      "---\ntype: M\ngenerated: { by: someone/else, at: 2020-01-01T00:00:00Z }\nverified: { by: human:eli, at: 2026-01-01T00:00:00Z }\n---\n\nx\n",
    );
    await store.patch({ id: "a", description: "d" });
    const fm = await frontmatterOf("a.md");
    expect(fm.generated).toEqual({ by: ACTOR, at: "2026-07-25T12:00:00Z" });
    expect(fm.verified).toEqual({ by: "human:eli", at: "2026-01-01T00:00:00Z" });
  });

  test("edits the body one section at a time", async () => {
    await seed("a", { body: "# Schema\n\nold\n\n# Examples\n\nkeep" });
    await store.patch({ id: "a", bodyOps: [{ op: "replace", section: "Schema", content: "new" }] });
    const text = await read("a.md");
    expect(text).toContain("# Schema\n\nnew");
    expect(text).toContain("# Examples\n\nkeep");
  });

  test("frontmatter and body change together in one write", async () => {
    await seed("a", { body: "# S\n\nx" });
    await store.patch({
      id: "a",
      description: "d",
      bodyOps: [{ op: "append", section: "S", content: "y" }],
    });
    const text = await read("a.md");
    expect(text).toContain("description: d");
    expect(text).toContain("y");
  });

  test("lists are replaced wholesale, and staleAfter null clears the date", async () => {
    await seed("a", { tags: ["one", "two"] });
    await store.patch({ id: "a", tags: ["three"], staleAfter: null });
    const fm = await frontmatterOf("a.md");
    expect(fm.tags).toEqual(["three"]);
    expect(fm.stale_after).toBeUndefined();
  });

  test("refuses to create, and refuses a no-op", async () => {
    expect(store.patch({ id: "nope", title: "x" })).rejects.toThrow(/No concept "nope"/);
    await seed("a");
    expect(store.patch({ id: "a" })).rejects.toThrow(/Nothing to patch/);
  });

  test("a wrong section name fails without writing anything", async () => {
    await seed("a", { body: "# Schema\n\nx" });
    const before = await read("a.md");
    expect(store.patch({ id: "a", bodyOps: [{ op: "replace", section: "Joins", content: "y" }] })).rejects.toThrow(
      /No section "Joins"/,
    );
    expect(await read("a.md")).toBe(before);
  });

  test("keeps the index in step when the title changes, and logs the update", async () => {
    await seed("a", { title: "Old" });
    await store.patch({ id: "a", title: "New" });
    expect(await read("index.md")).toContain("* [New](a.md)");
    expect(await read("log.md")).toContain("* **Update**: Updated [New](/a.md).");
  });
});

// --- move -----------------------------------------------------------------

describe("move", () => {
  test("relocates the concept and rewrites inbound links in both forms", async () => {
    await seed("tables/orders", { title: "Orders" });
    await seed("metrics/rev", { body: "See [orders](/tables/orders.md#schema)." });
    await seed("tables/summary", { body: "See [orders](./orders.md)." });

    const result = await store.move("tables/orders", "sales/orders");

    expect(result).toMatchObject({ from: "tables/orders", to: "sales/orders" });
    expect(result.rewrittenIn).toEqual(["metrics/rev", "tables/summary"]);
    expect(existsSync(join(dir, "tables/orders.md"))).toBe(false);
    expect(await read("metrics/rev.md")).toContain("[orders](/sales/orders.md#schema)");
    expect(await read("tables/summary.md")).toContain("[orders](../sales/orders.md)");
  });

  test("rewrites the moved concept's own relative links from its new location", async () => {
    await seed("tables/customers");
    await seed("tables/orders", { body: "Joins [customers](./customers.md)." });
    await store.move("tables/orders", "sales/orders");
    expect(await read("sales/orders.md")).toContain("[customers](../tables/customers.md)");
  });

  test("carries the frontmatter across untouched — a move is not a content change", async () => {
    await seed("a", { title: "Alpha" });
    const before = await frontmatterOf("a.md");
    await store.move("a", "b");
    expect(await frontmatterOf("b.md")).toEqual(before);
  });

  test("updateLinks: false leaves the graph broken, deliberately", async () => {
    await seed("tables/orders");
    await seed("metrics/rev", { body: "See [orders](/tables/orders.md)." });
    const result = await store.move("tables/orders", "sales/orders", { updateLinks: false });
    expect(result.rewrittenIn).toEqual([]);
    expect(await read("metrics/rev.md")).toContain("/tables/orders.md");
  });

  test("prunes a group the move emptied, and reindexes both ends", async () => {
    await seed("old/a", { title: "Alpha" });
    await store.move("old/a", "new/a");
    expect(existsSync(join(dir, "old"))).toBe(false);
    expect(await read("new/index.md")).toContain("* [Alpha](a.md)");
    expect(await read("index.md")).not.toContain("[old](old/)");
  });

  test("never prunes a group that still holds reference material (§6.3)", async () => {
    await seed("old/a");
    await put("old/references/attester.py", "# code\n");
    await store.move("old/a", "new/a");
    expect(existsSync(join(dir, "old/references/attester.py"))).toBe(true);
  });

  test("refuses to overwrite, to no-op, or to move something absent", async () => {
    await seed("a");
    await seed("b");
    expect(store.move("a", "b")).rejects.toThrow(/already exists/);
    expect(store.move("a", "a")).rejects.toThrow(/same concept/);
    expect(store.move("nope", "c")).rejects.toThrow(/No concept "nope"/);
    expect(store.move("a", "index")).rejects.toThrow(/reserved/);
  });

  test("logs the move with both ids", async () => {
    await seed("a", { title: "Alpha" });
    await store.move("a", "sub/b");
    expect(await read("log.md")).toContain("* **Move**: Moved [Alpha](/sub/b.md) from `a`.");
  });
});

// --- deprecate ------------------------------------------------------------

describe("deprecate", () => {
  test("marks the status, records why, and keeps the document (§5.4)", async () => {
    await seed("a", { title: "Alpha", body: "# Definition\n\nx" });
    const result = await store.deprecate("a", { reason: "Superseded by the new pipeline." });

    expect(result).toMatchObject({ status: "deprecated" });
    expect(existsSync(join(dir, "a.md"))).toBe(true);
    const text = await read("a.md");
    expect(text).toContain("status: deprecated");
    expect(text).toContain("# Deprecation\n\nSuperseded by the new pipeline.");
    expect(text).toContain("# Definition"); // history survives
  });

  test("links the successor and reports whether it exists", async () => {
    await seed("old");
    await seed("new");
    expect(await store.deprecate("old", { supersededBy: "new" })).toMatchObject({ supersededByExists: true });
    expect(await read("old.md")).toContain("Superseded by [new](/new.md).");

    await seed("other");
    expect(await store.deprecate("other", { supersededBy: "ghost" })).toMatchObject({ supersededByExists: false });
  });

  test("deprecating twice replaces the note rather than stacking sections", async () => {
    await seed("a");
    await store.deprecate("a", { reason: "First." });
    await store.deprecate("a", { reason: "Second." });
    const text = await read("a.md");
    expect(text.match(/# Deprecation/g)).toHaveLength(1);
    expect(text).toContain("Second.");
    expect(text).not.toContain("First.");
  });

  test("shows up in the index and the log", async () => {
    await seed("a", { title: "Alpha", description: "Money." });
    await store.deprecate("a");
    expect(await read("index.md")).toContain("* [Alpha](a.md) - Money. (deprecated)");
    expect(await read("log.md")).toContain("* **Deprecation**: Deprecated [Alpha](/a.md).");
  });

  test("a missing concept is an error", () => {
    expect(store.deprecate("nope")).rejects.toThrow(/No concept "nope"/);
  });
});

// --- cross-cutting --------------------------------------------------------

describe("concurrent writes", () => {
  test("parallel creates all land in the index and the log", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => seed(`c${i}`, { title: `C${i}` })),
    );
    const index = await read("index.md");
    const log = await read("log.md");
    for (let i = 0; i < 8; i++) {
      expect(index).toContain(`* [C${i}](c${i}.md)`);
      expect(log).toContain(`Established [C${i}](/c${i}.md).`);
    }
    expect(log.match(/\* \*\*Creation\*\*/g)).toHaveLength(8);
  });
});

describe("the bundle stays conformant through every operation (§11)", () => {
  test("create, patch, move, deprecate", async () => {
    await seed("tables/orders", { title: "Orders" });
    await seed("metrics/rev", { title: "Revenue", body: "See [orders](/tables/orders.md)." });
    await store.patch({ id: "metrics/rev", description: "d" });
    await store.move("tables/orders", "sales/orders");
    await store.deprecate("metrics/rev", { reason: "Replaced." });

    const report = await store.validate();
    expect(report.errors).toEqual([]);
    expect(report.conformant).toBe(true);
    expect(report.info).toEqual([]); // no broken links either — the move fixed them
  });
});
