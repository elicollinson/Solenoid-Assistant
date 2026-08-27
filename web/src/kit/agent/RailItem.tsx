import { useState, type CSSProperties } from "react";
import { StatusMark } from "../core/StatusMark";
import type { Signal } from "../types";

/** A rail destination. 7px square — filled with accent when selected, 1px
 *  outline when not. */
export function RailItem({
  label,
  selected,
  count,
  dot,
  onClick,
  style,
}: {
  label: string;
  selected?: boolean;
  count?: number | null;
  dot?: Signal | null;
  onClick?: () => void;
  style?: CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-current={selected ? "page" : undefined}
      style={{
        all: "unset",
        boxSizing: "border-box",
        width: "100%",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-3)",
        padding: "7px 8px",
        borderRadius: "var(--radius-card)",
        font: selected ? "var(--text-ui)" : "var(--text-ui-sm)",
        color: selected ? "var(--text-1)" : "var(--text-3)",
        background: selected ? "var(--surface-selected)" : hover ? "var(--surface-hover)" : "transparent",
        transition: "background var(--dur) var(--ease)",
        ...style,
      }}
    >
      {selected ? <StatusMark state="done" size={7} style={{ background: "var(--accent)" }} /> : <StatusMark state="idle" size={7} />}
      {label}
      {count != null ? <span style={{ marginLeft: "auto", font: "var(--text-mono-meta)", color: "var(--text-4)" }}>{count}</span> : null}
      {dot ? (
        <span
          style={{
            marginLeft: count != null ? "var(--sp-3)" : "auto",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: `var(--signal-${dot})`,
          }}
        />
      ) : null}
    </button>
  );
}
