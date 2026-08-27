import type { CSSProperties, ReactNode } from "react";
import { MonoLabel } from "./MonoLabel";

/** An uppercase mono label followed by a hairline that runs to the edge of the
 *  column — the plotted-drawing motif that separates every section. */
export function SectionRule({ label, style }: { label: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-5)", padding: "var(--sp-8) 0 var(--sp-5)", ...style }}>
      <MonoLabel>{label}</MonoLabel>
      <span style={{ flex: 1, height: 1, background: "var(--line-hair)" }} />
    </div>
  );
}
