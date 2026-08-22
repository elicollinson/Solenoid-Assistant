import { describe, expect, test } from "bun:test";
import { defineTask, getTask, registerTask, runTask, TaskArgsError } from "./registry";
import { z } from "zod";
import "./index";

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

  test("duplicate task registration fails instead of silently overwriting", () => {
    const duplicate = defineTask({
      name: "weather",
      description: "duplicate",
      schema: z.object({}),
      execute: async () => null,
    });
    expect(() => registerTask(duplicate)).toThrow(/already registered/);
  });
});
