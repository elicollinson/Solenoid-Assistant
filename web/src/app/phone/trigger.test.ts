// The run trigger's state, driven the way the sheet drives it: press, ask,
// hear back, and press again — on the same workflow and on another one.
import { describe, expect, test } from "bun:test";
import { NO_TRIGGER, triggerFor, triggerReducer, type TriggerEvent } from "./trigger";

const run = (label: string) => ({ runId: `run-${label}`, ordinal: 1, label });
const play = (...events: TriggerEvent[]) => events.reduce(triggerReducer, NO_TRIGGER);

describe("the run trigger", () => {
  test("a run is on the record once accepted, and the sheet reads it", () => {
    const state = play({ type: "clear", slug: "a" }, { type: "asked", slug: "a" }, { type: "accepted", slug: "a", run: run("Run 1") });
    expect(triggerFor(state, "a")).toEqual({ pending: false, error: null, started: "Run 1" });
  });

  test("run, finish, run again: the second press begins with nothing on the record", () => {
    // The form closes itself once `started` is set. If the first run's label
    // survived the second press, the form would close as it opened.
    const first = play({ type: "clear", slug: "a" }, { type: "asked", slug: "a" }, { type: "accepted", slug: "a", run: run("Run 1") });
    const pressed = triggerReducer(first, { type: "clear", slug: "a" });
    expect(triggerFor(pressed, "a")).toEqual({ pending: false, error: null, started: null });

    const second = play(
      { type: "clear", slug: "a" },
      { type: "asked", slug: "a" },
      { type: "accepted", slug: "a", run: run("Run 1") },
      { type: "clear", slug: "a" },
      { type: "asked", slug: "a" },
      { type: "accepted", slug: "a", run: run("Run 2") },
    );
    expect(triggerFor(second, "a").started).toBe("Run 2");
  });

  test("a refusal is on the sheet until the next press, and a press wipes it", () => {
    const refused = play({ type: "clear", slug: "a" }, { type: "asked", slug: "a" }, { type: "refused", slug: "a", message: "Too small." });
    expect(triggerFor(refused, "a")).toEqual({ pending: false, error: "Too small.", started: null });
    expect(triggerFor(triggerReducer(refused, { type: "clear", slug: "a" }), "a").error).toBeNull();
  });

  test("another workflow opened in the same tab inherits none of it", () => {
    const state = play({ type: "clear", slug: "a" }, { type: "asked", slug: "a" }, { type: "accepted", slug: "a", run: run("Run 1") });
    expect(triggerFor(state, "b")).toEqual({ pending: false, error: null, started: null });
    expect(triggerFor(state, null)).toEqual({ pending: false, error: null, started: null });
  });

  test("a late answer for a workflow no longer asked about is not written over the open one", () => {
    const state = play(
      { type: "asked", slug: "a" },
      { type: "clear", slug: "b" },
      { type: "asked", slug: "b" },
      { type: "accepted", slug: "a", run: run("Run 9") },
    );
    expect(triggerFor(state, "b")).toEqual({ pending: true, error: null, started: null });
    expect(triggerFor(state, "a").started).toBeNull();
  });

  test("while the request is out the sheet reads pending, and nothing else", () => {
    expect(triggerFor(play({ type: "clear", slug: "a" }, { type: "asked", slug: "a" }), "a")).toEqual({ pending: true, error: null, started: null });
  });
});
