// The fields a log line inherits from wherever it happens to be.
//
// A tool five frames deep inside a workflow run does not know the run id, and
// the signature that would carry it there would have to be threaded through
// every function between — the same problem the trace-aware logger already
// solves for spans, solved the same way: ambient, async-aware, and invisible
// at the call site. `log.info("done")` inside a run comes out carrying
// `run_id`, `service` and `component` without saying so.
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Everything ambient about a log line. Standardised names, snake_case,
 * because these are the field names VictoriaLogs is queried by — `level:error
 * request_id:"01J..."` is typed by a person, and camelCase there is a trap.
 */
export interface LogContext {
  /** Which half of the app: "solenoid-server", "solenoid-worker", ... */
  service?: string;
  /** The part inside it: "http", "workflow", "imessage", "notion-mcp". */
  component?: string;
  /** One inbound HTTP request. */
  request_id?: string;
  /** One conversation, across requests. */
  session_id?: string;
  /** One workflow run — what the Logs tab in the UI reads back by. */
  run_id?: string;
  /** The workflow's slug, so a run's lines can be found without its id. */
  workflow?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** The context here, now. Empty outside any scope. */
export function logContext(): LogContext {
  return storage.getStore() ?? {};
}

/**
 * Run `fn` with these fields added to whatever is already ambient.
 *
 * Inner scopes win, and `undefined` values are dropped rather than allowed to
 * blank out an outer field — `withLogContext({ session_id: undefined }, ...)`
 * inside a session must not lose the session.
 */
export function withLogContext<T>(fields: LogContext, fn: () => T): T {
  return storage.run(merged(fields), fn);
}

/**
 * Add these fields to the *current* async execution rather than to a callback.
 *
 * For the one caller that cannot wrap: an HTTP framework hands you a request
 * hook and then calls the handler itself, so there is nothing to put inside a
 * `.run()`. Everything else should use `withLogContext`.
 */
export function enterLogContext(fields: LogContext): void {
  storage.enterWith(merged(fields));
}

function merged(fields: LogContext): LogContext {
  const next: LogContext = { ...logContext() };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== "") next[key as keyof LogContext] = value;
  }
  return next;
}
