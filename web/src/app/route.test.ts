import { expect, test } from "bun:test";
import { hashFromRoute, routeFromHash } from "./AgentHome";

test("a route survives the URL and junk falls back to Chat", () => {
  for (const route of [{ view: "Chat" }, { view: "Things I know", slug: "okf:a/b c" }, { view: "Workflows", slug: "weekly-digest", tab: "Runs" }]) {
    expect(routeFromHash(hashFromRoute(route))).toEqual({ slug: undefined, tab: undefined, ...route });
  }
  expect(hashFromRoute({ view: "Calendar", tab: "Runs" })).toBe("#/Calendar");
  expect(routeFromHash("")).toEqual({ view: "Chat" });
  expect(routeFromHash("#/Nowhere/x")).toEqual({ view: "Chat" });
});
