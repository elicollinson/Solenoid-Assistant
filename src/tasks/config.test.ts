import { describe, expect, test } from "bun:test";
import { loadTasksConfig, tasksConfigSchema } from "./config";

describe("tasks.yaml", () => {
  test("shipped config parses and validates", async () => {
    const config = await loadTasksConfig();
    expect(config.tasks.length).toBeGreaterThan(0);
    const daily = config.tasks.find((s) => s.name === "daily-weather");
    expect(daily?.task).toBe("weather");
    expect(daily?.enabled).toBe(true);
  });
});

describe("tasksConfigSchema", () => {
  const valid = { name: "a", task: "weather", cron: "0 7 * * *", args: {} };

  test("applies defaults", () => {
    const parsed = tasksConfigSchema.parse({
      tasks: [{ name: "a", task: "weather", cron: "0 7 * * *" }],
    });
    expect(parsed.tasks[0]?.enabled).toBe(true);
    expect(parsed.tasks[0]?.args).toEqual({});
  });

  test("rejects a schedule with no cron", () => {
    const { cron, ...noCron } = valid;
    expect(() => tasksConfigSchema.parse({ tasks: [noCron] })).toThrow();
  });

  test("rejects duplicate schedule names", () => {
    expect(() =>
      tasksConfigSchema.parse({ tasks: [valid, { ...valid, task: "other" }] }),
    ).toThrow(/unique/);
  });
});
