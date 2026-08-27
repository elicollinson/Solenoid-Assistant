import { useState, type CSSProperties } from "react";
import type { StepState } from "../types";

export interface TraceNode {
  name: string;
  detail?: string | null;
  note?: string | null;
  duration?: string | null;
  state?: StepState;
  children?: readonly TraceNode[];
}

/* Non-status glyphs are single mono characters. There is no icon set here by
   design — a pictorial icon reads as foreign immediately. */
const MARK: Record<StepState, { glyph: string; color: string }> = {
  ok: { glyph: "·", color: "var(--text-4)" },
  running: { glyph: "▸", color: "var(--signal-green)" },
  failed: { glyph: "×", color: "var(--signal-rust)" },
  waiting: { glyph: "▪", color: "var(--signal-amber)" },
  skipped: { glyph: "–", color: "var(--text-4)" },
};

function Node({ node, depth, defaultOpen }: { node: TraceNode; depth: number; defaultOpen?: boolean }) {
  const kids = node.children ?? [];
  const [open, setOpen] = useState(defaultOpen !== false && depth < 2);
  const mark = MARK[node.state ?? "ok"];
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        onClick={kids.length ? () => setOpen((o) => !o) : undefined}
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "var(--sp-3)",
          padding: "5px 0 5px " + (depth * 22 + 4) + "px",
          borderRadius: "var(--radius-control)",
          cursor: kids.length ? "pointer" : "default",
          font: "var(--text-mono)",
          color: "var(--text-2)",
        }}
      >
        <span style={{ width: 10, color: kids.length ? "var(--accent)" : mark.color }}>
          {kids.length ? (open ? "▾" : "▸") : mark.glyph}
        </span>
        <span style={{ color: node.state === "failed" ? "var(--danger-text)" : "var(--text-1)" }}>{node.name}</span>
        {node.detail ? <span style={{ color: "var(--text-3)" }}>{node.detail}</span> : null}
        {node.note ? <span style={{ color: "var(--signal-amber)" }}>{node.note}</span> : null}
        {node.duration ? <span style={{ marginLeft: "auto", color: "var(--text-4)" }}>{node.duration}</span> : null}
      </div>
      {open && kids.length ? (
        <div style={{ borderLeft: "1px solid var(--line)", marginLeft: depth * 22 + 9 }}>
          {kids.map((k, i) => (
            <Node key={`${k.name}-${i}`} node={k} depth={depth + 1} defaultOpen={defaultOpen} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TraceTree({ nodes = [], defaultOpen, style }: { nodes?: readonly TraceNode[]; defaultOpen?: boolean; style?: CSSProperties }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--surface-sunken)",
        border: "var(--border)",
        borderRadius: "var(--radius-card)",
        padding: "var(--sp-5) var(--sp-7)",
        ...style,
      }}
    >
      {nodes.map((n, i) => (
        <Node key={`${n.name}-${i}`} node={n} depth={0} defaultOpen={defaultOpen} />
      ))}
    </div>
  );
}
