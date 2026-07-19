// Task registration lives here, not in per-task modules as import side
// effects, so this file is the one auditable list of everything the worker
// (and the /tasks endpoints) can run — same spirit as agents listing their
// tools explicitly in src/agents/demo.ts.
import { registerTask } from "./registry";
import { weatherTask } from "./weather";

registerTask(weatherTask);

export {
  tasks,
  getTask,
  runTask,
  defineTask,
  TaskArgsError,
  type TaskDef,
  type TaskRunResult,
} from "./registry";
export { loadTasksConfig, type TasksConfig, type ScheduledTask } from "./config";
