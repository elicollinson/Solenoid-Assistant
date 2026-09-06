import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Button } from "../core/Button";
import { AskButton } from "./AskButton";

/**
 * The ask, in two states.
 *
 * Collapsed it is `AskButton`, one ink disc in the bottom-right gutter. Tapped,
 * it becomes a chat bar docked on the tab bar — the same composer the chat
 * screen carries, so sending from here and sending from there are visibly the
 * same act.
 *
 * It is not a route to Chat, and that distinction is the whole point of it
 * existing beside a Chat tab. The tab is where you go to read; this is where
 * you say something without leaving the screen you are reading. What follows a
 * send is the owner's business: in this app it starts a new conversation and
 * opens it, which is why the hint says so before you type a word.
 */
export function AskDock({
  onSend,
  placeholder = "Tell me what to do",
  hint = "Sending starts a new conversation.",
  style,
}: {
  onSend: (text: string) => void;
  placeholder?: string;
  hint?: string;
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLInputElement>(null);

  // Focus on open, so the keyboard is already up by the time the bar has
  // finished appearing. A dock you have to tap twice is a dock nobody uses.
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  const close = () => {
    setDraft("");
    setOpen(false);
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    close();
    onSend(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      send();
    }
    if (event.key === "Escape") close();
  };

  if (!open) return <AskButton onClick={() => setOpen(true)} style={style} />;

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        // Docked ON the tab bar rather than floating over the screen. Nothing
        // in this system floats except the disc it replaced.
        bottom: "var(--tabbar-total)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-3)",
        padding: "var(--sp-6) var(--gutter-phone)",
        borderTop: "var(--border)",
        background: "var(--surface-app)",
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-4)",
          minHeight: "var(--touch)",
          padding: "0 var(--sp-3) 0 var(--sp-5)",
          borderRadius: "var(--radius-card)",
          border: "1px solid var(--accent)",
          background: "var(--surface-raised)",
        }}
      >
        <input
          ref={field}
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          style={{
            all: "unset",
            flex: 1,
            minWidth: 0,
            // 16px. Below that Safari zooms the page on focus and never zooms
            // back, which leaves the tab bar off screen.
            font: "var(--text-phone-lede)",
            color: "var(--text-1)",
          }}
        />
        <Button
          variant="affirm"
          size="sm"
          onClick={send}
          style={{ opacity: draft.trim() ? 1 : 0.45, minHeight: 34 }}
        >
          Send
        </Button>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--sp-5)",
          font: "var(--text-mono)",
          color: "var(--text-4)",
        }}
      >
        <span>{hint}</span>
        <button
          type="button"
          onClick={close}
          style={{
            all: "unset",
            cursor: "pointer",
            font: "var(--text-mono-control)",
            letterSpacing: "var(--tracking-control)",
            textTransform: "uppercase",
            color: "var(--text-3)",
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
