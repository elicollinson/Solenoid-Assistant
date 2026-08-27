import type { CSSProperties } from "react";

/** Progress as two flat bars, not a rounded track. */
export function Meter({ value = 0, total = 1, style }: { value?: number; total?: number; style?: CSSProperties }) {
  const done = Math.max(0, Math.min(value, total));
  return (
    <div style={{ display: "flex", gap: "var(--sp-1)", height: 5, ...style }}>
      <span style={{ flex: done || 0.0001, background: "var(--meter-fill)", borderRadius: 1 }} />
      <span style={{ flex: total - done || 0.0001, background: "var(--meter-track)", borderRadius: 1 }} />
    </div>
  );
}
