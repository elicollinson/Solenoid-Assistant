import { Cron } from "croner";
import { getTask } from "./registry";
import type { ScheduledTask } from "./config";

export function validateSchedule(schedule: ScheduledTask): string[] {
  const errors: string[] = [];
  const task = getTask(schedule.task);
  if (!task) {
    errors.push(`[${schedule.name}] unknown task "${schedule.task}"`);
  } else {
    const parsed = task.schema.safeParse(schedule.args);
    if (!parsed.success) {
      errors.push(
        `[${schedule.name}] invalid args for task "${schedule.task}": ${parsed.error.message}`,
      );
    }
  }
  try {
    new Cron(schedule.cron, { paused: true, timezone: schedule.timezone }).stop();
  } catch (error) {
    errors.push(
      `[${schedule.name}] invalid cron "${schedule.cron}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return errors;
}
