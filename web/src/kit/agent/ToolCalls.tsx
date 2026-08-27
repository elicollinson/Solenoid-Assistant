import { useState, type CSSProperties } from "react";

export interface ToolCall {
  name: string;
  arg?: string | null;
  duration?: string | null;
}

/** Machine facts stay in mono and stay literal:
 *  `memory.read okf:contact/ferris · 0.4s`. */
export function ToolCalls({
  calls = [],
  summary,
  defaultOpen = false,
  style,
}: {
  calls?: readonly ToolCall[];
  summary?: string | null;
  defaultOpen?: boolean;
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const line = summary || `${calls.length} tool call${calls.length === 1 ? "" : "s"}`;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-1)",
        padding: "var(--sp-3) var(--sp-4)",
        borderRadius: "var(--radius-control)",
        background: "var(--surface-sunken)",
        font: "var(--text-mono)",
        color: "var(--text-3)",
        ...style,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: "var(--sp-3)", font: "inherit", color: "inherit" }}
      >
        <span style={{ color: "var(--accent)" }}>{open ? "▾" : "▸"}</span>
        {line}
      </button>
      {open
        ? calls.map((c, i) => (
            <div key={`${c.name}-${i}`} style={{ paddingLeft: 18 }}>
              {c.name}
              {c.arg ? " " + c.arg : ""}
              {c.duration ? <span style={{ color: "var(--text-4)" }}>{" · " + c.duration}</span> : null}
            </div>
          ))
        : null}
    </div>
  );
}
