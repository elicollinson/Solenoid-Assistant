import { useState, type CSSProperties, type ReactNode } from "react";

/** A filter control. UPPERCASE lives only in mono, and only on controls. */
export function Chip({
  children,
  selected,
  onClick,
  style,
}: {
  children?: ReactNode;
  selected?: boolean;
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
      style={{
        all: "unset",
        cursor: "pointer",
        whiteSpace: "nowrap",
        padding: "6px 11px",
        borderRadius: "var(--radius-control)",
        font: "var(--text-mono-control)",
        letterSpacing: "var(--tracking-control)",
        textTransform: "uppercase",
        transition: "background var(--dur) var(--ease)",
        ...(selected
          ? { background: "var(--accent)", color: "var(--text-on-accent)" }
          : {
              border: "1px solid var(--line-strong)",
              background: hover ? "var(--surface-hover)" : "transparent",
              color: "var(--text-3)",
            }),
        ...style,
      }}
    >
      {children}
    </button>
  );
}
