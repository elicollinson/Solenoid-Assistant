// Concurrency-limited fan-out: run the same agent+prompt+schema against a
// list of items, capping how many calls are in flight at once. Extracted from
// the /messageExtraction endpoint so the pattern is reusable.
import { z } from "zod";
import pLimit from "p-limit";
import { type Agent } from "../core/rawAgent";
import { type PromptTemplate } from "../prompts";

export async function fanout<T, S extends z.ZodType>(
  items: T[],
  agent: Agent,
  prompt: PromptTemplate<T>,
  schema: S,
  maxConcurrent: number,
): Promise<z.infer<S>[]> {
  const limit = pLimit(maxConcurrent);
  return Promise.all(
    items.map((item) => limit(() => agent.run(prompt, item, schema))),
  );
}