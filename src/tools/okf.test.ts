import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import type { AgentTool } from "../core/tools";
import { readOnly, renderBriefing } from "../core/toolGroups";
import {
  DEFAULT_OKF_ACTOR,
  DEFAULT_OKF_ROOT,
  createOkfTools,
  okfGroup,
  type OkfTools,
} from "./okf";
import type { ToolGroupContext } from "./groups";

let dir: string;
let tools: OkfTools;

/** The OKF group never touches the database; `db` is only in the shared context type. */
const contextFor = (root: string): ToolGroupContext =>
  ({ db: undefined, okf: { root, actor: "librarian/test-1" } }) as unknown as ToolGroupContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "okf-tools-"));
  tools = createOkfTools({ root: dir, actor: "librarian/test-1", now: () => new Date("2026-07-25T12:00:00Z") });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Exercise a tool the way Agent.invokeTool does: validate at the boundary, then run. */
function call(tool: AgentTool, args: unknown): Promise<unknown> {
  return Promise.resolve(tool.execute(tool.schema.parse(args)));
}

const SOURCES = [{ resource: "https://wiki.acme/x" }];

describe("tool surface", () => {
  test("exposes exactly the seven tools, and separates the read-only subset", () => {
    expect(tools.all.map((t) => t.definition.function.name)).toEqual([
      "okf_list",
      "okf_read",
      "okf_search",
      "okf_create",
      "okf_patch",
      "okf_move",
      "okf_deprecate",
    ]);
    const group = okfGroup(contextFor(dir));
    expect(readOnly(group).tools.map((t) => t.definition.function.name)).toEqual([
      "okf_list",
      "okf_read",
      "okf_search",
    ]);
  });

  test("every tool produces a JSON schema the model can be shown", () => {
    for (const tool of tools.all) {
      const params = tool.definition.function.parameters as { type?: string; properties?: object };
      expect(params.type).toBe("object");
      expect(Object.keys(params.properties ?? {}).length).toBeGreaterThan(0);
      expect(tool.definition.function.description ?? "").not.toBe("");
    }
  });

  test("there is no delete tool — retiring a concept goes through okf_deprecate (§5.4)", () => {
    expect(tools.all.map((t) => t.definition.function.name).join()).not.toContain("delete");
  });
});

describe("argument validation at the boundary", () => {
  test("okf_list defaults to the bundle root", async () => {
    await call(tools.create, { id: "a", type: "Metric", sources: SOURCES });
    expect(await call(tools.list, {})).toMatchObject({ path: "" });
  });

  test("okf_search applies its defaults", () => {
    expect(tools.search.schema.parse({})).toMatchObject({ staleOnly: false, limit: 20 });
  });

  test("okf_move defaults to rewriting links", () => {
    expect(tools.move.schema.parse({ from: "a", to: "b" })).toMatchObject({ updateLinks: true });
  });

  test("a body edit must name a section unless it rewrites everything", () => {
    const parse = (body: unknown) => tools.patch.schema.parse({ id: "a", body });
    expect(() => parse({ op: "replace", content: "x" })).toThrow(/`section` is required/);
    expect(() => parse({ op: "replaceAll", content: "x" })).not.toThrow();
    expect(() => parse({ op: "delete", section: "S" })).not.toThrow();
    expect(() => parse({ op: "append", section: "S" })).toThrow(/`content` is required/);
  });

  test("rejects the malformed dates and out-of-range values a model might improvise", () => {
    expect(() => tools.create.schema.parse({ id: "a", type: "M", staleAfter: "next tuesday" })).toThrow();
    expect(() => tools.search.schema.parse({ minTrust: "very-trusted" })).toThrow();
    expect(() => tools.search.schema.parse({ limit: 500 })).toThrow();
    expect(() => tools.create.schema.parse({ id: "a", type: "M", status: "retired" })).toThrow();
  });
});

describe("the invariants the model cannot reach", () => {
  test("the actor is bound at construction, not supplied per call", async () => {
    await call(tools.create, { id: "a", type: "Metric", sources: SOURCES, actor: "human:eli" });
    const result = (await call(tools.read, { id: "a" })) as { generatedBy: string; trust: string };
    expect(result.generatedBy).toBe("librarian/test-1"); // the smuggled actor was stripped
    expect(result.trust).toBe("unverified");
  });

  test("a generating agent cannot mark its own output human-reviewed", () => {
    expect(
      call(tools.create, {
        id: "a",
        type: "Metric",
        sources: SOURCES,
        extra: { verified: [{ by: "human:eli", at: "2026-07-25T00:00:00Z" }] },
      }),
    ).rejects.toThrow(/cannot be set through `extra`: verified/);
  });

  test("index.md and log.md are maintained by the write path, not by the agent", async () => {
    await call(tools.create, { id: "finance/revenue", type: "Metric", title: "Revenue", sources: SOURCES });
    expect(await Bun.file(join(dir, "finance/index.md")).text()).toContain("* [Revenue](revenue.md)");
    expect(await Bun.file(join(dir, "log.md")).text()).toContain("**Creation**");
  });
});

describe("a librarian's round trip", () => {
  test("create, find, read, patch, move, deprecate", async () => {
    await call(tools.create, {
      id: "tables/orders",
      type: "BigQuery Table",
      title: "Customer Orders",
      description: "One row per completed order.",
      tags: ["sales"],
      sources: [{ id: "ga4", resource: "https://developers.google.com/analytics", title: "GA4 docs" }],
      body: "# Schema\n\n| Column | Type |\n|---|---|\n| id | STRING |",
    });
    await call(tools.create, {
      id: "metrics/revenue",
      type: "Metric",
      title: "Revenue",
      sources: SOURCES,
      body: "Derived from [orders](/tables/orders.md).",
    });

    const found = (await call(tools.search, { query: "orders", type: "BigQuery Table" })) as {
      results: { id: string }[];
    };
    expect(found.results.map((r) => r.id)).toEqual(["tables/orders"]);

    await call(tools.patch, {
      id: "tables/orders",
      frontmatter: { description: "One row per completed customer order." },
      body: { op: "add", section: "Joins", content: "Joined with customers on `customer_id`." },
    });
    const read = (await call(tools.read, { id: "tables/orders" })) as { body: string; description: string };
    expect(read.description).toBe("One row per completed customer order.");
    expect(read.body).toContain("# Joins");

    await call(tools.move, { from: "tables/orders", to: "sales/orders" });
    const moved = (await call(tools.read, { id: "metrics/revenue" })) as {
      links: { id: string; exists: boolean }[];
    };
    expect(moved.links[0]).toMatchObject({ id: "sales/orders", exists: true });

    await call(tools.deprecate, { id: "metrics/revenue", reason: "Folded into the orders table.", supersededBy: "sales/orders" });
    expect(await call(tools.read, { id: "metrics/revenue" })).toMatchObject({ status: "deprecated" });

    expect(await tools.store.validate()).toMatchObject({ conformant: true, errors: [], info: [] });
  });

  test("tool errors read as instructions a model can act on", async () => {
    await call(tools.create, { id: "a", type: "Metric", sources: SOURCES });
    expect(call(tools.create, { id: "a", type: "Metric", sources: SOURCES })).rejects.toThrow(
      /already exists — use okf_patch/,
    );
    expect(call(tools.patch, { id: "ghost", frontmatter: { title: "x" } })).rejects.toThrow(/No concept "ghost"/);
    expect(call(tools.create, { id: "b", type: "Metric" })).rejects.toThrow(/`sources` is required/);
  });
});

describe("the group", () => {
  test("is well-formed, and says what an OKF object is", () => {
    const group = okfGroup(contextFor(dir));
    expect(group.name).toBe("okf");
    // Not the default title, which would render the acronym as "Okf".
    expect(group.title).toBe("OKF");
    expect(group.shape.singular).toBe("concept");
    expect(group.tools.map((t) => t.definition.function.name)).toEqual([
      "okf_list",
      "okf_read",
      "okf_search",
      "okf_create",
      "okf_patch",
      "okf_move",
      "okf_deprecate",
    ]);
  });

  test("the spine is hand-written, and names the fields the store owns", () => {
    const spine = okfGroup(contextFor(dir)).shape.spine;
    const byName = new Map(spine.map((field) => [field.name, field]));
    expect([...byName.keys()]).toEqual(
      expect.arrayContaining([
        "id",
        "type",
        "status",
        "sources",
        "usage_window",
        "stale_after",
        "generated.by",
        "verified",
        "body",
      ]),
    );
    expect(byName.get("status")).toMatchObject({ default: "stable", required: false });
    // Provenance is not optional for an agent — create refuses without it.
    expect(byName.get("sources")?.required).toBe(true);
    for (const field of spine) expect(field.note ?? "").not.toBe("");
  });

  test("trust and staleness are declared derived, because nothing stores them", () => {
    const derived = okfGroup(contextFor(dir)).shape.derived ?? [];
    const names = derived.map((field) => field.name);
    expect(names).toContain("trust");
    expect(names).toContain("stale");
    expect(derived.find((f) => f.name === "trust")?.type).toBe(
      "one of: unverified | machine-confirmed | human-reviewed",
    );
    // The tier is read off `verified`, which no tool writes — the briefing has
    // to say so, since the model cannot see the absence of a tool.
    expect(derived.find((f) => f.name === "trust")?.note).toContain("verified");
  });

  test("every tool is classified by effect", () => {
    const kinds = Object.fromEntries(
      okfGroup(contextFor(dir)).tools.map((t) => [t.definition.function.name, t.kind]),
    );
    expect(kinds).toEqual({
      okf_list: "read",
      okf_read: "read",
      okf_search: "read",
      okf_create: "write",
      okf_patch: "write",
      okf_move: "write",
      okf_deprecate: "write",
    });
  });

  test("the read-only form is the three tools that cannot write to memory", () => {
    const restricted = readOnly(okfGroup(contextFor(dir)));
    expect(restricted.tools.map((t) => t.definition.function.name)).toEqual([
      "okf_list",
      "okf_read",
      "okf_search",
    ]);
    // Rendered from the tools it actually holds, so it cannot advertise a write.
    const briefing = renderBriefing(restricted);
    expect(briefing).not.toContain("okf_create");
    expect(briefing).toContain("okf_search");
  });

  test("the briefing carries the rules no introspection could find", () => {
    const briefing = renderBriefing(okfGroup(contextFor(dir)));
    expect(briefing).toContain("# OKF");
    expect(briefing).toContain("human-reviewed");
    expect(briefing).toContain("deprecated");
    expect(briefing).toContain("stale_after");
  });

  test("the bundle root defaults to the module, not the process cwd", () => {
    expect(isAbsolute(DEFAULT_OKF_ROOT)).toBe(true);
    expect(DEFAULT_OKF_ROOT.endsWith(`${sep}okf`)).toBe(true);
    // A default actor claiming to be a person would waive the provenance
    // requirement and forge the top trust tier (§5.3).
    expect(DEFAULT_OKF_ACTOR.startsWith("human:")).toBe(false);
  });

  test("the group binds the actor the same way the factory does", async () => {
    const group = okfGroup(contextFor(dir));
    const create = group.tools.find((t) => t.definition.function.name === "okf_create")!;
    const read = group.tools.find((t) => t.definition.function.name === "okf_read")!;
    await call(create, { id: "a", type: "Metric", sources: SOURCES, actor: "human:eli" });
    expect(await call(read, { id: "a" })).toMatchObject({
      generatedBy: "librarian/test-1",
      trust: "unverified",
    });
  });
});
