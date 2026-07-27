// Concurrency-limited fan-out: run the same agent+prompt+schema against a
// list of items, capping how many calls are in flight at once. Extracted from
// the /messageExtraction endpoint so the pattern is reusable.
import { z } from "zod";
import pLimit from "p-limit";
import { type Agent } from "../core/rawAgent";
import { type PromptTemplate } from "../prompts";

// Per-item outcome, mirroring PromiseSettledResult but with `reason` normalized
// to an Error so callers can always read `.message`.
export type FanoutResult<R> =
  | { status: "fulfilled"; value: R }
  | { status: "rejected"; reason: Error };

// Settled, not all-or-nothing: a single flaky item used to reject the whole
// fanout and 502 the calling endpoint, so a ~12% per-call failure rate failed
// most multi-item batches even though almost every call succeeded. Outcomes are
// returned positionally — `results[i]` always corresponds to `items[i]` — so
// callers can decide per item whether to drop, retry, or fail.
export async function fanout<T, S extends z.ZodType>(
  items: T[],
  agent: Agent,
  prompt: PromptTemplate<T>,
  schema: S,
  maxConcurrent: number,
): Promise<FanoutResult<z.infer<S>>[]> {
  const limit = pLimit(maxConcurrent);
  const settled = await Promise.allSettled(
    items.map((item) => limit(() => agent.run(prompt, item, schema))),
  );
  return settled.map((r) =>
    r.status === "fulfilled"
      ? { status: "fulfilled", value: r.value }
      : {
          status: "rejected",
          reason: r.reason instanceof Error ? r.reason : new Error(String(r.reason)),
        },
  );
}

// Successful values only. Positional correspondence with the input is lost —
// use this when items are independent and gaps don't matter.
export function fulfilled<R>(results: FanoutResult<R>[]): R[] {
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

// Failure reasons only, for logging or for deciding that too much was lost.
export function rejected<R>(results: FanoutResult<R>[]): Error[] {
  return results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
}
