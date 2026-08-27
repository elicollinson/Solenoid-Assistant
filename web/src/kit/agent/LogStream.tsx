import type { CSSProperties } from "react";
import type { LogLevel } from "../types";

export interface LogLine {
  t: string;
  level?: LogLevel;
  text: string;
  /** Who said it — "workflow", "http", "imessage". Drawn dim before the text
   *  and omitted entirely when a stream's lines all come from one place. */
  tag?: string;
}

const LEVELS: Record<LogLevel, string> = {
  info: "var(--text-3)",
  ok: "var(--signal-green)",
  warn: "var(--signal-amber)",
  error: "var(--signal-rust)",
};

export function LogStream({ lines = [], style }: { lines?: readonly LogLine[]; style?: CSSProperties }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        background: "var(--surface-sunken)",
        border: "var(--border)",
        borderRadius: "var(--radius-card)",
        padding: "var(--sp-5) var(--sp-7)",
        font: "var(--text-mono)",
        overflow: "auto",
        ...style,
      }}
    >
      {lines.map((l, i) => (
        <div key={i} style={{ display: "flex", gap: "var(--sp-5)", whiteSpace: "pre-wrap" }}>
          <span style={{ color: "var(--text-4)", flex: "0 0 auto" }}>{l.t}</span>
          <span style={{ color: LEVELS[l.level ?? "info"], flex: "0 0 46px", textTransform: "uppercase" }}>{l.level ?? "info"}</span>
          {l.tag ? <span style={{ color: "var(--text-4)", flex: "0 0 auto" }}>{l.tag}</span> : null}
          <span style={{ color: l.level === "error" ? "var(--danger-text)" : "var(--text-2)" }}>{l.text}</span>
        </div>
      ))}
    </div>
  );
}
