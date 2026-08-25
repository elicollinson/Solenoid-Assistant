import { z } from "zod";
import {
  PromptInjectionDetectedError,
  isPromptInjectionDetectedError,
  isPromptInjectionScreeningError,
  type Agent,
  type PromptInjectionBoundary,
} from "../core/rawAgent";
import { SpanStatusCode, withSpanKind } from "../core/tracing";
import { type PromptTemplate } from "../prompts";

export type IsolationKey = string | number | bigint | symbol;

export type IsolatedItemResult<K, R> =
  | { status: "fulfilled"; key: K; index: number; value: R }
  | {
      status: "quarantined";
      key: K;
      index: number;
      reason: "prompt_injection";
      boundary: PromptInjectionBoundary;
    }
  | { status: "rejected"; key: K; index: number; reason: Error };

export interface IsolatedBatchResult<K, R> {
  results: IsolatedItemResult<K, R>[];
  completed: number;
  quarantined: number;
  failed: number;
}

export interface RunIsolatedOptions<T, K extends IsolationKey, R> {
  items: readonly T[];
  key: (item: T, index: number) => K;
  concurrency: number;
  execute: (item: T, index: number) => Promise<R> | R;
  /** Safe span name only; do not include item keys or user-controlled text. */
  name?: string;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function validateKeys<T, K extends IsolationKey>(
  items: readonly T[],
  keyFor: (item: T, index: number) => K,
): K[] {
  const keys: K[] = [];
  const seen = new Set<IsolationKey>();
  for (let index = 0; index < items.length; index++) {
    const key = keyFor(items[index]!, index);
    const valid =
      typeof key === "symbol" ||
      typeof key === "bigint" ||
      (typeof key === "string" && key.length > 0) ||
      (typeof key === "number" && Number.isFinite(key));
    if (!valid) throw new Error(`Invalid isolation key at item index ${index}`);
    if (seen.has(key)) throw new Error(`Duplicate isolation key at item index ${index}`);
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Execute one callback invocation per declared isolation unit.
 *
 * Collections are partitioned before entering an agent; one Agent.run()
 * processes one unit; aggregators consume fulfilled results only; quarantine
 * remains distinct from ordinary failure; side effects follow successful item
 * processing; nested batches contain detection at the nearest iterator; and a
 * scanner infrastructure failure always propagates outward.
 *
 * Keys are validated before execution and omitted from traces because they may
 * contain PII.
 */
export async function runIsolated<T, K extends IsolationKey, R>(
  options: RunIsolatedOptions<T, K, R>,
): Promise<IsolatedBatchResult<K, R>> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new RangeError("runIsolated concurrency must be a positive integer");
  }
  const keys = validateKeys(options.items, options.key);

  return withSpanKind(
    "CHAIN",
    options.name ?? "run-isolated",
    {
      "batch.item_count": options.items.length,
      "batch.concurrency": options.concurrency,
    },
    async (span) => {
      const results = new Array<IsolatedItemResult<K, R> | undefined>(options.items.length);
      let nextIndex = 0;
      let fatalError: Error | undefined;

      const worker = async (): Promise<void> => {
        while (!fatalError) {
          const index = nextIndex++;
          if (index >= options.items.length) return;
          const item = options.items[index]!;
          const key = keys[index]!;

          await withSpanKind(
            "CHAIN",
            `${options.name ?? "run-isolated"}.item`,
            { "item.index": index },
            async (itemSpan) => {
              try {
                const value = await options.execute(item, index);
                results[index] = { status: "fulfilled", key, index, value };
                itemSpan.setAttribute("item.status", "fulfilled");
              } catch (error) {
                if (isPromptInjectionScreeningError(error)) {
                  fatalError = normalizeError(error);
                  itemSpan.setAttribute("item.status", "fatal");
                  itemSpan.setAttribute(
                    "item.fatal_failure_category",
                    "prompt_injection_screening_failed",
                  );
                  return;
                }
                if (isPromptInjectionDetectedError(error)) {
                  results[index] = {
                    status: "quarantined",
                    key,
                    index,
                    reason: "prompt_injection",
                    boundary: error.boundary,
                  };
                  itemSpan.setAttribute("item.status", "quarantined");
                  return;
                }
                results[index] = {
                  status: "rejected",
                  key,
                  index,
                  reason: normalizeError(error),
                };
                itemSpan.setAttribute("item.status", "rejected");
              }
            },
          );
        }
      };

      await Promise.all(
        Array.from(
          { length: Math.min(options.concurrency, options.items.length) },
          () => worker(),
        ),
      );

      const settled = results.filter(
        (result): result is IsolatedItemResult<K, R> => result !== undefined,
      );
      const completed = settled.filter(({ status }) => status === "fulfilled").length;
      const quarantined = settled.filter(({ status }) => status === "quarantined").length;
      const failed = settled.filter(({ status }) => status === "rejected").length;
      span.setAttributes({
        "batch.completed_count": completed,
        "batch.quarantined_count": quarantined,
        "batch.failed_count": failed,
      });

      if (fatalError) {
        span.setAttribute("batch.fatal_failure_category", "prompt_injection_screening_failed");
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw fatalError;
      }

      return { results: settled, completed, quarantined, failed };
    },
  );
}

// Compatibility result for existing callers. New security-sensitive workflows
// consume runIsolated() so quarantine remains distinguishable.
export type FanoutResult<R> =
  | { status: "fulfilled"; value: R }
  | { status: "rejected"; reason: Error };

export async function fanout<T, S extends z.ZodType>(
  items: T[],
  agent: Agent,
  prompt: PromptTemplate<T>,
  schema: S,
  maxConcurrent: number,
): Promise<FanoutResult<z.infer<S>>[]> {
  const batch = await runIsolated({
    items,
    key: (_item, index) => index,
    concurrency: maxConcurrent,
    name: "agent-fanout",
    execute: (item) => agent.run(prompt, item, schema),
  });
  return batch.results.map((result) => {
    if (result.status === "fulfilled") {
      return { status: "fulfilled", value: result.value };
    }
    if (result.status === "quarantined") {
      return {
        status: "rejected",
        reason: new PromptInjectionDetectedError(result.boundary),
      };
    }
    return { status: "rejected", reason: result.reason };
  });
}

// Successful values only. Positional correspondence with the input is lost —
// use this when items are independent and gaps don't matter.
export function fulfilled<R>(results: FanoutResult<R>[]): R[] {
  return results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );
}

// Failure reasons only, for logging or for deciding that too much was lost.
export function rejected<R>(results: FanoutResult<R>[]): Error[] {
  return results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
}
