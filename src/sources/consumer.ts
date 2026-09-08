import { privateSourceContext } from "../core/privateSourceContext";
import { readFile } from "node:fs/promises";
import { getDb, type Db } from "../db";
import {
  assetPath,
  finishCandidate,
  purgeStaging,
  type Candidate,
} from "./assets";
import { log } from "../core/logger";
import { photoSchema } from "./schema";
import { describeImage } from "../utils/vision";
import { createClassifierAgent } from "../agents/classifier";
import {
  classifyScreenshots,
  CLASSIFICATION_VISION_PROMPT,
} from "../tools/photos";
import { z } from "zod";

const descriptionSchema = z.object({
  app: z.string(),
  summary: z.string(),
  prominentText: z.array(z.string()),
});
export async function classifyCandidate(row: Candidate, db: Db) {
  const ref = db.$client
    .query("SELECT payload FROM source_photo_candidates WHERE hash=? LIMIT 1")
    .get(row.hash) as { payload: string } | null;
  if (!ref) throw new Error("Candidate metadata absent");
  const photo = photoSchema.parse(JSON.parse(ref.payload));
  const file = assetPath(row.hash, row.extension, true);
  await readFile(file); // Fail before initializing provider clients if staging expired.
  const description = await describeImage(
    file,
    CLASSIFICATION_VISION_PROMPT,
    descriptionSchema,
  );
  const resource = await createClassifierAgent();
  try {
    // Reuse the existing classifier and per-item prompt-injection boundary.
    const output = await classifyScreenshots(
      resource.agent,
      {},
      {
        describe: async () => ({
          windowStart: photo.date,
          windowEnd: photo.date,
          returned: 1,
          totalInWindow: 1,
          failed: 0,
          screenshots: [
            {
              uuid: photo.uuid,
              filename: photo.filename,
              date: photo.date,
              path: file,
              description,
            },
          ],
        }),
      },
    );
    const result = output.screenshots[0];
    if (result?.status === "quarantined")
      return { result: null, status: "quarantined" };
    if (result?.status !== "classified")
      throw new Error("Screenshot classification failed");
    return { result: result.classification, status: "rejected" };
  } finally {
    await resource.close();
  }
}
export async function consumeScreenshot(
  db = getDb(),
  classify = classifyCandidate,
): Promise<boolean> {
  await purgeStaging(db);
  const now = Date.now();
  const row = db.$client.transaction(() => {
    const next = db.$client
      .query(
        "SELECT * FROM source_candidates WHERE status IN ('pending','failed','processing') AND retry_at<=? AND lease_until<? ORDER BY created_at LIMIT 1",
      )
      .get(now, now) as Candidate | null;
    if (next)
      db.$client
        .query(
          "UPDATE source_candidates SET status='processing',lease_until=?,attempts=attempts+1 WHERE hash=?",
        )
        .run(now + 30 * 60_000, next.hash);
    return next;
  })();
  if (!row) return false;
  try {
    const outcome = await privateSourceContext.run(true, () =>
      classify(row, db),
    );
    await finishCandidate(row, outcome.result, outcome.status, db);
    log.info("Screenshot collection classified", {
      component: "source-consumer",
      status: outcome.result?.classification ?? outcome.status,
    });
  } catch {
    // No OCR, image bytes, or provider error payloads in durable queue errors.
    db.$client
      .query(
        "UPDATE source_candidates SET status='failed',lease_until=0,retry_at=? WHERE hash=?",
      )
      .run(
        Date.now() +
          Math.min(3600_000, 60_000 * 2 ** Math.min(row.attempts, 6)),
        row.hash,
      );
    log.warn("Screenshot collection classification failed; retry scheduled", {
      component: "source-consumer",
    });
  }
  return true;
}
