// Reading logs back out of VictoriaLogs.
//
// The write path is fire-and-forget; this is the other half, and it is what
// makes the store the source of the Logs tab in the UI rather than a place
// lines go to be forgotten. One query, `/select/logsql/query`, answering in
// ndjson — a JSON object per line, `_time` and `_msg` being what the ingested
// `timestamp` and `message` fields became.
import { loadRuntimeConfig, type RuntimeConfig } from "../config";
import type { LogLevel } from "./record";

/** One line, in the shape the workflow wire format already speaks. */
export interface StoredLogLine {
  /** ISO 8601, as stored. The caller formats it for whatever is drawing it. */
  at: string;
  level: LogLevel;
  message: string;
  service: string;
  component: string;
  trace_id?: string;
  span_id?: string;
  request_id?: string;
  session_id?: string;
  /** The runner's own line number, on the lines that have one. Only a
   *  tiebreaker: two lines written in the same millisecond have the same
   *  `_time`, and "Run 1 started" has to come before its arguments. */
  seq?: number;
}

const LEVELS = new Set<LogLevel>(["debug", "info", "ok", "warn", "error"]);

/** Thrown when the store cannot answer. Callers fall back rather than fail. */
export class LogQueryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LogQueryError";
  }
}

export function logQueryEnabled(config: RuntimeConfig = loadRuntimeConfig()): boolean {
  return config.logging.victoriaLogs.enabled;
}

/**
 * Every line this run produced, oldest first.
 *
 * Not just the runner's own bookkeeping: anything logged anywhere while the
 * run was in flight carries `run_id` from the ambient context, so a tool's
 * complaint five frames down lands in the same list as "Run 3 started".
 *
 * `_time:` is bounded rather than open-ended because an unbounded LogsQL query
 * scans the whole retention window; a run has a start, and a day either side
 * of it is generous.
 */
export async function queryRunLogs(
  runId: string,
  options: { limit?: number; since?: Date; config?: RuntimeConfig; signal?: AbortSignal } = {},
): Promise<StoredLogLine[]> {
  const config = options.config ?? loadRuntimeConfig();
  const window = options.since ? isoDay(options.since) : "30d";
  const lines = await runQuery(
    `run_id:=${quote(runId)} _time:${window}`,
    { limit: options.limit ?? 5_000, config, ...(options.signal ? { signal: options.signal } : {}) },
  );
  return lines.sort((a, b) => a.at.localeCompare(b.at) || (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * Run a LogsQL query and parse the ndjson answer.
 *
 * Exported for anything else that wants the store — a health check, a script
 * — and kept deliberately thin: LogsQL is the query language, and wrapping it
 * in a builder would only hide what the README tells you to type by hand.
 */
export async function runQuery(
  query: string,
  options: { limit?: number; config?: RuntimeConfig; signal?: AbortSignal } = {},
): Promise<StoredLogLine[]> {
  const config = options.config ?? loadRuntimeConfig();
  const { endpoint, timeoutMs } = config.logging.victoriaLogs;

  const body = new URLSearchParams({ query });
  if (options.limit) body.set("limit", String(options.limit));

  let response: Response;
  try {
    response = await fetch(`${endpoint}/select/logsql/query`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: options.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new LogQueryError(`VictoriaLogs unreachable at ${endpoint}`, { cause: error });
  }
  if (!response.ok) {
    const said = await response.text().catch(() => "");
    throw new LogQueryError(`VictoriaLogs answered ${response.status}${said ? `: ${said.slice(0, 200)}` : ""}`);
  }

  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parse)
    .filter((line): line is StoredLogLine => line != null);
}

function parse(line: string): StoredLogLine | null {
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const level = String(row.level ?? "info") as LogLevel;
  return {
    at: String(row._time ?? row.timestamp ?? ""),
    level: LEVELS.has(level) ? level : "info",
    message: String(row._msg ?? row.message ?? ""),
    service: String(row.service ?? "unknown"),
    component: String(row.component ?? "app"),
    ...pick(row, "trace_id"),
    ...pick(row, "span_id"),
    ...pick(row, "request_id"),
    ...pick(row, "session_id"),
    // Fields come back as strings, whatever went in.
    ...(row.seq != null && Number.isFinite(Number(row.seq)) ? { seq: Number(row.seq) } : {}),
  };
}

function pick(row: Record<string, unknown>, field: string): Record<string, string> {
  const value = row[field];
  return typeof value === "string" && value.length > 0 ? { [field]: value } : {};
}

/** LogsQL string literal. Backslashes and quotes are the only two that bite. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A day either side of an instant, as a LogsQL `[from, to]` range. */
function isoDay(at: Date): string {
  const from = new Date(at.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  const to = new Date(at.getTime() + 24 * 60 * 60 * 1_000).toISOString();
  return `[${from}, ${to}]`;
}
