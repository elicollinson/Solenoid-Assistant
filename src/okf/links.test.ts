import { describe, expect, test } from "bun:test";
import { conceptLinks, extractLinks, relativeTarget, resolveLink, rewriteLinks } from "./links";

describe("extractLinks", () => {
  test("finds inline links but not images or footnotes", () => {
    const body =
      "See [orders](/tables/orders.md) and ![chart](/img/a.png).\n" +
      "A claim.[^ga4-schema]\n\n[^ga4-schema]: GA4 BigQuery Export schema\n";
    expect(extractLinks(body).map((l) => l.target)).toEqual(["/tables/orders.md"]);
  });

  test("handles titles and angle-bracketed targets", () => {
    expect(extractLinks('[a](/x.md "Title") [b](<./y.md>)').map((l) => l.target)).toEqual(["/x.md", "./y.md"]);
  });

  test("offset points at the target, not the whole link", () => {
    const body = "prefix [a](/x.md)";
    const link = extractLinks(body)[0]!;
    expect(body.slice(link.offset, link.offset + link.target.length)).toBe("/x.md");
  });
});

describe("resolveLink", () => {
  const at = (from: string, target: string) => resolveLink(from, { text: "", target, offset: 0 });

  test("absolute targets resolve against the bundle root", () => {
    expect(at("a/b", "/tables/orders.md")).toMatchObject({ kind: "concept", id: "tables/orders" });
  });

  test("relative targets resolve against the concept's directory", () => {
    expect(at("metrics/income", "../computations/revenue.md")).toMatchObject({
      kind: "concept",
      id: "computations/revenue",
    });
    expect(at("metrics/income", "./other.md")).toMatchObject({ kind: "concept", id: "metrics/other" });
  });

  test("fragments are captured and stripped from the id", () => {
    expect(at("a", "/tables/orders.md#schema")).toMatchObject({ id: "tables/orders", fragment: "schema" });
  });

  test("external targets are left alone", () => {
    for (const target of ["https://example.com/x.md", "mailto:a@b.c", "//cdn/x.md", "#anchor"]) {
      expect(at("a", target).kind).toBe("external");
    }
  });

  test("directory links are their own kind", () => {
    expect(at("index", "subdir/")).toMatchObject({ kind: "directory", dirId: "subdir" });
  });

  test("non-markdown and escaping targets are unresolved, never concepts", () => {
    expect(at("a", "references/attesters/revenue.py").kind).toBe("unresolved");
    expect(at("a", "../../../etc/passwd.md").kind).toBe("unresolved");
  });
});

describe("rewriteLinks on move", () => {
  const moves = new Map([["tables/orders", "sales/orders"]]);

  test("absolute inbound links are repointed", () => {
    const body = "See [orders](/tables/orders.md) and [other](/tables/customers.md).";
    expect(rewriteLinks(body, { sourceIdBefore: "metrics/rev", sourceIdAfter: "metrics/rev", moves })).toBe(
      "See [orders](/sales/orders.md) and [other](/tables/customers.md).",
    );
  });

  test("relative inbound links are recomputed from the linking concept", () => {
    const body = "[orders](./orders.md)";
    expect(rewriteLinks(body, { sourceIdBefore: "tables/summary", sourceIdAfter: "tables/summary", moves })).toBe(
      "[orders](../sales/orders.md)",
    );
  });

  test("fragments survive the rewrite", () => {
    expect(
      rewriteLinks("[o](/tables/orders.md#schema)", {
        sourceIdBefore: "a",
        sourceIdAfter: "a",
        moves,
      }),
    ).toBe("[o](/sales/orders.md#schema)");
  });

  test("the moved concept's own relative links are recomputed even though their targets did not move", () => {
    const body = "joins [customers](./customers.md), see [policy](/policy.md), and https://x/y";
    expect(rewriteLinks(body, { sourceIdBefore: "tables/orders", sourceIdAfter: "sales/orders", moves })).toBe(
      "joins [customers](../tables/customers.md), see [policy](/policy.md), and https://x/y",
    );
  });

  test("external links and images are never touched", () => {
    const body = "![i](/tables/orders.md) [x](https://example.com/tables/orders.md)";
    expect(rewriteLinks(body, { sourceIdBefore: "a", sourceIdAfter: "a", moves })).toBe(body);
  });

  test("a body with nothing to change is returned identically", () => {
    const body = "no links here";
    expect(rewriteLinks(body, { sourceIdBefore: "a", sourceIdAfter: "a", moves })).toBe(body);
  });

  test("multiple links in one body all move", () => {
    const body = "[a](/tables/orders.md) then [b](/tables/orders.md#x) then [c](/keep.md)";
    expect(rewriteLinks(body, { sourceIdBefore: "a", sourceIdAfter: "a", moves })).toBe(
      "[a](/sales/orders.md) then [b](/sales/orders.md#x) then [c](/keep.md)",
    );
  });
});

describe("relativeTarget", () => {
  test("same directory links are prefixed so they read as paths", () => {
    expect(relativeTarget("tables/orders", "tables/customers")).toBe("./customers.md");
  });

  test("root-level and cross-directory links", () => {
    expect(relativeTarget("orders", "customers")).toBe("./customers.md");
    expect(relativeTarget("metrics/income", "computations/revenue")).toBe("../computations/revenue.md");
  });
});

describe("conceptLinks", () => {
  test("classifies every link in a body", () => {
    const links = conceptLinks("metrics/income", "[a](../computations/revenue.md) [b](https://x) [c](d/)");
    expect(links.map((l) => l.kind)).toEqual(["concept", "external", "directory"]);
  });
});
