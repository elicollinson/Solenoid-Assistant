import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../../db";
import * as s from "../../db/schema";
import { loadRuntimeConfig, type RuntimeConfig } from "../config";
import { diagnosticLine, logBounds, queryLogPage, type LogPageInput } from "./diagnostics";

/** Same source selection for chat and the HTTP log pane. Fallback never
 * masquerades as internal agent/tool logs, and cancellation never falls back. */
export async function readRunLogPage(db: Db, runId: string, input: LogPageInput, options: { signal?: AbortSignal; config?: RuntimeConfig } = {}) {
  options.signal?.throwIfAborted();
  const [run] = db.select().from(s.workflowRuns).where(eq(s.workflowRuns.id, runId)).limit(1).all();
  if (!run) throw new Error(`No run with id ${runId}`);
  const from = input.from ?? new Date((run.startedAt?.getTime() ?? Date.now()) - 60000).toISOString();
  const to = input.to ?? new Date((run.endedAt?.getTime() ?? Date.now()) + 60000).toISOString();
  // Long runs begin with a bounded window; callers can move it forward.
  const boundedTo = !input.to && Date.parse(to) - Date.parse(from) > 7 * 86400000
    ? new Date(Date.parse(from) + 7 * 86400000).toISOString() : to;
  const pageInput = { ...input, from, to: boundedTo };
  const bounds = logBounds(pageInput);
  const runScope = { runId, label: `Run ${run.ordinal}`, state: run.state,
    startedAt: run.startedAt?.toISOString() ?? null, endedAt: run.endedAt?.toISOString() ?? null,
    nextWindowFrom: Date.parse(bounds.to) < (run.endedAt?.getTime() ?? Date.now()) + 60000 ? bounds.to : null };
  const config = options.config ?? loadRuntimeConfig();
  let note = "VICTORIALOGS_ENABLED is false.";
  if (config.logging.victoriaLogs.enabled) {
    try {
      const page = await queryLogPage(pageInput, { ...options, config, runId });
      // Empty filtered/later pages do not imply the full source is absent.
      if (page.count || input.offset || input.level || input.search || input.service || input.from || input.to)
        return { ...runScope, ...page };
      note = "Nothing in the log store for this run in this window.";
    } catch (error) {
      options.signal?.throwIfAborted();
      note = error instanceof Error && error.name === "TimeoutError" ? "VictoriaLogs query timed out." : "VictoriaLogs query failed or source unreachable.";
    }
  }
  const ordering = input.order === "asc" ? asc : desc;
  const rows = input.service && input.service !== "unknown" ? [] : db.select().from(s.runLogs).where(and(
    eq(s.runLogs.runId, runId), gte(s.runLogs.at, new Date(bounds.from)), lt(s.runLogs.at, new Date(bounds.to)),
    input.level ? eq(s.runLogs.level, input.level) : undefined,
    input.search ? sql`instr(${s.runLogs.text}, ${input.search}) > 0` : undefined,
  )).orderBy(ordering(s.runLogs.at), ordering(s.runLogs.seq)).offset(input.offset).limit(input.limit + 1).all();
  const truncated = rows.length > input.limit;
  return { ...runScope, source: "database" as const,
    scope: { ...bounds, runId, service: input.service ?? null, level: input.level ?? null, search: input.search ?? null },
    order: input.order, offset: input.offset, limit: input.limit,
    count: rows.slice(0, input.limit).length, truncated,
    nextOffset: truncated && input.offset + input.limit <= 100000 ? input.offset + input.limit : null,
    note: `${note} Database fallback contains runner bookkeeping only; internal agent/tool logs may be missing. Bounded window; reuse bounds and nextOffset or move the window forward.`,
    lines: rows.slice(0, input.limit).map(row => diagnosticLine({ _time: row.at.toISOString(), _msg: row.text, level: row.level, seq: row.seq, run_id: runId })) };
}
