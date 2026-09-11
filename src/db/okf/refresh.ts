import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { Db } from "../index";
import { reindexOkf } from "./reindex";

// Tools and the worker write OKF files, while UI queries read the SQLite
// projection. Refresh on list/detail reads so a deployment or later write
// never requires a manual db:index-okf. Concurrent requests share one pass.
export function createKnowledgeRefresh(root = join(import.meta.dir, "../../../okf")) {
  const running = new WeakMap<Db, Promise<unknown>>();
  return (db: Db): Promise<unknown> => {
    const pending = running.get(db);
    if (pending) return pending;
    const refresh = (async () => {
      if (!(await stat(root)).isDirectory()) throw new Error("Knowledge store unavailable");
      const result = await reindexOkf(db, { root });
      if (result.problems.length) throw new Error("Some knowledge records could not be indexed");
      return result;
    })().finally(() => running.delete(db));
    running.set(db, refresh);
    return refresh;
  };
}
