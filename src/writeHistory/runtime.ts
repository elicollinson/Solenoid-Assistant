import { knowledgeIndex } from "../knowledgeSearch/runtime";
import { join } from "node:path";
import { getDb, type Db } from "../db";
import { configureFileMutation, configureRowMutation, configureWriteExecution } from "../core/writeExecution";
import { reindexOkf } from "../db/okf/reindex";
import { WriteHistory } from "./history";
import { FileHistory } from "./files";
import { RowHistory } from "./rows";

export function createHistoryRuntime(db: Db, root: string, key?: Buffer,
  refresh?: (root: string, concepts: string[]) => Promise<void>) {
  const history = new WriteHistory(db, key);
  const index = knowledgeIndex(root, () => db);
  const files = new FileHistory(history, refresh ?? (async (root, concepts) => {
    const result = await reindexOkf(db, { root });
    if (result.problems.length) throw new Error("Knowledge refresh incomplete");
    knowledgeIndex(root, () => db).reconcile({ enroll: concepts });
  }));
  return { history, files, rows: new RowHistory(history), root, neighbors: async (id: string, sha: string, limit: number) => index.neighbors(id, sha, limit), captureEnabled: !!key };
}
export type HistoryRuntime = ReturnType<typeof createHistoryRuntime>;
let runtime: HistoryRuntime | undefined;
export function historyRuntime(): HistoryRuntime {
  if (!runtime) {
    const raw = process.env.WRITE_HISTORY_KEY;
    if (raw && (!/^[A-Za-z0-9+/]{43}=$/.test(raw) || Buffer.from(raw, "base64").length !== 32)) throw new Error("WRITE_HISTORY_KEY must be a base64 encoded 32-byte key");
    runtime = createHistoryRuntime(getDb(), join(import.meta.dir, "../../okf"), raw ? Buffer.from(raw, "base64") : undefined);
  }
  return runtime;
}
export function installHistoryRuntime() {
  const runtime = historyRuntime();
  // A persisted reservation must precede file/remote side effects.
  runtime.history.db.$client.exec("PRAGMA synchronous = FULL");
  configureWriteExecution(runtime.history, true);
  if (runtime.captureEnabled) {
    configureFileMutation((root, actor, tool, stage) => runtime.files.mutate(root, actor, tool, stage));
    configureRowMutation((table, id, fields, fn) => runtime.rows.mutate(table, id, fields, fn));
  }
  runtime.history.prune();
  return runtime;
}
