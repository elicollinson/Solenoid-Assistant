import { z } from "zod";
import { pushoverStatus, type PushoverConfig } from "./config";

const text = (max: number) => z.string().refine(value => value.trim().length > 0 && value.isWellFormed() && [...value].length <= max,
  `Must be nonblank, well-formed text of at most ${max} Unicode characters`);
export const messageSchema = z.strictObject({
  message: text(1024), title: text(250).optional(),
  url: text(512).refine(value => {
    try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
  }, "Must be an absolute HTTP(S) URL without credentials").optional(),
  urlTitle: text(100).optional(),
}).refine(value => !value.urlTitle || !!value.url, "urlTitle requires url");
export type PushMessage = z.infer<typeof messageSchema>;
export interface PushResult {
  status: "accepted" | "not_sent" | "rejected" | "unknown";
  code: string;
  providerRequestId: string | null;
  httpStatus?: number;
  quota?: { limit: number | null; remaining: number | null; resetAt: number | null };
}
export interface PushClient { send(message: PushMessage, signal?: AbortSignal): Promise<PushResult> }
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("deadline"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
const numberHeader = (headers: Headers, name: string) => {
  const raw = headers.get(name);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
};

/** No transport retries, redirects, raw error causes, or secret-bearing diagnostics. */
export class PushoverClient implements PushClient {
  constructor(private config: PushoverConfig, private fetchFn: typeof fetch = fetch) {}

  async send(input: PushMessage, signal?: AbortSignal): Promise<PushResult> {
    if (!pushoverStatus(this.config).ready) return { status: "not_sent", code: "not_configured", providerRequestId: null };
    if (signal?.aborted) return { status: "not_sent", code: "cancelled_before_send", providerRequestId: null };
    const parsed = messageSchema.safeParse(input);
    if (!parsed.success) return { status: "not_sent", code: "invalid_message", providerRequestId: null };
    const { message, title, url, urlTitle } = parsed.data;
    const deadline = AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), ...(signal ? [signal] : [])]);
    try {
      const response = await abortable(this.fetchFn("https://api.pushover.net/1/messages.json", {
        method: "POST", redirect: "error", signal: deadline,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: this.config.appToken, user: this.config.userKey, message,
          title: title ?? "Solenoid Assistant", ...(url ? { url } : {}), ...(urlTitle ? { url_title: urlTitle } : {}) }),
      }), deadline);
      const quota = { limit: numberHeader(response.headers, "x-limit-app-limit"), remaining: numberHeader(response.headers, "x-limit-app-remaining"),
        resetAt: numberHeader(response.headers, "x-limit-app-reset") };
      // Bound parsing too; error responses are never passed to the model or logger.
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await abortable(reader.read(), deadline);
            if (done) break;
            bytes += value.length;
            if (bytes > 16384) { void reader.cancel().catch(() => {}); throw new Error("oversized"); }
            chunks.push(value);
          }
        } finally {
          if (deadline.aborted) void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      let body: Record<string, unknown> = {};
      try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (value && typeof value === "object" && !Array.isArray(value)) body = value as Record<string, unknown>;
      } catch { /* A definite 4xx is still a refusal, even without valid JSON. */ }
      const providerRequestId = typeof body.request === "string" && /^[A-Za-z0-9-]{1,80}$/.test(body.request) &&
        !body.request.includes(this.config.appToken) && !body.request.includes(this.config.userKey) ? body.request : null;
      const common = { providerRequestId, httpStatus: response.status, quota };
      if (response.status === 200 && body.status === 1) return { ...common, status: "accepted", code: "queued" };
      if (response.status >= 400 && response.status < 500) return { ...common, status: "rejected", code: response.status === 429 ? "quota_exceeded" : "request_rejected" };
      if (response.status === 200 && body.status === 0) return { ...common, status: "rejected", code: "request_rejected" };
      return { ...common, status: "unknown", code: "acceptance_unverified" };
    } catch {
      return { status: "unknown", code: "acceptance_unverified", providerRequestId: null };
    }
  }
}
