import { canonicalBundleRoot } from "../okf/bundle";
import { knowledgeIndex, OKF_ROOT } from "../knowledgeSearch/runtime";
import { getDb, type Db } from "../db";
import { reindexOkf } from "../db/okf/reindex";
import { WriteHistory } from "./history";
import { FileHistory, configureFileMutation } from "./files";

export function createHistoryRuntime(db: Db, root: string, refresh?: (root: string, concepts: string[]) => Promise<void>) {
  root = canonicalBundleRoot(root);
  const history = new WriteHistory(db), index = knowledgeIndex(root, () => db);
  const files = new FileHistory(history, refresh ?? (async (root, concepts) => {
    const result = await reindexOkf(db, { root });
    if (result.problems.length) throw new Error("Knowledge refresh incomplete");
    knowledgeIndex(root, () => db).reconcile({ enroll: concepts });
  }));
  return { history, files, root, neighbors: async (id: string, sha: string, limit: number) => {
    const result = index.neighbors(id, sha, limit);
    return { ...result, status: result.status === "ready" ? "ready" as const : "unavailable" as const };
  } };
}
export type HistoryRuntime = ReturnType<typeof createHistoryRuntime>;
let runtime: HistoryRuntime | undefined;
export function historyRuntime(): HistoryRuntime { return runtime ??= createHistoryRuntime(getDb(), OKF_ROOT); }
export function installHistoryRuntime() {
  const runtime = historyRuntime();
  runtime.history.db.$client.exec("PRAGMA synchronous = FULL");
  configureFileMutation((root, actor, tool, stage) => runtime.files.mutate(root, actor, tool, stage));
  runtime.history.prune();
  void runtime.files.maintain();
  return runtime;
}
