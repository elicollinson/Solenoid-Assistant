// The browser half of the same log store.
//
// An error in the app used to live in a console nobody had open. This puts it
// next to everything else that happened at that moment, under `service:
// "solenoid-web"`, findable by the same `request_id` the server put on the
// response that caused it.
//
// The same rule as the server's: logging never gets in the way. Records go
// into a small in-memory queue, a batch is posted on an idle tick, `keepalive`
// carries the last one through a page unload, and every failure is swallowed
// — a log store that is down must not turn into a broken screen.
export type ClientLogLevel = "debug" | "info" | "ok" | "warn" | "error";

interface ClientLogEntry {
  timestamp: string;
  level: ClientLogLevel;
  message: string;
  component?: string;
  request_id?: string;
  session_id?: string;
  path?: string;
}

/** Bounded, and small: the browser is not a buffer for an offline collector. */
const QUEUE_LIMIT = 200;
const BATCH_DELAY_MS = 2_000;

const queue: ClientLogEntry[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

/** Say something, from the browser. Returns immediately and never throws. */
export function clientLog(level: ClientLogLevel, message: string, fields: Omit<ClientLogEntry, "timestamp" | "level" | "message"> = {}): void {
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[method](message, fields);

  queue.push({
    timestamp: new Date().toISOString(),
    level,
    message: message.slice(0, 4_000),
    path: location.pathname,
    ...fields,
  });
  if (queue.length > QUEUE_LIMIT) queue.splice(0, queue.length - QUEUE_LIMIT);
  if (!timer) timer = setTimeout(ship, BATCH_DELAY_MS);
}

function ship(keepalive = false): void {
  timer = undefined;
  const entries = queue.splice(0, queue.length);
  if (entries.length === 0) return;
  void fetch("/api/logs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries }),
    keepalive,
  }).catch(() => {
    // Dropped on purpose. Retrying from a page that may be closing buys
    // nothing, and the console still has every line.
  });
}

/**
 * Report what the app could not handle.
 *
 * Called once from the entrypoint. An uncaught error and a rejected promise
 * are the two things that leave the screen wrong with nothing written down;
 * the unload flush is what stops the last one of them being lost to the batch
 * timer.
 */
export function installClientLogging(): void {
  window.addEventListener("error", (event) => {
    clientLog("error", `Uncaught: ${event.message}`, { component: "window" });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
    clientLog("error", `Unhandled rejection: ${reason}`, { component: "window" });
  });
  // `pagehide` rather than `unload`: the latter is ignored on iOS and blocks
  // the back/forward cache everywhere else.
  window.addEventListener("pagehide", () => ship(true));
}
