// Request identity, and the ambient fields every log line inside a request
// inherits from it.
//
// Two ids, both optional on the way in and both echoed on the way out:
//
//   x-request-id  one HTTP request. Minted here when the caller does not
//                 supply one, and returned on the response so the id in the
//                 browser's network tab is the id to type into the log store.
//   x-session-id  one conversation across requests. Only the caller can know
//                 this, so it is read and never invented.
//
// `enterLogContext` rather than `withLogContext` because there is nothing to
// wrap: Elysia calls the handler itself, and the hook only gets to run before
// it. Everything downstream of this point — routes, agents, tools, the sink —
// picks the fields up from the async context without being handed them.
import { Elysia } from "elysia";
import { enterLogContext, log } from "../core/logger";

/** Requests that would otherwise write a line per poll and drown the store. */
const QUIET = new Set(["/health", "/favicon.ico"]);

export const requestContext = new Elysia({ name: "http.requestContext" })
  .onRequest(({ request, set }) => {
    const requestId = header(request, "x-request-id") ?? crypto.randomUUID();
    enterLogContext({
      component: "http",
      request_id: requestId,
      ...(header(request, "x-session-id") ? { session_id: header(request, "x-session-id")! } : {}),
    });
    set.headers["x-request-id"] = requestId;
  })
  .onAfterResponse(({ request, set, path }) => {
    if (QUIET.has(path)) return;
    const status = typeof set.status === "number" ? set.status : 200;
    // `warn` at 4xx and `error` at 5xx, so `level:error` in the log store is a
    // list of things that actually went wrong rather than every 404 for a
    // favicon.
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    log[level](`${request.method} ${path} → ${status}`, {
      http_method: request.method,
      http_path: path,
      http_status: status,
    });
  })
  .as("global");

function header(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim();
  // Bounded: these become log fields, and an unbounded header would be an
  // unbounded field on every record the request produces.
  return value && value.length > 0 && value.length <= 128 ? value : undefined;
}
