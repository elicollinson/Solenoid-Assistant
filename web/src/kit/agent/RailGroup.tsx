import type { CSSProperties, ReactNode } from "react";
import { MonoLabel } from "../core/MonoLabel";

export function RailGroup({ label, children, style }: { label: ReactNode; children?: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", ...style }}>
      <MonoLabel style={{ padding: "0 8px 4px" }}>{label}</MonoLabel>
      {children}
    </div>
  );
}
