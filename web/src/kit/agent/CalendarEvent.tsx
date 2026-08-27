import { useState, type CSSProperties } from "react";
import { StatusMark } from "../core/StatusMark";
import type { CalendarKind, State } from "../types";

/* Four kinds, told apart by plane and typeface rather than by icon:
   event    — filled plane, 1px rule, prose title (a person's commitment)
   run      — tinted plane, 3px signal rule on the left, mono title (machine)
   reminder — no plane, one hairline, prose title (a point in time)
   hold     — dashed outline, nothing filled (offered, not agreed) */

const SIGNAL: Partial<Record<State, string>> = {
  attention: "var(--signal-amber)",
  running: "var(--signal-green)",
  done: "var(--signal-info)",
  failed: "var(--signal-rust)",
};

export function CalendarEvent({
  kind = "event",
  state,
  title,
  meta,
  selected,
  tall = true,
  onClick,
  style,
}: {
  kind?: CalendarKind;
  state?: State;
  title: string;
  meta?: string | null;
  selected?: boolean;
  tall?: boolean;
  onClick?: () => void;
  style?: CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  const signal = state ? SIGNAL[state] : undefined;
  const rule = signal ?? "var(--line-strong)";
  const wash = (pct: number) =>
    signal ? `color-mix(in oklab, ${signal} ${pct}%, var(--surface-panel))` : pct > 14 ? "var(--surface-hover)" : "var(--surface-panel)";

  const looks: Record<CalendarKind, CSSProperties> = {
    event: {
      background: selected ? "var(--surface-selected)" : hover ? "var(--surface-hover)" : "var(--surface-raised)",
      border: "1px solid " + (selected ? "var(--accent)" : "var(--line-strong)"),
      borderRadius: "var(--radius-card)",
    },
    run: {
      background: selected ? wash(34) : hover ? wash(24) : wash(13),
      borderLeft: "3px solid " + rule,
      borderRadius: "var(--radius-control)",
    },
    reminder: {
      background: selected ? wash(30) : hover ? wash(20) : wash(10),
      borderTop: "2px solid " + rule,
    },
    hold: {
      background: selected ? "var(--surface-selected)" : hover ? "var(--surface-hover)" : "transparent",
      border: "1px dashed var(--line-strong)",
      borderRadius: "var(--radius-card)",
    },
  };

  const mono = kind === "run";

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        boxSizing: "border-box",
        height: "100%",
        overflow: "hidden",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: kind === "reminder" ? "3px 6px 0" : "5px 7px",
        transition: "background var(--dur) var(--ease), border-color var(--dur) var(--ease)",
        ...looks[kind],
        ...style,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", minWidth: 0 }}>
        {state ? <StatusMark state={state} size={9} /> : null}
        <span
          style={{
            font: mono ? "var(--text-mono)" : "var(--text-ui-sm)",
            color: kind === "hold" ? "var(--text-3)" : "var(--text-1)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </span>
      </span>
      {meta && tall ? (
        <span style={{ font: "var(--text-mono-meta)", color: "var(--text-4)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {meta}
        </span>
      ) : null}
    </div>
  );
}
