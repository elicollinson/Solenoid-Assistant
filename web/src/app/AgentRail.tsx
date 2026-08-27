import { Button, MonoLabel, RailGroup, RailItem } from "../kit";
import type { HomePayload } from "./api";

/* The left rail: destinations, the agent's own state, the kill switch, and the
   theme toggle. Counts arrive already counted — a stored "Activity 12" is wrong
   by morning, so the server derives them. */
export function AgentRail({
  rail,
  selected,
  onSelect,
  theme,
  onToggleTheme,
}: {
  rail: HomePayload["rail"];
  selected: string;
  onSelect: (view: string) => void;
  theme: "paper" | "dusk";
  onToggleTheme: () => void;
}) {
  return (
    <aside
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-8)",
        padding: "var(--sp-8) 18px",
        borderRight: "var(--border)",
        background: "var(--surface-rail)",
        overflow: "auto",
      }}
    >
      {/* No logo by design: the name is set beside two geometric marks. */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)" }}>
        <span style={{ width: 13, height: 13, borderRadius: "50%", background: "var(--signal-rust)" }} />
        <span style={{ width: 13, height: 13, background: "var(--accent)" }} />
        <span style={{ font: "600 16px/1.2 var(--font-ui)", letterSpacing: "-0.01em", color: "var(--text-1)" }}>Solenoid</span>
      </div>

      {rail.groups.map((group) => (
        <RailGroup key={group.label} label={group.label}>
          {group.items.map((item) => (
            <RailItem
              key={item.label}
              label={item.label}
              count={item.count}
              dot={item.dot}
              selected={selected === item.label}
              onClick={() => onSelect(item.label)}
            />
          ))}
        </RailGroup>
      ))}

      <div
        style={{
          marginTop: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-4)",
          padding: "var(--sp-5)",
          border: "var(--border-strong)",
          borderRadius: "var(--radius-card)",
          background: "var(--surface-panel)",
        }}
      >
        <MonoLabel style={{ letterSpacing: "0.14em" }}>Agent state</MonoLabel>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", font: "var(--text-body-sm)", color: "var(--text-2)" }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: rail.agent.running ? "var(--signal-green)" : "var(--text-mark)",
            }}
          />
          {rail.agent.line}
        </div>
        <Button variant="danger" size="sm" style={{ width: "100%" }}>
          Stop everything
        </Button>
        <Button
          variant="bare"
          size="sm"
          onClick={onToggleTheme}
          style={{ width: "100%", font: "var(--text-mono-control)", letterSpacing: "var(--tracking-control)", textTransform: "uppercase" }}
        >
          {theme === "paper" ? "Dusk" : "Paper"}
        </Button>
      </div>
    </aside>
  );
}
