import { describe, expect, test } from "bun:test";
import { getTask, runTask, TaskArgsError } from "./index";

describe("task registry", () => {
  test("weather task is registered", () => {
    expect(getTask("weather")?.description).toContain("weather");
  });

  test("runTask rejects an unknown task", () => {
    expect(runTask("nope", {})).rejects.toThrow('Unknown task "nope"');
  });

  test("runTask rejects invalid args before touching the agent", () => {
    expect(runTask("weather", { city: "" })).rejects.toBeInstanceOf(TaskArgsError);
  });
});
