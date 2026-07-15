// Trace-aware logger: prints to the console AND attaches the line as a
// timestamped event on the active span (the TOOL span during tool.execute,
// the AGENT span during the loop, ...). Tools just import `log` instead of
// using console.log and their output shows up in the Phoenix span's Events
// tab — no signature changes, works at any depth across sync/async calls.
import { trace } from "@opentelemetry/api";

type Level = "debug" | "info" | "warn" | "error";
type LogAttributes = Record<string, string | number | boolean>;

function emit(level: Level, message: string, attrs?: LogAttributes): void {
  console[level === "debug" ? "log" : level](message);
  trace.getActiveSpan()?.addEvent(message, { "log.severity": level, ...attrs });
}

export const log = {
  debug: (message: string, attrs?: LogAttributes) => emit("debug", message, attrs),
  info: (message: string, attrs?: LogAttributes) => emit("info", message, attrs),
  warn: (message: string, attrs?: LogAttributes) => emit("warn", message, attrs),
  error: (message: string, attrs?: LogAttributes) => emit("error", message, attrs),
};
