// The one shape every log line has, everywhere in the repo.
import type { LogLevelName } from "../config";

/** The levels a log line can carry. `ok` is the run log's "this finished" —
 *  it is not a threshold level, so it sorts with `info` when filtering. */
export type LogLevel = LogLevelName | "ok";

export type LogValue = string | number | boolean | null;

/**
 * One structured record.
 *
 * The nine standard fields are spelled out rather than left to a bag, because
 * they are the ones LogsQL queries and the UI's Logs tab are written against.
 * Anything else a call site passes rides alongside them, flattened — nested
 * objects are queryable in VictoriaLogs, but only awkwardly.
 */
export interface LogRecord {
  /** RFC3339 with milliseconds. VictoriaLogs' `_time_field`. */
  timestamp: string;
  level: LogLevel;
  service: string;
  component: string;
  /** VictoriaLogs' `_msg_field`. */
  message: string;
  trace_id?: string;
  span_id?: string;
  request_id?: string;
  session_id?: string;
  run_id?: string;
  workflow?: string;
  [field: string]: LogValue | undefined;
}

const THRESHOLD: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  ok: 20,
  warn: 30,
  error: 40,
};

/** Whether a record at `level` clears the configured floor. */
export function passes(level: LogLevel, floor: LogLevelName): boolean {
  return THRESHOLD[level] >= THRESHOLD[floor];
}
