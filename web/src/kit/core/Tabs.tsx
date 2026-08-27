import type { CSSProperties } from "react";

export type TabItem = string | { label: string; count?: number | null };

export function Tabs({
  items = [],
  value,
  onChange,
  style,
}: {
  items?: readonly TabItem[];
  value?: string;
  onChange?: (label: string) => void;
  style?: CSSProperties;
}) {
  return (
    <div style={{ display: "flex", gap: "var(--sp-9)", borderBottom: "var(--border)", ...style }}>
      {items.map((it) => {
        const label = typeof it === "string" ? it : it.label;
        const count = typeof it === "string" ? null : it.count;
        const on = value === label;
        return (
          <button
            key={label}
            type="button"
            onClick={() => onChange?.(label)}
            style={{
              all: "unset",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "var(--sp-3)",
              padding: "0 0 var(--sp-4)",
              marginBottom: -1,
              borderBottom: `2px solid ${on ? "var(--accent)" : "transparent"}`,
              font: "var(--text-mono-control)",
              letterSpacing: "var(--tracking-control)",
              textTransform: "uppercase",
              color: on ? "var(--text-1)" : "var(--text-3)",
              transition: "color var(--dur) var(--ease)",
            }}
          >
            {label}
            {count != null ? <span style={{ font: "var(--text-mono-meta)", color: "var(--text-4)" }}>{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
