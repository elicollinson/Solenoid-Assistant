import type { CSSProperties } from "react";
import type { State } from "../types";

/* Status is a Bauhaus geometric mark, never a pictorial icon. There is no icon
   font in this system and adding one would read as foreign immediately. */
const SHAPES: Record<State, CSSProperties> = {
  attention: { clipPath: "polygon(50% 0,100% 100%,0 100%)", background: "var(--signal-amber)" },
  running: {
    borderRadius: "50%",
    border: "3px solid var(--signal-green)",
    borderRightColor: "var(--meter-track)",
    background: "transparent",
    boxSizing: "border-box",
  },
  done: { background: "var(--signal-info)" },
  failed: { clipPath: "polygon(50% 0,100% 50%,50% 100%,0 50%)", background: "var(--signal-rust)" },
  idle: { border: "1px solid var(--text-mark)", background: "transparent", boxSizing: "border-box" },
};

export function StatusMark({ state = "done", size = 13, style }: { state?: State; size?: number; style?: CSSProperties }) {
  return (
    <span aria-hidden="true" style={{ display: "block", flex: "0 0 auto", width: size, height: size, ...SHAPES[state], ...style }} />
  );
}
