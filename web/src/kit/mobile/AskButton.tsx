import { useState, type CSSProperties } from "react";

/** Asking the agent something, on a phone: a 56px ink disc in the bottom-right
 *  gutter above the tab bar, carrying the command caret as a 3×18px bar. One
 *  per screen, and the only thing in the system allowed to float. */
export function AskButton({ onClick, label = "Ask Solenoid", style }: { onClick?: () => void; label?: string; style?: CSSProperties }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        position: "absolute",
        right: "var(--gutter-phone)",
        bottom: "var(--ask-bottom)",
        width: "var(--fab)",
        height: "var(--fab)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-round)",
        background: hover ? "var(--text-1)" : "oklch(0.31 0.03 200)",
        boxShadow: "var(--shadow-float)",
        transition: "background var(--dur) var(--ease)",
        ...style,
      }}
    >
      <span aria-hidden="true" style={{ display: "block", width: 3, height: 18, background: "var(--accent-teal)" }} />
    </button>
  );
}
