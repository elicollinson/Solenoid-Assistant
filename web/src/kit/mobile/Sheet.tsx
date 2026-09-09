import type { CSSProperties, ReactNode } from "react";
import { Button } from "../core/Button";
import { MonoLabel } from "../core/MonoLabel";

/* The phone's answer to the desktop detail aside. A solid plane over the lower
   half of the frame: 1px top rule, no scrim, no shadow, no transparency —
   nothing in this system floats except the ask button. */
export function Sheet({
  label,
  onClose,
  children,
  height = "62%",
  style,
}: {
  label?: ReactNode;
  onClose?: () => void;
  children?: ReactNode;
  height?: string | number;
  style?: CSSProperties;
}) {
  return (
    <section
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height,
        // The design's heights assume the 844px frame. In a browser on a real
        // phone the frame is whatever the viewport leaves, often under 700px,
        // and a 640px sheet then has its Close row above the top edge where
        // `overflow: hidden` clips it and nothing can dismiss it. So it is
        // capped to what is left under the app header, and scrolls inside.
        maxHeight: "calc(100% - var(--tabbar-total) - var(--safe-top) - 56px)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--surface-panel)",
        borderTop: "var(--border-strong)",
        borderTopLeftRadius: "var(--radius-frame)",
        borderTopRightRadius: "var(--radius-frame)",
        ...style,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--sp-5)",
          padding: "var(--sp-6) var(--gutter-phone)",
          borderBottom: "var(--border)",
        }}
      >
        {label ? <MonoLabel>{label}</MonoLabel> : <span />}
        <Button
          variant="bare"
          size="sm"
          onClick={onClose}
          style={{ padding: 0, minHeight: "var(--touch)", font: "var(--text-mono-control)", letterSpacing: "var(--tracking-control)", textTransform: "uppercase" }}
        >
          Close
        </Button>
      </header>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-7)",
          padding: "var(--sp-7) var(--gutter-phone) var(--sp-9)",
        }}
      >
        {children}
      </div>
    </section>
  );
}
