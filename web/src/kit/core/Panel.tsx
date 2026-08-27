import type { CSSProperties, ReactNode } from "react";
import type { Signal } from "../types";

export type PanelTone = "plain" | "alert" | "note" | "bare";

const TONES: Record<PanelTone, CSSProperties> = {
  plain: { background: "var(--surface-raised)", border: "var(--border)" },
  alert: { background: "var(--surface-alert)", border: "var(--border-alert)" },
  note: { background: "var(--surface-note)", border: "none" },
  bare: { background: "transparent", border: "none" },
};

/** The aside's card treatment, generalised. `edge` draws the 3px signal border
 *  that marks attention on a list item. */
export function Panel({
  tone = "plain",
  edge,
  children,
  style,
}: {
  tone?: PanelTone;
  edge?: Signal;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-4)",
        padding: "var(--sp-7)",
        borderRadius: "var(--radius-card)",
        ...TONES[tone],
        ...(edge ? { borderLeft: `3px solid var(--signal-${edge})` } : null),
        ...style,
      }}
    >
      {children}
    </div>
  );
}
