import { useState, type CSSProperties } from "react";
import { StatusMark } from "../core/StatusMark";

export interface TabBarEntry {
  label: string;
  selected?: boolean;
}

/** The rail's destinations, flattened for the phone. Marks grow 7px → 9px and
 *  the selected one fills with accent. */
export function TabBar({
  items = [],
  onSelect,
  style,
}: {
  items?: readonly TabBarEntry[];
  onSelect?: (item: TabBarEntry, index: number) => void;
  style?: CSSProperties;
}) {
  return (
    <nav
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${items.length || 1}, 1fr)`,
        alignItems: "center",
        borderTop: "var(--border)",
        background: "var(--surface-panel)",
        padding: "var(--sp-4) var(--sp-3) var(--safe-bottom)",
        ...style,
      }}
    >
      {items.map((it, i) => (
        <TabBarItem key={it.label} {...it} onClick={() => onSelect?.(it, i)} />
      ))}
    </nav>
  );
}

export function TabBarItem({ label, selected, onClick }: TabBarEntry & { onClick?: () => void }) {
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
        cursor: "pointer",
        minHeight: "var(--touch)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--sp-3)",
        font: "var(--text-mono-label)",
        fontSize: "9.5px",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: selected || hover ? "var(--text-1)" : "var(--text-3)",
        transition: "color var(--dur) var(--ease)",
      }}
    >
      {selected ? <StatusMark state="done" size={9} style={{ background: "var(--accent)" }} /> : <StatusMark state="idle" size={9} />}
      {label}
    </button>
  );
}
