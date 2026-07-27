import { describe, expect, test } from "bun:test";
import { dumpYaml, needsQuotes } from "./yaml";

describe("dumpYaml rendering", () => {
  test("emits block style, one key per line", () => {
    expect(dumpYaml({ type: "Metric", title: "Revenue" })).toBe("type: Metric\ntitle: Revenue\n");
  });

  test("scalar lists and small all-scalar maps go inline, matching the spec's examples", () => {
    const yaml = dumpYaml({
      tags: ["sales", "orders", "revenue"],
      generated: { by: "reference_agent/gemini-2.5-pro", at: "2026-06-20T22:53:05Z" },
      usage_window: { from: "2026-06-01", to: "2026-06-30" },
    });
    expect(yaml).toBe(
      "tags: [sales, orders, revenue]\n" +
        "generated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-20T22:53:05Z }\n" +
        "usage_window: { from: 2026-06-01, to: 2026-06-30 }\n",
    );
  });

  test("a map with a nested list goes block even though it is small", () => {
    expect(dumpYaml({ executor: { resource: "references/skills/run-on-bq.md", receipt: ["job_id", "result"] } })).toBe(
      "executor:\n  resource: references/skills/run-on-bq.md\n  receipt: [job_id, result]\n",
    );
  });

  test("list of maps renders with the dash spliced over the first key", () => {
    const yaml = dumpYaml({
      sources: [
        {
          id: "ga4-schema",
          resource: "https://developers.google.com/analytics/bigquery/export-schema",
          title: "GA4 BigQuery Export schema",
          author: "team:ga4-docs",
          usage_count: 5000,
        },
      ],
    });
    expect(yaml).toBe(
      "sources:\n" +
        "  - id: ga4-schema\n" +
        "    resource: https://developers.google.com/analytics/bigquery/export-schema\n" +
        "    title: GA4 BigQuery Export schema\n" +
        "    author: team:ga4-docs\n" +
        "    usage_count: 5000\n",
    );
  });

  test("a short parameter map stays inline", () => {
    expect(dumpYaml({ parameters: [{ name: "year", type: "integer", required: true }] })).toBe(
      "parameters:\n  - { name: year, type: integer, required: true }\n",
    );
  });

  test("a wide map breaks out of flow style", () => {
    const yaml = dumpYaml({
      sources: [{ id: "rev-policy", resource: "https://wiki.acme/finance/revenue-recognition", title: "Revenue recognition policy" }],
    });
    expect(yaml.split("\n")[1]).toBe("  - id: rev-policy");
  });

  test("undefined keys are dropped, null is written", () => {
    expect(dumpYaml({ a: undefined, b: null })).toBe("b: null\n");
  });

  test("empty collections", () => {
    expect(dumpYaml({ tags: [], meta: {} })).toBe("tags: []\nmeta: {}\n");
  });

  test("nested maps indent by two", () => {
    expect(dumpYaml({ a: { b: { c: 1, d: [1, 2] } } })).toBe("a:\n  b:\n    c: 1\n    d: [1, 2]\n");
  });
});

describe("dumpYaml quoting", () => {
  const cases: [string, string][] = [
    ["plain", "plain"],
    ["Customer Orders", "Customer Orders"],
    ["", '""'],
    ["no", '"no"'], // would parse as boolean false
    ["true", '"true"'],
    ["007", '"007"'], // would parse as the number 7
    ["1.5", '"1.5"'],
    ["null", '"null"'],
    ["- dash", '"- dash"'],
    ["#hash", '"#hash"'],
    ["a: b", '"a: b"'],
    ["trailing:", '"trailing:"'],
    ["  padded  ", '"  padded  "'],
    ["line\nbreak", '"line\\nbreak"'],
    ['say "hi"', 'say "hi"'], // a quote that does not start the scalar needs no escaping
    ['"quoted"', '"\\"quoted\\""'],
    ["2026-09-23", "2026-09-23"], // dates stay bare, as in the spec
    ["2026-06-20T22:53:05Z", "2026-06-20T22:53:05Z"],
    ["https://wiki.acme/x", "https://wiki.acme/x"], // "https:" is not a mapping, no space after the colon
  ];

  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(dumpYaml({ k: input })).toBe(`k: ${expected}\n`);
    });
  }

  test("commas force quotes inside a flow collection but not in block style", () => {
    expect(needsQuotes("a, b", true)).toBe(true);
    expect(needsQuotes("a, b", false)).toBe(false);
    expect(dumpYaml({ tags: ["a, b"] })).toBe('tags: ["a, b"]\n');
  });
});

describe("dumpYaml round-trips through Bun.YAML.parse", () => {
  const fixtures: Record<string, unknown>[] = [
    { type: "Metric", title: "Revenue", tags: ["finance", "revenue"] },
    { generated: { by: "agent/v1", at: "2026-06-20T22:53:05Z" }, verified: [{ by: "human:ahormati", at: "2026-06-25T09:00:00Z" }] },
    { sources: [{ id: "a", resource: "https://x/y", usage_count: 5000, last_modified: "2026-05-30" }] },
    { executor: { resource: "references/skills/run-on-bq.md", receipt: ["job_id", "executed_sql", "result"] } },
    { tricky: ["no", "007", "", "a: b", "#c", "- d", "yes"] },
    { title: "Incident response: data freshness alert", nested: { deep: { deeper: [{ k: "v" }] } } },
    { unicode: "café — naïve 日本語", empty_list: [], empty_map: {}, nullish: null, bool: false, num: -1.25 },
    { "key with spaces": 1, "key:colon": 2 },
    { long_tags: Array.from({ length: 20 }, (_, i) => `tag-number-${i}`) },
  ];

  for (const [i, fixture] of fixtures.entries()) {
    test(`fixture ${i}`, () => {
      expect(Bun.YAML.parse(dumpYaml(fixture))).toEqual(fixture);
    });
  }
});
