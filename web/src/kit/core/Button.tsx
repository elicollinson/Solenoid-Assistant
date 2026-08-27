import { useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";

export type ButtonVariant = "affirm" | "quiet" | "bare" | "danger";
export type ButtonSize = "sm" | "md" | "touch";

const BASE: CSSProperties = {
  all: "unset",
  boxSizing: "border-box",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--sp-3)",
  whiteSpace: "nowrap",
  borderRadius: "var(--radius-control)",
  font: "var(--text-ui-sm)",
  transition: "background var(--dur) var(--ease), color var(--dur) var(--ease)",
};

/* Buttons are the agent's words, not labels: "Send it", "Read the draft",
   "Stop everything". Never more than one affirm-filled button in a view.
   Destructive buttons are outlined at rest and fill on hover. */
export function Button({
  variant = "quiet",
  size = "md",
  disabled,
  children,
  onClick,
  style,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  children?: ReactNode;
  /** The event is passed through: a button inside a clickable row has to be
   *  able to stop the row from also firing. */
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  style?: CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  const pad = size === "sm" ? "6px 11px" : size === "touch" ? "0 18px" : "8px 14px";
  const touch: CSSProperties | null =
    size === "touch" ? { minHeight: "var(--touch)", font: "500 14.5px/1.3 var(--font-ui)" } : null;

  const looks: Record<ButtonVariant, CSSProperties> = {
    affirm: { background: hover ? "var(--accent)" : "var(--affirm)", color: "var(--text-on-accent)" },
    quiet: {
      border: "1px solid var(--line-strong)",
      background: hover ? "var(--surface-hover)" : "transparent",
      color: "var(--text-2)",
    },
    bare: { color: hover ? "var(--text-1)" : "var(--text-3)" },
    danger: {
      border: "1px solid var(--danger)",
      background: hover ? "var(--danger)" : "transparent",
      color: hover ? "var(--text-on-accent)" : "var(--danger-text)",
      font: "var(--text-mono-control)",
      letterSpacing: "var(--tracking-control)",
      textTransform: "uppercase",
    },
  };

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...BASE,
        padding: pad,
        ...touch,
        ...looks[variant],
        ...(disabled ? { opacity: 0.45, cursor: "default" } : null),
        ...style,
      }}
    >
      {children}
    </button>
  );
}
