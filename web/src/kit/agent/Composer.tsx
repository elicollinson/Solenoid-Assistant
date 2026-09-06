import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Button } from "../core/Button";

/**
 * Where you type.
 *
 * A textarea that grows to what you have written and then scrolls, rather than
 * a single line: the things people ask an assistant are frequently two
 * sentences, and a one-line field makes you write as if you were searching.
 *
 * Enter sends and shift-enter breaks the line, which is the convention every
 * chat has trained; the hint says so once, quietly, rather than in a tooltip
 * nobody opens.
 *
 * `waiting` is the state that matters and it is not "loading". The agent has
 * stopped on a question above this box, and typing more at it would be talking
 * over the thing it is waiting for — so the field says what it is waiting on
 * and takes nothing until the gate is answered.
 */
export function Composer({
  onSend,
  busy = false,
  waiting = false,
  placeholder = "Ask Solenoid",
  size = "md",
  style,
}: {
  onSend: (text: string) => void;
  /** A turn is running. You can still type the next thing; it just cannot go. */
  busy?: boolean;
  /** A turn is stopped on an approval. Nothing may be said until it is settled. */
  waiting?: boolean;
  placeholder?: string;
  /** "touch" gives the phone its 44px targets and 16px text — anything smaller
   *  and iOS zooms the whole page on focus. */
  size?: "md" | "touch";
  style?: CSSProperties;
}) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  // Grow to fit. Reset to auto first or the box can only ever get taller.
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [text]);

  const blocked = busy || waiting;
  const send = () => {
    const said = text.trim();
    if (!said || blocked) return;
    onSend(said);
    setText("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    send();
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
        padding: "var(--sp-4) 0 0",
        borderTop: "var(--border-strong)",
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap: "var(--sp-4)" }}>
        <textarea
          ref={field}
          rows={1}
          value={text}
          disabled={waiting}
          placeholder={waiting ? "Answer above first" : placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          style={{
            flex: 1,
            minWidth: 0,
            resize: "none",
            boxSizing: "border-box",
            padding: size === "touch" ? "var(--sp-4) var(--sp-5)" : "var(--sp-3) var(--sp-4)",
            borderRadius: "var(--radius-control)",
            border: "var(--border)",
            background: "var(--surface-raised)",
            color: "var(--text-1)",
            // 16px on the phone. Below that Safari zooms the page on focus and
            // never zooms back, which leaves the tab bar off screen.
            font: size === "touch" ? "var(--text-phone-body)" : "var(--text-body)",
            outline: "none",
          }}
        />
        <Button
          variant="affirm"
          size={size === "touch" ? "touch" : "md"}
          disabled={blocked || !text.trim()}
          onClick={send}
        >
          Send
        </Button>
      </div>
      <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>
        {waiting
          ? "Waiting on your answer above."
          : busy
            ? "Working. Enter sends when it's done."
            : "Enter sends · shift-enter for a new line"}
      </span>
    </div>
  );
}
