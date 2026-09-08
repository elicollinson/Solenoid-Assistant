import { useEffect, useState } from "react";

type Snapshot = {
  sources: Array<{
    kind: string;
    collected_at: string;
    coverage_from: string;
    coverage_to: string;
  }>;
  queue: Array<{ status: string; count: number }>;
};
export function SourceStatus() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch("/api/source-status", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error();
        setSnapshot(await response.json());
        setUnavailable(false);
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  if (!snapshot && !unavailable) return null;
  const pending =
    snapshot?.queue
      .filter((r) => ["pending", "processing", "failed"].includes(r.status))
      .reduce((n, r) => n + r.count, 0) ?? 0;
  return (
    <div
      role="status"
      style={{
        padding: "var(--sp-3) var(--sp-6)",
        font: "var(--text-small)",
        color: "var(--text-3)",
      }}
    >
      {unavailable
        ? "Data collection status is unavailable."
        : ["messages", "contacts", "photos"]
            .map((kind) => {
              const row = snapshot?.sources.find((s) => s.kind === kind);
              const age = row
                ? Date.now() - Date.parse(row.collected_at)
                : Infinity;
              return `${kind === "photos" ? "Screenshots" : kind[0]!.toUpperCase() + kind.slice(1)}: ${row ? `${new Date(row.collected_at).toLocaleString()}${age > 3600_000 ? " (stale)" : ""}` : "not collected"}`;
            })
            .join(" · ")}
      {pending > 0
        ? ` · ${pending} screenshot(s) awaiting classification`
        : null}
    </div>
  );
}
