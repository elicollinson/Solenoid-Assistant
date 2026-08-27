// The one way anything in this repo says something.
//
// Three destinations, one call. `log.info("swept 12 screenshots")` goes to:
//
//   • the console, pretty in development and JSON everywhere else, so `docker
//     compose logs` and a terminal both stay readable;
//   • the active span as a timestamped event, which is what puts a tool's own
//     output in the Phoenix span's Events tab — unchanged, and the reason this
//     file existed in the first place;
//   • VictoriaLogs, as a structured record carrying the standard fields, so
//     the same line is findable later by service, level, trace or run.
//
// The third of those is best-effort by construction: the record is pushed onto
// a bounded queue and the call returns. Nothing here awaits, and nothing here
// throws. See src/core/logging/sink.ts.
import { isSpanContextValid, trace } from "@opentelemetry/api";
import { loadRuntimeConfig, type LogLevelName, type RuntimeConfig } from "./config";
import { logContext } from "./logging/context";
import { passes, type LogLevel, type LogRecord, type LogValue } from "./logging/record";
import { VictoriaLogsSink } from "./logging/sink";

export type { LogContext } from "./logging/context";
export { enterLogContext, logContext, withLogContext } from "./logging/context";
export type { LogLevel, LogRecord } from "./logging/record";

/** Extra fields for one line. Flat, because these become queryable fields. */
export type LogAttributes = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(message: string, attrs?: LogAttributes): void;
  info(message: string, attrs?: LogAttributes): void;
  /** "This finished." The run log's own level, kept because the UI draws it
   *  green and `info` is not the same statement. */
  ok(message: string, attrs?: LogAttributes): void;
  warn(message: string, attrs?: LogAttributes): void;
  error(message: string, attrs?: LogAttributes): void;
  /** A logger with `component` bound, for a module that says a lot. */
  child(component: string, attrs?: LogAttributes): Logger;
}

interface LoggingState {
  level: LogLevelName;
  json: boolean;
  service: string;
  sink: VictoriaLogsSink | undefined;
}

let state: LoggingState | undefined;

/**
 * Name this process and pick up its logging settings.
 *
 * Optional: the first line logged configures the logger from the environment
 * if nobody has. Entrypoints call it anyway, because the `service` field is
 * the difference between "the app said this" and "the worker said this", and
 * only the entrypoint knows which one it is. `LOG_SERVICE` overrides it, which
 * is how one compose file runs the same image under two names.
 */
export function configureLogging(options: { service?: string; config?: RuntimeConfig } = {}): void {
  const config = options.config ?? loadRuntimeConfig();
  const { logging } = config;
  state?.sink?.close().catch(() => {});
  // The unit suite is not a service and has no collector to ship to. Without
  // this every `bun test` would open a connection to :9428 and hold a few
  // hundred records for a process that is about to exit; VICTORIALOGS_ENABLED
  // is still the switch for anyone who wants the opposite.
  const shipping = logging.victoriaLogs.enabled && process.env.NODE_ENV !== "test";
  state = {
    level: logging.level,
    json: logging.format === "json" || (logging.format === "auto" && !prettyByDefault()),
    service: logging.service ?? options.service ?? "solenoid-assistant",
    sink: shipping ? new VictoriaLogsSink(logging.victoriaLogs) : undefined,
  };
}

/** Everything queued, on its way. Awaited by the shutdown handlers. */
export async function flushLogs(): Promise<void> {
  await state?.sink?.flush().catch(() => {});
}

/** Final flush, then stop shipping. Idempotent. */
export async function shutdownLogging(): Promise<void> {
  await state?.sink?.close().catch(() => {});
  if (state) state.sink = undefined;
}

/** What is waiting to ship and what was dropped, for a health line or a test. */
export function loggingStats(): { queued: number; dropped: number } {
  return state?.sink?.stats() ?? { queued: 0, dropped: 0 };
}

/**
 * Put an already-formed record through the same pipeline.
 *
 * For records this process did not produce — the browser app posts its own to
 * `POST /api/logs`, and they belong in the same store, under their own
 * `service`, rather than in a second one nobody thinks to query.
 */
export function ingestLogRecord(record: LogRecord): void {
  const current = ensure();
  if (!passes(record.level, current.level)) return;
  current.sink?.push(record);
  writeConsole(current, record);
}

function ensure(): LoggingState {
  if (!state) configureLogging();
  return state!;
}

/** Pretty when a person is watching, JSON when a log collector is. */
function prettyByDefault(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return Boolean(process.stdout?.isTTY);
}

function emit(level: LogLevel, component: string | undefined, bound: LogAttributes | undefined, message: string, attrs?: LogAttributes): void {
  const current = ensure();

  // The span event goes out regardless of the console floor: a `debug` line
  // dropped from the terminal is still worth having on the span you are
  // reading in Phoenix, which is the same bargain as before this file grew.
  const span = trace.getActiveSpan();
  // Only a real span has ids worth writing down. With tracing switched off the
  // API hands out a non-recording span whose context is all zeroes, and a
  // `trace_id` of thirty-two noughts on every record is worse than no field.
  const context_ = span?.spanContext();
  const spanContext = context_ && isSpanContextValid(context_) ? context_ : undefined;
  span?.addEvent(message, { "log.severity": level, ...clean(bound), ...clean(attrs) });

  if (!passes(level, current.level)) return;

  const context = logContext();
  const record: LogRecord = {
    timestamp: new Date().toISOString(),
    level,
    service: context.service ?? current.service,
    component: component ?? context.component ?? "app",
    message,
    ...(spanContext ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {}),
    ...(context.request_id ? { request_id: context.request_id } : {}),
    ...(context.session_id ? { session_id: context.session_id } : {}),
    ...(context.run_id ? { run_id: context.run_id } : {}),
    ...(context.workflow ? { workflow: context.workflow } : {}),
    ...clean(bound),
    ...clean(attrs),
  };

  current.sink?.push(record);
  writeConsole(current, record);
}

/** Drop the empties, so `{ error: undefined }` does not become a field. */
function clean(attrs?: LogAttributes): Record<string, LogValue> {
  if (!attrs) return {};
  const out: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Which console method, given that `ok` is not one of them. */
function console_(level: LogLevel): "log" | "warn" | "error" {
  if (level === "error") return "error";
  if (level === "warn") return "warn";
  return "log";
}

const STANDARD = new Set([
  "timestamp", "level", "service", "component", "message",
  "trace_id", "span_id", "request_id", "session_id", "run_id", "workflow",
]);

/**
 * The development half, kept deliberately.
 *
 * JSON is what a collector wants and what nobody wants to read at 2am, so the
 * TTY gets the old shape back — the message, then the extras in braces — plus
 * the component and the short end of the trace id, which is what you actually
 * paste into Phoenix.
 */
function writeConsole(current: LoggingState, record: LogRecord): void {
  const method = console_(record.level);
  if (current.json) {
    console[method](JSON.stringify(record));
    return;
  }
  const extras = Object.entries(record)
    .filter(([key, value]) => !STANDARD.has(key) && value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  for (const key of ["request_id", "run_id"] as const) {
    if (record[key]) extras.push(`${key}=${record[key]}`);
  }
  if (record.trace_id) extras.push(`trace=${String(record.trace_id).slice(0, 8)}`);
  const tail = extras.length > 0 ? ` {${extras.join(", ")}}` : "";
  // `app` is the component a line gets for not having said which one it is, so
  // printing it tells you nothing — the terminal keeps the shape it had before
  // this file grew, and only a line that named itself gets a prefix.
  const from = record.component === "app" ? "" : `[${record.component}] `;
  console[method](`${from}${record.message}${tail}`);
}

function make(component?: string, bound?: LogAttributes): Logger {
  return {
    debug: (message, attrs) => emit("debug", component, bound, message, attrs),
    info: (message, attrs) => emit("info", component, bound, message, attrs),
    ok: (message, attrs) => emit("ok", component, bound, message, attrs),
    warn: (message, attrs) => emit("warn", component, bound, message, attrs),
    error: (message, attrs) => emit("error", component, bound, message, attrs),
    child: (childComponent, childAttrs) =>
      make(childComponent, { ...bound, ...childAttrs }),
  };
}

/** The default logger. `log.child("imessage")` for a module that says a lot. */
export const log: Logger = make();
