import type { CSSProperties, ReactNode } from "react";

export type BadgeTone = "running" | "attention" | "neutral";

const TONES: Record<BadgeTone, CSSProperties> = {
  running: { background: "var(--badge-run-bg)", color: "var(--badge-run-fg)" },
  attention: { background: "var(--surface-note)", color: "var(--text-1)" },
  neutral: { background: "var(--surface-hover)", color: "var(--text-3)" },
};

export function Badge({ tone = "neutral", children, style }: { tone?: BadgeTone; children?: ReactNode; style?: CSSProperties }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 6px",
        borderRadius: "var(--radius-control)",
        font: "var(--text-mono-label)",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        ...TONES[tone],
        ...style,
      }}
    >
      {children}
    </span>
  );
}
