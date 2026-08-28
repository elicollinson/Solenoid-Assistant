import type { CSSProperties } from "react";
import { Button } from "../core/Button";
import { MonoLabel } from "../core/MonoLabel";
import { StatusMark } from "../core/StatusMark";

export interface ApprovalChoice {
  id: string;
  label: string;
  stance: "affirm" | "neutral" | "quiet" | "danger" | "bare";
}

/** `stance` is what the agent meant; `variant` is what the kit draws. Neutral
 *  has no filled treatment, so it reads as the quiet option it is. */
const VARIANT = {
  affirm: "affirm",
  neutral: "quiet",
  quiet: "quiet",
  danger: "danger",
  bare: "bare",
} as const;

/**
 * One standardised shape for every approval the agent asks for in a chat.
 *
 * Four parts, and the third is the one that is easy to leave out and shouldn't
 * be. What it wants to do; why it is asking at all; **what it has not done
 * while it waits**; and its own words on the buttons. A person deciding whether
 * to allow something needs to know what is currently true if they say nothing,
 * and "Nothing has been written. I stopped before the call." is that.
 *
 * Two states, not five. It is waiting on you, or it is settled — and settled
 * keeps its place in the transcript and prints what followed, because the turn
 * after it ("Done, it's set") answers a question the page would otherwise no
 * longer be showing.
 *
 * The facts are a responsive grid rather than rows: at 390px a label/value pair
 * per line runs the bubble down the screen, and these are three or four short
 * things that read as a group.
 */
export function ApprovalBubble({
  reference,
  title,
  why,
  hold,
  facts = [],
  choices = [],
  settled,
  busy = false,
  touch = false,
  onChoose,
  style,
}: {
  /** The short id you could read out: `ap/0824-2`. */
  reference?: string;
  title: string;
  /** Why it is asking, as opposed to what it is about to do. */
  why?: string | null;
  /** What it has NOT done while waiting. */
  hold?: string | null;
  /** `[label, value]` — the call, and what it was called with. */
  facts?: ReadonlyArray<readonly [string, string]>;
  choices?: readonly ApprovalChoice[];
  /** What followed, once it was answered. Non-null means the buttons are gone. */
  settled?: string | null;
  /** Answered in this tab, waiting on the server. */
  busy?: boolean;
  /** The phone: 44px targets, and the buttons stack rather than sharing a row —
   *  two buttons side by side at 390px are two half-buttons. */
  touch?: boolean;
  onChoose?: (actionId: string) => void;
  style?: CSSProperties;
}) {
  const pending = !settled;
  const body = touch ? "var(--text-phone-body)" : "var(--text-body-sm)";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-5)",
        maxWidth: touch ? "none" : "62ch",
        padding: touch ? "var(--sp-6)" : "var(--sp-7)",
        borderRadius: "var(--radius-card)",
        border: pending ? "var(--border-alert)" : "var(--border)",
        background: pending ? "var(--surface-alert)" : "var(--surface-raised)",
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)" }}>
        <StatusMark state={pending ? "attention" : "done"} size={11} />
        <MonoLabel style={{ color: pending ? "var(--text-2)" : "var(--text-4)" }}>
          {pending ? "Needs you" : "Settled"}
        </MonoLabel>
        {reference ? (
          <span style={{ marginLeft: "auto", font: "var(--text-mono-meta)", color: "var(--text-4)" }}>
            {reference}
          </span>
        ) : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
        <span
          style={{
            font: touch ? "var(--text-phone-head)" : "var(--text-title)",
            letterSpacing: "var(--tracking-title)",
            color: "var(--text-1)",
            textWrap: "pretty",
          }}
        >
          {title}
        </span>
        {why ? (
          <p style={{ margin: 0, font: body, color: "var(--text-2)", textWrap: "pretty" }}>{why}</p>
        ) : null}
      </div>

      {facts.length ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
            gap: "var(--sp-4) var(--sp-7)",
            paddingTop: "var(--sp-5)",
            borderTop: "1px solid var(--line-hair)",
          }}
        >
          {facts.map(([label, value]) => (
            <span key={label} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", minWidth: 0 }}>
              <MonoLabel>{label}</MonoLabel>
              <span style={{ font: "var(--text-mono)", color: "var(--text-2)", overflowWrap: "anywhere" }}>
                {value}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      {hold ? <span style={{ font: "var(--text-mono)", color: "var(--text-3)" }}>{hold}</span> : null}

      {pending ? (
        <div
          style={{
            display: "flex",
            flexDirection: touch ? "column" : "row",
            flexWrap: "wrap",
            gap: "var(--sp-3)",
          }}
        >
          {choices.map((choice) => (
            <Button
              key={choice.id}
              variant={VARIANT[choice.stance]}
              size={touch ? "touch" : "md"}
              disabled={busy}
              onClick={() => onChoose?.(choice.id)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      ) : (
        <span style={{ font: "var(--text-mono)", color: "var(--text-3)", textWrap: "pretty" }}>{settled}</span>
      )}
    </div>
  );
}
