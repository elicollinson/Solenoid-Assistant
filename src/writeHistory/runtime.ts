import { canonicalBundleRoot, DEFAULT_OKF_ROOT } from "../okf/bundle";
import { knowledgeIndex } from "../knowledgeSearch/runtime";
import type { KnowledgeIndex } from "../knowledgeSearch";
import { getDb, type Db } from "../db";
import { createKnowledgeRefresh } from "../db/okf/refresh";
import { WriteHistory } from "./history";
import { FileHistory, configureFileMutation } from "./files";

export function createHistoryRuntime(db: Db, root: string, refresh?: (root: string, concepts: string[]) => Promise<void>,
  index: KnowledgeIndex = knowledgeIndex(root, () => db)) {
  root = canonicalBundleRoot(root);
  const history = new WriteHistory(db), reindex = createKnowledgeRefresh(root);
  const files = new FileHistory(history, refresh ?? (async (_root, concepts) => {
    await reindex(db);
    index.reconcile({ enroll: concepts });
  }));
  return { history, files, root, neighbors: index.neighbors.bind(index) };
}
export type HistoryRuntime = ReturnType<typeof createHistoryRuntime>;
let runtime: HistoryRuntime | undefined;
export function historyRuntime(): HistoryRuntime { return runtime ??= createHistoryRuntime(getDb(), DEFAULT_OKF_ROOT); }
export function installHistoryRuntime() {
  const runtime = historyRuntime();
  runtime.history.db.$client.exec("PRAGMA synchronous = FULL");
  configureFileMutation((root, actor, tool, stage) => runtime.files.mutate(root, actor, tool, stage));
  runtime.history.prune();
  void runtime.files.maintain();
  return runtime;
}
