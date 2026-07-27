import { describe, expect, test } from "bun:test";
import { imessageIntakePrompt } from "./prompts";

describe("imessageIntakePrompt", () => {
  test("no range keeps the original default behavior", () => {
    const p = imessageIntakePrompt();
    expect(p).toContain("for the last 24 hours");
    expect(p).toContain("you may invoke the tool again for a different time period");
    expect(p).not.toContain("start=");
    expect(p).not.toContain("end=");
    // An empty range object means the same thing as no range at all.
    expect(imessageIntakePrompt({})).toBe(p);
  });

  test("a full range states both bounds and the tool's scoping", () => {
    const p = imessageIntakePrompt({
      start: "2026-07-20T00:00:00.000Z",
      end: "2026-07-22T00:00:00.000Z",
    });
    expect(p).toContain("start=2026-07-20T00:00:00.000Z");
    expect(p).toContain("end=2026-07-22T00:00:00.000Z");
    // The window is enforced by the tool, so the prompt describes it as
    // already scoped rather than asking the model to request it — and stops
    // inviting reads outside it.
    expect(p).toContain("already scoped to the requested window");
    expect(p).not.toContain("you may invoke the tool again");
  });

  test("start-only and end-only fall back to the tool defaults for the other bound", () => {
    const startOnly = imessageIntakePrompt({ start: "2026-07-20T00:00:00.000Z" });
    expect(startOnly).toContain("start=2026-07-20T00:00:00.000Z");
    expect(startOnly).toContain("default end (now)");

    const endOnly = imessageIntakePrompt({ end: "2026-07-22T00:00:00.000Z" });
    expect(endOnly).toContain("end=2026-07-22T00:00:00.000Z");
    expect(endOnly).toContain("default start (24 hours before end)");
  });

  test("the rest of the prompt is identical across modes", () => {
    // Only the window instruction may vary; deliverable definitions must not.
    const tail = (p: string) => p.slice(p.indexOf("# Deliverable Details"));
    const byDefault = imessageIntakePrompt();
    const withRange = imessageIntakePrompt({ start: "2026-07-20T00:00:00.000Z" });
    expect(tail(byDefault).length).toBeGreaterThan(0);
    expect(tail(withRange)).toBe(tail(byDefault));
  });
});
