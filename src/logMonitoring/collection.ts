import { createHash } from "node:crypto";
import { runRawQuery, type RawLog } from "../core/logging/query";
import { sanitize } from "./sanitize";

export interface Evidence {
  id: string;
  service: string;
  level: string;
  pattern: string;
  count: number;
  first: string;
  latest: string;
  samples: { at: string; message: string }[];
}
export type Query = (query: string, options: { limit: number; signal: AbortSignal }) => Promise<RawLog[]>;
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const range = (from: number, to: number) => `_time:[${new Date(from).toISOString()}, ${new Date(to).toISOString()})`;
function first(row: RawLog, keys: string[], fallback = ""): string {
  for (const key of keys) if (row[key] != null && String(row[key]).length) return String(row[key]);
  return fallback;
}
export function serviceOf(row: RawLog): string {
  return first(row, ["service", "service.name", "resource.service.name", "resource.attributes.service.name", "docker.compose.service", "com.docker.compose.service", "container_name", "container.name", "k8s.container.name", "app"], "unknown");
}
export function evidenceOf(row: RawLog): Omit<Evidence, "count" | "first" | "latest" | "samples"> & { at: string; message: string } {
  const service = sanitize(serviceOf(row));
  const severity = first(row, ["level", "log.level", "severity_text", "severityText", "severity"], "unknown").toLowerCase();
  const level = ({ warning: "warn", fatal: "error", critical: "error", err: "error" } as Record<string, string>)[severity] ?? severity;
  const message = sanitize([
    first(row, ["_msg", "message", "body", "log"]),
    first(row, ["error", "error.message", "exception.message"]),
    first(row, ["stack", "error.stack", "exception.stacktrace"]),
  ].filter(Boolean).join("\n"));
  const pattern = message.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>");
  return { id: digest(`${service}\n${level}\n${pattern}`), service, level: sanitize(level), pattern, at: first(row, ["_time", "timestamp"]), message };
}

/** No service/severity filter: info-level downstream symptoms matter too.
 * Split saturated time windows instead of skipping rows or starving quiet services.
 * A saturated millisecond or exceeded budget fails the scan without advancing it. */
export async function collect(from: number, to: number, options: {
  signal: AbortSignal; maxRows: number; maxGroups: number; expectedServices: string[]; query?: Query;
}) {
  const query = options.query ?? runRawQuery;
  const groups = new Map<string, Evidence>();
  const services: Record<string, number> = Object.create(null);
  let total = 0;
  let requests = 0;
  async function read(start: number, end: number): Promise<void> {
    options.signal.throwIfAborted();
    if (++requests > 1024) throw new Error("Log collection request budget exceeded; checkpoint unchanged");
    const rows = await query(range(start, end), { limit: 1001, signal: options.signal });
    if (rows.length >= 1001) {
      if (end - start <= 1) throw new Error("Log collection saturated at one millisecond; checkpoint unchanged");
      const mid = Math.floor((start + end) / 2);
      await read(start, mid);
      await read(mid, end);
      return;
    }
    for (const row of rows) {
      if (++total > options.maxRows) throw new Error("Log row budget exceeded; checkpoint unchanged");
      const e = evidenceOf(row);
      const at = Date.parse(e.at);
      if (!Number.isFinite(at) || at < start || at >= end) throw new Error("Invalid/out-of-window log timestamp; checkpoint unchanged");
      services[e.service] = (services[e.service] ?? 0) + 1;
      const existing = groups.get(e.id);
      if (existing) {
        existing.count++;
        if (e.at < existing.first) existing.first = e.at;
        if (e.at > existing.latest) existing.latest = e.at;
        if (existing.samples.length < 2) existing.samples.push({ at: e.at, message: e.message });
      } else {
        if (groups.size >= options.maxGroups) throw new Error("Log pattern budget exceeded; checkpoint unchanged");
        groups.set(e.id, { id: e.id, service: e.service, level: e.level, pattern: e.pattern, count: 1, first: e.at, latest: e.at, samples: [{ at: e.at, message: e.message }] });
      }
    }
  }
  await read(from, to);
  const gaps = options.expectedServices.filter(s => !(sanitize(s) in services)).map(s => `No logs observed for expected service: ${sanitize(s)}`);
  if (!total) gaps.push("No services observed; ingestion/collection cannot be verified.");
  if (services.unknown) gaps.push(`${services.unknown} records have no recognized service metadata.`);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), total, services, gaps,
    coverage: "Observed log shippers only; services without ingested logs are not discoverable from VictoriaLogs.",
    groups: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}
