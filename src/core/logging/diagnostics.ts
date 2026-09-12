import { z } from "zod";
import { loadRuntimeConfig, type RuntimeConfig } from "../config";
import { runRawQuery, type RawLog } from "./query";
import { sanitize } from "../../logMonitoring/sanitize";
import { serviceOf } from "../../logMonitoring/collection";

export const logPageSchema = z.object({
  from: z.iso.datetime({ offset: true }).optional().describe("Inclusive ISO time; defaults to one hour before to."),
  to: z.iso.datetime({ offset: true }).optional().describe("Exclusive ISO time; defaults to now. Reuse returned bounds for subsequent pages."),
  service: z.string().min(1).max(128).optional(),
  level: z.enum(["debug", "info", "ok", "warn", "error"]).optional(),
  search: z.string().min(1).max(200).optional().describe("Literal message phrase, not executable LogsQL."),
  offset: z.number().int().min(0).max(100000).default(0),
  limit: z.number().int().min(1).max(500).default(100),
  order: z.enum(["asc", "desc"]).default("asc"),
});
export type LogPageInput = z.infer<typeof logPageSchema>;
export const quoteLog = (s: string) => JSON.stringify(s);
export function logBounds(input: Pick<LogPageInput, "from" | "to">) {
  const to = input.to ? Date.parse(input.to) : Date.now();
  const from = input.from ? Date.parse(input.from) : to - 3600000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 7 * 86400000)
    throw new Error("Log range must be increasing and no longer than seven days; use successive windows for longer runs.");
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export function diagnosticLine(row: RawLog) {
  const original = String(row._msg ?? row.message ?? "");
  // Tool invocation arguments may contain arbitrary user data. Keep the call's
  // identity even when the whole argument payload must be withheld.
  const tool = original.match(/^\s*\[tool\] ([A-Za-z0-9_]+)\(/)?.[1];
  const invocation = original.startsWith("Invocation: ");
  const text = invocation ? "Invocation: [private arguments and guidance redacted]" : tool ? `[tool] ${tool}([arguments redacted])` : sanitize(original);
  const metadata: Record<string, string | number | boolean> = {};
  for (const key of ["component", "workflow", "trace_id", "span_id", "request_id", "session_id", "run_id", "tool", "toolName", "status", "durationMs", "seq", "error", "error.message", "stack"]) {
    const value = row[key];
    if (typeof value === "number" || typeof value === "boolean") metadata[key] = value;
    else if (typeof value === "string") metadata[key] = sanitize(value);
  }
  return { at: String(row._time ?? row.timestamp ?? ""), level: sanitize(String(row.level ?? "info")),
    service: sanitize(serviceOf(row)), text, ...metadata, ...(tool ? { tool, event: "invocation" } : {}),
    redacted: text !== original };
}

export async function queryLogPage(input: LogPageInput, options: {
  runId?: string; signal?: AbortSignal; config?: RuntimeConfig;
} = {}) {
  const config = options.config ?? loadRuntimeConfig();
  const bounds = logBounds(input);
  const filters = [`_time:[${bounds.from}, ${bounds.to})`];
  if (options.runId) filters.push(`run_id:=${quoteLog(options.runId)}`);
  if (input.service) filters.push(`service:=${quoteLog(input.service)}`);
  if (input.level) filters.push(`level:=${quoteLog(input.level)}`);
  if (input.search) filters.push(`_msg:${quoteLog(input.search)}`);
  const query = `${filters.join(" ")} | sort by (_time ${input.order}, seq ${input.order}, _stream_id, _msg) offset ${input.offset} limit ${input.limit + 1}`;
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(config.logging.victoriaLogs.timeoutMs)]);
  signal.throwIfAborted();
  let rows: RawLog[];
  try {
    rows = await runRawQuery(query, { limit: input.limit + 1, signal, config });
  } catch (error) {
    signal.throwIfAborted();
    throw new Error("VictoriaLogs query failed or source unreachable; no complete result available", { cause: error });
  }
  signal.throwIfAborted();
  for (const row of rows) {
    const at = Date.parse(String(row._time ?? row.timestamp ?? ""));
    if (!Number.isFinite(at) || at < Date.parse(bounds.from) || at >= Date.parse(bounds.to))
      throw new Error("VictoriaLogs returned an invalid or out-of-window timestamp; no complete result available");
    if (options.runId && row.run_id != null && row.run_id !== options.runId)
      throw new Error("VictoriaLogs returned a different run identity; no complete result available");
  }
  const truncated = rows.length > input.limit;
  return { source: "victorialogs" as const, scope: { ...bounds, runId: options.runId ?? null, service: input.service ?? null, level: input.level ?? null, search: input.search ?? null },
    order: input.order, offset: input.offset, limit: input.limit, count: Math.min(rows.length, input.limit), truncated,
    nextOffset: truncated && input.offset + input.limit <= 100000 ? input.offset + input.limit : null,
    note: "Sanitized stored records only; private arguments and arbitrary payload fields are omitted. Reuse bounds/filters/order with nextOffset, or narrow the time range. Late ingestion can shift pages; this is not an immutable snapshot.",
    lines: rows.slice(0, input.limit).map(diagnosticLine) };
}
