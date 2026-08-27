import { useState, type CSSProperties, type ReactNode } from "react";
import { StatusMark } from "../core/StatusMark";
import type { CalendarKind, State } from "../types";

/* The phone's calendar body. The desktop time grid is a plotted canvas; at
   390px there is no room to plot, so the day becomes a list on hairline rules:
   a mono time gutter, the state mark, and the thing itself. No cards, no
   tinted planes. Kind is carried by typeface (mono for my runs, prose for
   yours) and by the left rule (amber for what needs you, dashed for a slot I
   am only holding). Rows bleed to the edge of the phone, so Agenda pulls
   itself out of the gutter its parent supplies. */

export function Agenda({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return <div style={{ display: "flex", flexDirection: "column", margin: "0 calc(-1 * var(--gutter-phone))", ...style }}>{children}</div>;
}

const SIGNAL: Partial<Record<State, string>> = {
  attention: "var(--signal-amber)",
  running: "var(--signal-green)",
  done: "var(--signal-info)",
  failed: "var(--signal-rust)",
};

export function AgendaRow({
  kind = "event",
  state,
  start,
  end,
  title,
  meta,
  selected,
  onClick,
  style,
}: {
  kind?: CalendarKind;
  state?: State;
  start: string;
  end?: string;
  title: string;
  meta?: string;
  selected?: boolean;
  onClick?: () => void;
  style?: CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  const signal = state ? SIGNAL[state] : undefined;
  /* Same washes the desktop CalendarEvent uses, laid flat across the row. */
  const wash = (pct: number) =>
    signal ? `color-mix(in oklab, ${signal} ${pct}%, var(--surface-app))` : pct > 14 ? "var(--surface-hover)" : "var(--surface-raised)";
  const planes: Record<CalendarKind, string> = {
    event: selected ? "var(--surface-selected)" : hover ? "var(--surface-hover)" : "var(--surface-raised)",
    run: selected ? wash(30) : hover ? wash(20) : wash(11),
    reminder: selected ? wash(26) : hover ? wash(17) : wash(9),
    hold: selected ? "var(--surface-selected)" : hover ? "var(--surface-hover)" : "transparent",
  };
  const rule =
    kind === "hold"
      ? "3px dashed var(--line-strong)"
      : state === "attention"
        ? "3px solid var(--signal-amber)"
        : state === "failed"
          ? "3px solid var(--signal-rust)"
          : "3px solid transparent";

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid",
        gridTemplateColumns: "50px 1fr",
        gap: "var(--sp-5)",
        alignItems: "start",
        minHeight: "var(--touch)",
        padding: "13px var(--gutter-phone)",
        cursor: "pointer",
        borderTop: "1px solid var(--line-hair)",
        background: planes[kind],
        transition: "background var(--dur) var(--ease)",
        ...style,
      }}
    >
      <span style={{ display: "flex", flexDirection: "column", gap: 2, paddingTop: 2 }}>
        <span style={{ font: "var(--text-mono)", color: "var(--text-2)" }}>{start}</span>
        {end ? <span style={{ font: "var(--text-mono-meta)", color: "var(--text-4)" }}>{end}</span> : null}
      </span>

      <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, paddingLeft: "var(--sp-5)", borderLeft: rule }}>
        <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", minWidth: 0 }}>
          {state ? <StatusMark state={state} size={11} /> : null}
          <span
            style={{
              font: kind === "run" ? "400 13.5px/1.35 var(--font-mono)" : "500 15.5px/1.35 var(--font-ui)",
              color: kind === "hold" ? "var(--text-3)" : "var(--text-1)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </span>
        </span>
        {meta ? <span style={{ font: "var(--text-mono-meta)", color: "var(--text-4)" }}>{meta}</span> : null}
      </span>
    </div>
  );
}

/** Where the day has got to. One accent hairline across the list, labelled. */
export function AgendaNow({ time }: { time: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)", padding: "0 var(--gutter-phone)" }}>
      <span style={{ font: "var(--text-mono-meta)", color: "var(--accent)", minWidth: 50 }}>{time}</span>
      <span style={{ flex: 1, height: 1, background: "var(--accent)" }} />
    </div>
  );
}
