// Lending the inference host to something else.
//
// The model runs on local hardware that is also used for other work — evals
// above all, which want the whole GPU and produce numbers worth nothing if the
// assistant's 3am sweep lands in the middle of them. So another project can
// put a hold on inference before it starts and release it when it is done.
//
// While any hold is live the worker queues what the clock starts instead of
// sending it to the model (see worker.ts), and once the last one lifts it runs
// the queue oldest first, one at a time. Chat and runs a person starts by hand
// are not held: someone choosing to ask while an eval is going has made that
// trade themselves.
//
// Holds are named and expire. Named, so two overlapping scripts each release
// only their own. Expiring, so a script that dies before its release costs
// hours of queued work rather than a silently paused assistant.
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { ulid, type Db } from "../db";
import * as s from "../db/schema";

export const DEFAULT_HOLD_MINUTES = 6 * 60;
export const MAX_HOLD_MINUTES = 24 * 60;

export const holdRequestSchema = z.object({
  holder: z.string().trim().min(1).max(80).regex(/^[\w.:@-]+$/, "letters, digits and . _ : @ - only"),
  reason: z.string().trim().max(200).optional(),
  minutes: z.number().int().min(1).max(MAX_HOLD_MINUTES).default(DEFAULT_HOLD_MINUTES),
});

export const releaseRequestSchema = z.object({ holder: holdRequestSchema.shape.holder });

export interface InferenceHoldStatus {
  held: boolean;
  holds: { holder: string; reason: string | null; since: string; expiresAt: string }[];
  /** Runs waiting for the hold to lift. */
  queued: number;
}

/** The holds that are still live: not released and not expired. */
function liveHolds(db: Db, now: Date) {
  return db
    .select()
    .from(s.inferenceHolds)
    .where(and(isNull(s.inferenceHolds.releasedAt), gt(s.inferenceHolds.expiresAt, now)))
    .orderBy(asc(s.inferenceHolds.createdAt))
    .all();
}

/** Whether scheduled inference should wait. */
export function inferenceHeld(db: Db, now: Date = new Date()): boolean {
  return liveHolds(db, now).length > 0;
}

export function inferenceStatus(db: Db, now: Date = new Date()): InferenceHoldStatus {
  const holds = liveHolds(db, now);
  const [queued] = db.select({ n: sql<number>`count(*)` }).from(s.runQueue).all();
  return {
    held: holds.length > 0,
    holds: holds.map((hold) => ({
      holder: hold.holder,
      reason: hold.reason,
      since: hold.createdAt.toISOString(),
      expiresAt: hold.expiresAt.toISOString(),
    })),
    queued: queued?.n ?? 0,
  };
}

/**
 * Take a hold, or renew the one this holder already has.
 *
 * Renewing rather than refusing makes the call safe to repeat, so a long eval
 * can simply hold again every few hours to keep its slot.
 */
export function holdInference(
  db: Db,
  request: z.input<typeof holdRequestSchema>,
  now: Date = new Date(),
): InferenceHoldStatus {
  const { holder, reason, minutes } = holdRequestSchema.parse(request);
  const expiresAt = new Date(now.getTime() + minutes * 60_000);
  db.transaction((t) => {
    // A lapsed hold still occupies the holder's unique slot until it is closed.
    t.update(s.inferenceHolds)
      .set({ releasedAt: now })
      .where(and(eq(s.inferenceHolds.holder, holder), isNull(s.inferenceHolds.releasedAt), lte(s.inferenceHolds.expiresAt, now)))
      .run();
    const [current] = t
      .select({ id: s.inferenceHolds.id })
      .from(s.inferenceHolds)
      .where(and(eq(s.inferenceHolds.holder, holder), isNull(s.inferenceHolds.releasedAt)))
      .limit(1)
      .all();
    if (current) {
      t.update(s.inferenceHolds)
        .set({ expiresAt, ...(reason !== undefined ? { reason } : {}) })
        .where(eq(s.inferenceHolds.id, current.id))
        .run();
    } else {
      t.insert(s.inferenceHolds)
        .values({ id: ulid(now.getTime()), holder, reason: reason ?? null, createdAt: now, expiresAt })
        .run();
    }
  });
  return inferenceStatus(db, now);
}

/** Release this holder's hold. Releasing one that is not held is not an error. */
export function releaseInference(db: Db, holder: string, now: Date = new Date()): InferenceHoldStatus {
  db.update(s.inferenceHolds)
    .set({ releasedAt: now })
    .where(and(eq(s.inferenceHolds.holder, releaseRequestSchema.parse({ holder }).holder), isNull(s.inferenceHolds.releasedAt)))
    .run();
  return inferenceStatus(db, now);
}
