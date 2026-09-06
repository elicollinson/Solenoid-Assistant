import { useState, type CSSProperties } from "react";
import { StatusMark } from "../core/StatusMark";
import type { State } from "../types";

/**
 * One conversation in the list — the desktop's aside, the phone's own screen.
 *
 * A status mark, what you called it, where it got to, and when. The mark is the
 * whole reason this is a list rather than a menu: three conversations of which
 * one is waiting on you is a different thing to look at than three that are
 * done, and the amber says which before you read a word.
 *
 * The title is your own first six words. An untitled row is a conversation
 * nobody has had yet, and it says so rather than inventing a name for it.
 */
export function ConversationRow({
  title,
  lede,
  when,
  state,
  selected = false,
  touch = false,
  onOpen,
  style,
}: {
  title: string | null;
  lede: string;
  when: string;
  state: State;
  selected?: boolean;
  /** The phone: 44px of row, and a press state rather than a hover one. */
  touch?: boolean;
  onOpen: () => void;
  style?: CSSProperties;
}) {
  const [lit, setLit] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
      // Pointer events rather than mouse: the phone wants a press state, the
      // desktop a hover one, and these are the two that fire on both.
      onPointerEnter={() => !touch && setLit(true)}
      onPointerLeave={() => setLit(false)}
      onPointerDown={() => touch && setLit(true)}
      onPointerUp={() => touch && setLit(false)}
      style={{
        cursor: "pointer",
        display: "grid",
        gridTemplateColumns: touch ? "18px 1fr" : "13px 1fr",
        gap: "var(--sp-5)",
        alignItems: "start",
        minHeight: touch ? "var(--touch)" : undefined,
        padding: touch ? "var(--sp-6) 0" : "var(--sp-6) var(--sp-8)",
        borderTop: touch ? "var(--border)" : undefined,
        borderBottom: touch ? undefined : "var(--border)",
        background: selected
          ? "var(--surface-selected)"
          : lit
            ? "var(--surface-hover)"
            : "transparent",
        transition: "background var(--dur) var(--ease)",
        ...style,
      }}
    >
      <StatusMark state={state} size={11} style={{ marginTop: touch ? 5 : 4 }} />
      <span style={{ display: "flex", flexDirection: "column", gap: touch ? 4 : "var(--sp-1)", minWidth: 0 }}>
        <span
          style={{
            font: touch ? "var(--text-phone-head)" : "var(--text-ui-sm)",
            fontWeight: touch ? undefined : 500,
            color: title ? "var(--text-1)" : "var(--text-3)",
            textWrap: "pretty",
          }}
        >
          {title ?? "New conversation"}
        </span>
        <span
          style={{
            font: touch ? "var(--text-phone-body)" : "var(--text-body-sm)",
            color: "var(--text-3)",
            textWrap: "pretty",
          }}
        >
          {lede}
        </span>
        <span style={{ font: "var(--text-mono-meta)", color: "var(--text-4)" }}>{when}</span>
      </span>
    </div>
  );
}
