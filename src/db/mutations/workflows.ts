// The Workflows surface, written to.
//
// Everything under ../queries answers "what does this screen draw". This is the
// other half: the three things the detail pane can change about a workflow —
// whether it is paused, what standing rule it runs under, and whether the run
// going right now should stop.
//
// Each one answers with nothing and leaves the caller to re-read. The screen is
// already re-reading on a timer while a run is going, and a mutation that
// returns its own idea of the new state is a second answer to a question the
// next read settles anyway.
import { and, desc, eq, isNull } from "drizzle-orm";
import { ulid, type Db } from "../index";
import * as s from "../schema";

/** Thrown when the slug names nothing this database knows — HTTP 404. */
export class NoSuchWorkflowError extends Error {
  constructor(slug: string) {
    super(`No workflow called ${slug}`);
    this.name = "NoSuchWorkflowError";
  }
}

function require_(db: Db, slug: string): typeof s.workflows.$inferSelect {
  const [workflow] = db.select().from(s.workflows).where(eq(s.workflows.slug, slug)).limit(1).all();
  if (!workflow) throw new NoSuchWorkflowError(slug);
  return workflow;
}

/**
 * Pause or resume, and say who did it.
 *
 * Pausing is the product's decision rather than the catalog's, which is why
 * src/workflows/sync.ts never touches these three columns: a restart must not
 * quietly resume something you stopped.
 */
export function setWorkflowPaused(db: Db, slug: string, paused: boolean, now: Date = new Date()): void {
  const workflow = require_(db, slug);
  if ((workflow.pausedAt != null) === paused) return;

  db.update(s.workflows)
    .set(
      paused
        ? { pausedAt: now, pausedBy: "user", pauseReason: null }
        : { pausedAt: null, pausedBy: null, pauseReason: null },
    )
    .where(eq(s.workflows.id, workflow.id))
    .run();
}

/**
 * Replace the standing instruction, keeping the one it replaced.
 *
 * A new row rather than an UPDATE: the table is versioned, and a rule you gave
 * a workflow in June is part of why a run in June did what it did. The old one
 * is retired and pointed at from the new one, so the chain reads backwards.
 *
 * Empty text retires the current rule without writing a replacement — "run it
 * the way it was set up" is the absence of an instruction, not an instruction
 * saying so.
 */
export function setWorkflowInstructions(db: Db, slug: string, text: string, now: Date = new Date()): void {
  const workflow = require_(db, slug);
  const trimmed = text.trim();

  const [active] = db
    .select()
    .from(s.workflowInstructions)
    .where(and(eq(s.workflowInstructions.workflowId, workflow.id), isNull(s.workflowInstructions.retiredAt)))
    .orderBy(desc(s.workflowInstructions.version))
    .limit(1)
    .all();

  if (active?.text === trimmed) return;

  db.transaction((t) => {
    if (active) {
      t.update(s.workflowInstructions)
        .set({ retiredAt: now })
        .where(eq(s.workflowInstructions.id, active.id))
        .run();
    }
    if (!trimmed) return;

    t.insert(s.workflowInstructions)
      .values({
        id: ulid(now.getTime()),
        workflowId: workflow.id,
        text: trimmed,
        authoredBy: "user",
        version: (active?.version ?? 0) + 1,
        effectiveFrom: now,
        supersedesId: active?.id ?? null,
      })
      .run();
  });
}
