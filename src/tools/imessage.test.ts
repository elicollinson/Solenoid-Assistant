import { describe, expect, test } from "bun:test";
import { createReadImessagesTool, readImessagesTool } from "./imessage";

// Construction-level tests only: execute() reads the real Messages database,
// so what's asserted here is the enforcement surface — which parameters the
// model is given, and what happens to arguments outside them.

const paramNames = (tool: { definition: { function: { parameters?: unknown } } }) =>
  Object.keys(
    (tool.definition.function.parameters as { properties: Record<string, unknown> }).properties,
  ).sort();

describe("createReadImessagesTool", () => {
  const start = new Date("2026-07-20T00:00:00.000Z");
  const end = new Date("2026-07-22T00:00:00.000Z");

  test("unbounded: the model chooses the window", () => {
    expect(paramNames(readImessagesTool)).toEqual(["end", "hoursBack", "limit", "start"]);
    expect(paramNames(createReadImessagesTool())).toEqual(["end", "hoursBack", "limit", "start"]);
    expect(paramNames(createReadImessagesTool({}))).toEqual(["end", "hoursBack", "limit", "start"]);
  });

  test("bounded: no time parameters exist for the model to pass", () => {
    // This is the enforcement: the window lives in the tool's closure, so
    // there is no argument — model-chosen or prompt-injected — that can move it.
    const tool = createReadImessagesTool({ start, end });
    expect(paramNames(tool)).toEqual(["limit"]);
  });

  test("bounded: attempted time arguments are stripped at validation", () => {
    const tool = createReadImessagesTool({ start, end });
    // invokeTool runs tool.schema.parse before execute; a model that tries to
    // pass start/end/hoursBack anyway has them dropped, not honored.
    const parsed = tool.schema.parse({
      limit: 10,
      start: "1999-01-01T00:00:00Z",
      end: "2099-01-01T00:00:00Z",
      hoursBack: 720,
    }) as Record<string, unknown>;
    expect(parsed).toEqual({ limit: 10 });
  });

  test("bounded: the description states the exact window", () => {
    const tool = createReadImessagesTool({ start, end });
    expect(tool.definition.function.description).toContain("2026-07-20T00:00:00.000Z");
    expect(tool.definition.function.description).toContain("2026-07-22T00:00:00.000Z");
  });

  test("end-only: start defaults to 24 hours before end", () => {
    const tool = createReadImessagesTool({ end });
    expect(tool.definition.function.description).toContain("2026-07-21T00:00:00.000Z");
    expect(tool.definition.function.description).toContain("2026-07-22T00:00:00.000Z");
    expect(paramNames(tool)).toEqual(["limit"]);
  });

  test("start-only: still bounded, end resolved at construction", () => {
    const before = Date.now();
    const tool = createReadImessagesTool({ start });
    expect(paramNames(tool)).toEqual(["limit"]);
    expect(tool.definition.function.description).toContain("2026-07-20T00:00:00.000Z");
    // The end bound is frozen when the tool is built (per request), not per call.
    const match = tool.definition.function.description!.match(
      /to (\d{4}-\d{2}-\d{2}T[0-9:.]+Z) \(inclusive\)/,
    );
    expect(match).not.toBeNull();
    const frozenEnd = new Date(match![1]!).getTime();
    expect(frozenEnd).toBeGreaterThanOrEqual(before);
    expect(frozenEnd).toBeLessThanOrEqual(Date.now());
  });
});
