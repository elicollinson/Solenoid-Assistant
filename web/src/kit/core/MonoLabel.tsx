import type { CSSProperties, ReactNode } from "react";

export function MonoLabel({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <span
      style={{
        font: "var(--text-mono-label)",
        letterSpacing: "var(--tracking-label)",
        textTransform: "uppercase",
        color: "var(--text-4)",
        ...style,
      }}
    >
      {children}
    </span>
  );
}
