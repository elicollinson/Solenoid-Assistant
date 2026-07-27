// Derived trust and lifecycle signals (§5.3, §5.4, §5.5).
//
// The spec is emphatic that these are *derived*, never stored: a trust tier is
// read off `verified`, staleness is a date comparison. Deriving them here means
// the read tools can hand an agent the answer instead of the raw fields, and
// no code path can be tempted to persist a stale verdict.

export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

export const TRUST_ORDER: TrustTier[] = ["unverified", "machine-confirmed", "human-reviewed"];

export type Status = "draft" | "stable" | "deprecated";

export interface VerificationEvent {
  by: string;
  at?: string;
}

/** Consumers MUST treat a bare `verified` mapping as a one-element list (§5.2). */
export function verificationEvents(frontmatter: Record<string, unknown>): VerificationEvent[] {
  const raw = frontmatter.verified;
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const events: VerificationEvent[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const by = (entry as Record<string, unknown>).by;
    const at = (entry as Record<string, unknown>).at;
    if (typeof by !== "string" || by === "") continue;
    events.push({ by, at: typeof at === "string" ? at : undefined });
  }
  return events;
}

export function trustTier(frontmatter: Record<string, unknown>): TrustTier {
  const events = verificationEvents(frontmatter);
  if (events.length === 0) return "unverified";
  return events.some((e) => e.by.startsWith("human:")) ? "human-reviewed" : "machine-confirmed";
}

export function meetsTrust(frontmatter: Record<string, unknown>, min: TrustTier): boolean {
  return TRUST_ORDER.indexOf(trustTier(frontmatter)) >= TRUST_ORDER.indexOf(min);
}

/** Most recent verification timestamp, or undefined when never verified (§5.2). */
export function lastVerifiedAt(frontmatter: Record<string, unknown>): string | undefined {
  const stamps = verificationEvents(frontmatter)
    .map((e) => e.at)
    .filter((at): at is string => !!at)
    .sort();
  return stamps[stamps.length - 1];
}

/** Absent `status` means `stable` (§5.4). */
export function statusOf(frontmatter: Record<string, unknown>): Status {
  const raw = frontmatter.status;
  return raw === "draft" || raw === "deprecated" ? raw : "stable";
}

/** A concept is stale when `today >= stale_after` (§5.5). */
export function isStale(frontmatter: Record<string, unknown>, now: Date): boolean {
  const raw = frontmatter.stale_after;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  return isoDate(now) >= raw;
}

/** `YYYY-MM-DD` in UTC — the same basis `stale_after` dates are written on. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Second-resolution ISO 8601, as the spec writes timestamps. Milliseconds are noise here. */
export function isoDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
