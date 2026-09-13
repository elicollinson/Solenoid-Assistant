import { getDb, type Db } from "../db";
import { DEFAULT_OKF_ROOT } from "../okf/bundle";
import { embeddingConfig } from "./embedding";
import { KnowledgeIndex } from "./index";

export function knowledgeIndex(root = DEFAULT_OKF_ROOT, db: () => Db = getDb) {
  return new KnowledgeIndex(db, root, embeddingConfig());
}
export function startEmbeddingWorker(index: KnowledgeIndex, report: (state: string) => void) {
  let stopped = false;
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (stopped || pending) return;
    pending = (async () => {
      try {
        const result = await index.processOne();
        if (!["disabled", "idle", "ready", "superseded"].includes(result)) report(result);
      } catch { report("index_unavailable"); }
    })().finally(() => { pending = undefined; });
  };
  tick();
  const timer = setInterval(tick, 5000);
  timer.unref();
  return async () => { stopped = true; clearInterval(timer); await pending; };
}
