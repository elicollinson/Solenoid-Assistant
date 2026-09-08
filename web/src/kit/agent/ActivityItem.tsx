import type { CSSProperties, ReactNode } from "react";
import { Badge } from "../core/Badge";
import { StatusMark } from "../core/StatusMark";
import type { State } from "../types";

/* One entry in the desktop feed: a 26px mark gutter plus content. An item that
   needs you is framed in the alert plane; everything else is either a plain
   raised card or (framed={false}) a bare row in the flow.

   The `minWidth: 0` on the content column and on the title is not cosmetic. A
   grid and a flex item both default to a min-content floor, so one entry whose
   title has nothing to break on — a serialised tool result, say — sets the
   floor for the whole feed, and the frame's `1fr` middle column cannot shrink
   under it. What that looks like is not a wide title: it is the aside and the
   filter chips silently clipped out of a frame that is `overflow: hidden`. A
   title is prose either way, so it wraps rather than pushing. */
export function ActivityItem({
  state = "done",
  title,
  badge,
  time,
  children,
  footer,
  framed,
  style,
}: {
  state?: State;
  title: ReactNode;
  badge?: ReactNode;
  time?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  framed?: boolean;
  style?: CSSProperties;
}) {
  const frame: CSSProperties | null =
    framed === false
      ? null
      : {
          padding: "var(--sp-7)",
          borderRadius: "var(--radius-card)",
          background: state === "attention" ? "var(--surface-alert)" : "var(--surface-raised)",
          border: state === "attention" ? "var(--border-alert)" : "var(--border)",
        };

  return (
    <article
      style={{
        display: "grid",
        gridTemplateColumns: "26px 1fr",
        gap: "var(--sp-6)",
        padding: "var(--sp-6) var(--sp-7)",
        ...frame,
        ...style,
      }}
    >
      <StatusMark state={state} size={state === "attention" || state === "running" ? 14 : 13} style={{ marginTop: 3 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-4)", minWidth: 0 }}>
          <span style={{ font: "var(--text-title)", color: "var(--text-1)", minWidth: 0, overflowWrap: "anywhere" }}>{title}</span>
          {badge ? <Badge tone={state === "running" ? "running" : "neutral"}>{badge}</Badge> : null}
          {time ? (
            <span style={{ marginLeft: "auto", flexShrink: 0, font: "var(--text-mono-meta)", color: "var(--text-4)" }}>{time}</span>
          ) : null}
        </div>
        {typeof children === "string" ? (
          <p style={{ margin: 0, font: "var(--text-body)", color: "var(--text-2)", textWrap: "pretty", maxWidth: "var(--measure)" }}>
            {children}
          </p>
        ) : (
          children
        )}
        {footer ? <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", paddingTop: 2 }}>{footer}</div> : null}
      </div>
    </article>
  );
}
