import { Button, MonoLabel, Panel } from "../kit";
import type { HomeAction, HomePayload } from "./api";

const STANCE_TO_VARIANT: Record<HomeAction["stance"], "affirm" | "quiet" | "bare" | "danger"> = {
  affirm: "affirm",
  neutral: "quiet",
  quiet: "quiet",
  bare: "bare",
  danger: "danger",
};

/* The right aside: what is waiting on you, what is next, and the one standing
   suggestion worth reading. Deleted entirely on a phone — its "waiting on you"
   items are the top of the feed anyway. */
export function AgentAside({ aside, onInvoke }: { aside: HomePayload["aside"]; onInvoke: (action: HomeAction) => void }) {
  const { waiting, nextUp, worthALook } = aside;

  return (
    <aside
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-8)",
        padding: "var(--sp-9) var(--sp-8)",
        borderLeft: "var(--border)",
        background: "var(--surface-panel)",
        overflow: "auto",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
        <MonoLabel>Waiting on you</MonoLabel>
        {waiting.length === 0 ? (
          <span style={{ font: "var(--text-body-sm)", color: "var(--text-3)" }}>Nothing right now.</span>
        ) : (
          waiting.map((w) => (
            <Panel key={w.id} tone="note" edge="amber" style={{ padding: "11px 12px" }}>
              <span style={{ font: "var(--text-body-sm)", color: "var(--text-1)" }}>{w.title}</span>
            </Panel>
          ))
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
        <MonoLabel>Next up</MonoLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", font: "var(--text-body-sm)", color: "var(--text-2)" }}>
          {nextUp.length === 0 ? (
            <span style={{ color: "var(--text-3)" }}>The rest of the day is clear.</span>
          ) : (
            nextUp.map((n) => (
              <div key={n.time + n.what} style={{ display: "flex", gap: "var(--sp-4)" }}>
                <span style={{ font: "var(--text-mono-meta)", color: "var(--text-4)", minWidth: 44 }}>{n.time}</span>
                {n.what}
              </div>
            ))
          )}
        </div>
      </div>

      {worthALook ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>Worth a look</MonoLabel>
          <p style={{ margin: 0, font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>{worthALook.body}</p>
          <div style={{ display: "flex", gap: "var(--sp-3)" }}>
            {worthALook.actions.map((a) => (
              <Button key={a.id} variant={STANCE_TO_VARIANT[a.stance]} size="sm" onClick={() => onInvoke(a)}>
                {a.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
