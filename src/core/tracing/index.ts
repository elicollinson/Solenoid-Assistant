// Public tracing surface. Everything the rest of the codebase (and future
// subclasses) needs is re-exported here so nothing outside src/core/tracing
// imports OpenTelemetry or OpenInference packages directly.
export { initTracing, shutdownTracing, tracingEnabled } from "./init";
export {
  withSpanKind,
  safeJson,
  inputMessageAttributes,
  outputMessageAttributes,
  llmRequestAttributes,
  SemanticConventions,
  SpanStatusCode,
} from "./spans";
export type { SpanKind, Attributes, Span } from "./spans";
export { tracedChat, traceProvider, TracedChatProvider } from "./tracedProvider";
// Session propagation affordance for later (multi-turn conversations):
// wrap a call in `context.with(setSession(context.active(), {sessionId}), ...)`.
export { setSession } from "@arizeai/openinference-core";
