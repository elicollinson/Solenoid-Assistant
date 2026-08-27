// The fetch seam.
//
// These guard the condition behind a bug that reached the browser and nothing
// else caught: a detail hook asked for `/api/knowledge/` while no row was open,
// the router read the trailing slash off and answered with the *list*, and the
// hook filed a list payload as a ready detail. Clicking a row then rendered the
// detail one frame before the refetch, read `account` off the list, and threw —
// which unmounts the whole React root, so the screen went blank rather than
// showing anything wrong.
//
// The render tests pass components a payload directly, so they could not see
// it. These can.
import { describe, expect, test } from "bun:test";
import { detailPath } from "./api";

describe("asking for one member of a collection", () => {
  test("asks for nothing when there is no member to ask about", () => {
    // The whole bug: "" built "/api/knowledge/", which answers 200 with the list.
    expect(detailPath("/api/knowledge", null)).toBeNull();
    expect(detailPath("/api/knowledge", undefined)).toBeNull();
    expect(detailPath("/api/knowledge", "")).toBeNull();
  });

  test("names the member when there is one", () => {
    expect(detailPath("/api/knowledge", "okfo_abc")).toBe("/api/knowledge/okfo_abc");
  });

  test("encodes an id that would otherwise change the path", () => {
    expect(detailPath("/api/workflows", "a/b")).toBe("/api/workflows/a%2Fb");
    expect(detailPath("/api/reminders", "a b?c")).toBe("/api/reminders/a%20b%3Fc");
  });
});
