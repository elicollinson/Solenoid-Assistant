import { useState, type CSSProperties } from "react";

/* Seven days across the top of the phone calendar. The week grid does not
   survive 390px, so the week becomes a strip and the day becomes the page. */

export interface DayStripDay {
  key: string;
  label: string;
  date: string | number;
  today?: boolean;
  count?: number;
}

export function DayStrip({
  days = [],
  selected,
  onSelect,
  style,
}: {
  days?: readonly DayStripDay[];
  selected?: string;
  onSelect?: (key: string) => void;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${days.length || 1}, 1fr)`,
        borderTop: "var(--border)",
        borderBottom: "var(--border)",
        background: "var(--surface-panel)",
        ...style,
      }}
    >
      {days.map(({ key, ...day }) => (
        <DayStripCell key={key} {...day} selected={key === selected} onClick={() => onSelect?.(key)} />
      ))}
    </div>
  );
}

export function DayStripCell({
  label,
  date,
  today,
  count,
  selected,
  onClick,
}: Omit<DayStripDay, "key"> & { selected?: boolean; onClick?: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        minHeight: "var(--touch)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
        padding: "9px 0",
        background: selected ? "var(--surface-selected)" : hover ? "var(--surface-hover)" : "transparent",
        borderBottom: "2px solid " + (selected ? "var(--accent)" : "transparent"),
        transition: "background var(--dur) var(--ease)",
      }}
    >
      <span style={{ font: "var(--text-mono-label)", letterSpacing: "var(--tracking-label)", textTransform: "uppercase", color: selected ? "var(--text-2)" : "var(--text-4)" }}>
        {label}
      </span>
      <span style={{ font: today ? "600 16px/1.2 var(--font-ui)" : "400 16px/1.2 var(--font-ui)", color: selected || today ? "var(--text-1)" : "var(--text-3)" }}>
        {date}
      </span>
      <span style={{ font: "var(--text-mono-meta)", fontSize: 9.5, color: "var(--text-4)" }}>{count ? count : "·"}</span>
    </button>
  );
}
