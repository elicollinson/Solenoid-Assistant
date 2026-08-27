import type { CSSProperties, ReactNode } from "react";
import { StatusMark } from "../core/StatusMark";
import type { State } from "../types";

/* The phone is not the desktop feed at a smaller width. Cards give way to one
   hairline down the page with status marks sitting on it — no borders, no
   tinted fills. At most two entries are `prominent`: the things waiting on you. */

export function TimelineFeed({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: "var(--timeline-gap)", ...style }}>
      <span aria-hidden="true" style={{ position: "absolute", left: 5, top: 0, bottom: 0, width: 1, background: "var(--line-hair)" }} />
      {children}
    </div>
  );
}

export function TimelineItem({
  state = "done",
  title,
  time,
  children,
  actions,
  prominent,
  style,
}: {
  state?: State;
  title: ReactNode;
  time?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  prominent?: boolean;
  style?: CSSProperties;
}) {
  const flat = state === "done" || state === "failed";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "12px 1fr", gap: 18, ...style }}>
      <StatusMark
        state={state}
        size={flat ? 11 : 12}
        style={{
          position: "relative",
          // The ring is hollow, so it needs the page plane behind it to sit on
          // the timeline rule rather than have the rule run through it.
          ...(state === "running" ? { background: "var(--surface-app)" } : null),
          marginTop: flat ? 6 : 5,
        }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: prominent ? "var(--sp-3)" : "var(--sp-2)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-4)" }}>
          <span
            style={{
              font: prominent ? "600 17px/1.3 var(--font-ui)" : "500 16px/1.3 var(--font-ui)",
              letterSpacing: prominent ? "-0.01em" : "normal",
              color: "var(--text-1)",
              opacity: prominent ? 1 : 0.92,
            }}
          >
            {title}
          </span>
          {time ? <span style={{ marginLeft: "auto", font: "var(--text-mono-meta)", color: "var(--text-4)" }}>{time}</span> : null}
        </div>
        {children ? (
          <p
            style={{
              margin: 0,
              font: prominent ? "400 14.5px/1.6 var(--font-ui)" : "400 14px/1.55 var(--font-ui)",
              color: prominent ? "var(--text-2)" : "var(--text-3)",
              textWrap: "pretty",
            }}
          >
            {children}
          </p>
        ) : null}
        {actions ? <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-3)", paddingTop: 2 }}>{actions}</div> : null}
      </div>
    </div>
  );
}
