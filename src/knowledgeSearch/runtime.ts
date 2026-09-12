import { join } from "node:path";
import { getDb, type Db } from "../db";
import { embeddingConfig } from "./embedding";
import { KnowledgeIndex } from "./index";

export const OKF_ROOT = join(import.meta.dir, "../../okf");
export function knowledgeIndex(root = OKF_ROOT, db: () => Db = getDb) {
  return new KnowledgeIndex(db, root, embeddingConfig());
}
export function startEmbeddingWorker(index: KnowledgeIndex, report: (state: string) => void) {
  let stopped = false;
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (stopped || pending) return;
    pending = (async () => {
      try {
        // Even disabled installations establish a baseline. Initial existing
        // memories need explicit enrollment; subsequent writes can be recovered.
        index.reconcile();
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
