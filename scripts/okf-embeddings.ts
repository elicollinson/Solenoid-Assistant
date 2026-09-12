#!/usr/bin/env bun
import { knowledgeIndex } from "../src/knowledgeSearch/runtime";
import { embeddingConfig, googleEmbeddings } from "../src/knowledgeSearch/embedding";

// No command defaults to paid work. Never print credentials or memory text.
const args = process.argv.slice(2);
const command = args[0] ?? "status";
const rootFlag = args.find(a => a.startsWith("--root="));
const config = embeddingConfig();
if (command === "doctor") {
  console.log({ enabled: config.enabled, projectConfigured: !!config.project, location: config.location,
    model: config.model, dimensions: config.dimensions, dailyTokenCeiling: config.dailyTokens,
    adcPathConfigured: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
    voiceApiKeyPresent: !!process.env.GEMINI_API_KEY,
    note: "Voice API keys are not used. ADC existence does not prove Vertex IAM/model access." });
} else if (command === "smoke") {
  if (!args.includes("--confirm")) throw new Error("Use smoke --confirm for one paid synthetic request (no memory files read).");
  try {
    const values = await googleEmbeddings(config).embed("A fictional otter enjoys astronomy books.", "document");
    console.log({ status: "ok", dimensions: values.length, norm: Math.sqrt(values.reduce((s, v) => s + v * v, 0)) });
  } catch { console.error("Synthetic embedding failed. Check enabled flag, Cloud project, ADC, IAM, region and model access; no raw provider error is logged."); process.exitCode = 1; }
} else {
  const index = knowledgeIndex(rootFlag?.slice(7));
  if (["status", "plan"].includes(command)) {
    const status = command === "plan" ? index.plan() : index.reconcile();
    console.log({ ...status, note: "Local scan only. Existing unindexed memories require backfill --confirm. No remote calls made." });
  } else if (command === "backfill") {
    if (!args.includes("--confirm")) throw new Error("Use backfill --confirm to enroll all current memories for paid indexing.");
    if (!config.enabled || !config.project) throw new Error("Enable OKF embeddings and configure the Cloud project first.");
    const maxJobs = Number(args.find(a => a.startsWith("--max-jobs="))?.slice(11) ?? 20);
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 10_000) throw new Error("max-jobs must be 1..10000");
    index.reconcile({ enroll: "all", retryFailed: args.includes("--retry-failed") });
    let processed = 0;
    for (; processed < maxJobs; processed++) {
      const state = await index.processOne();
      if (["idle", "daily_budget_exhausted", "missing_project"].includes(state)) break;
    }
    console.log({ processed, ...index.status(), note: "Remaining enrolled work persists; the running worker continues within the daily budget." });
  } else throw new Error("Commands: doctor, status, plan, smoke --confirm, backfill --confirm [--max-jobs=20] [--retry-failed]");
}
