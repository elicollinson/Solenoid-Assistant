import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
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
  onCancel,
  busy = false,
  waiting = false,
  placeholder = "Ask Solenoid",
  size = "md",
  voiceActive = false,
  onToggleVoice,
  style,
}: {
  onSend: (text: string) => void;
  /** Cancel an in-flight turn without shifting the footer's height. */
  onCancel?: () => void;
  /** A turn is running. You can still type the next thing; it just cannot go. */
  busy?: boolean;
  /** A turn is stopped on an approval. Nothing may be said until it is settled. */
  waiting?: boolean;
  placeholder?: string;
  /** "touch" gives the phone its 44px targets and 16px text — anything smaller
   *  and iOS zooms the whole page on focus. */
  size?: "md" | "touch";
  voiceActive?: boolean;
  onToggleVoice?: () => void;
  style?: CSSProperties;
}) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const minControlHeight = size === "touch" ? 44 : 40;

  // Grow to fit. Reset to auto first or the box can only ever get taller.
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.max(minControlHeight, Math.min(node.scrollHeight, 160))}px`;
  }, [text, minControlHeight]);

  const blocked = busy || waiting;
  const send = () => {
    const said = text.trim();
    if (!said || blocked) return;
    onSend(said);
    setText("");
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Pairing isComposing with keyCode === 229 catches Safari's out-of-order
    // confirming Enter keydown during CJK / IME composition.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    send();
  };

  return (
    <form
      onSubmit={onSubmit}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
        padding: "var(--sp-4) 0 0",
        borderTop: "var(--border-strong)",
        ...style,
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Message Solenoid
      </label>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "var(--sp-3)" }}>
        <textarea
          id={inputId}
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
            minHeight: minControlHeight,
            resize: "none",
            boxSizing: "border-box",
            padding: size === "touch" ? "10px var(--sp-5)" : "8px var(--sp-5)",
            borderRadius: "var(--radius-control)",
            border: "var(--border-strong)",
            background: "var(--surface-raised)",
            color: "var(--text-1)",
            // 16px on the phone. Below that Safari zooms the page on focus and
            // never zooms back, which leaves the tab bar off screen.
            font: size === "touch" ? "var(--text-phone-body)" : "var(--text-body)",
            lineHeight: size === "touch" ? "1.45" : "1.5",
          }}
        />
        {onToggleVoice ? (
          <Button
            variant="quiet"
            size={size === "touch" ? "touch" : "md"}
            onClick={onToggleVoice}
            style={{
              height: minControlHeight,
              padding: "0 var(--sp-5)",
              gap: "var(--sp-2)",
              font: "var(--text-mono-control)",
              letterSpacing: "var(--tracking-control)",
              textTransform: "uppercase",
              border: voiceActive ? "1px solid var(--accent)" : "1px solid var(--line-strong)",
              background: voiceActive ? "var(--surface-selected)" : "var(--surface-raised)",
              color: voiceActive ? "var(--text-1)" : "var(--text-2)",
            }}
            title={voiceActive ? "End voice session" : "Start voice mode with Gemini Live"}
          >
            <span
              aria-hidden="true"
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                backgroundColor: voiceActive ? "var(--signal-green)" : "var(--text-4)",
                display: "inline-block",
              }}
            />
            {voiceActive ? "End Voice" : "Voice"}
          </Button>
        ) : null}
        {busy && onCancel ? (
          <Button
            variant="danger"
            size={size === "touch" ? "touch" : "md"}
            onClick={onCancel}
            style={{ height: minControlHeight, padding: "0 var(--sp-5)" }}
          >
            Stop
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="affirm"
          size={size === "touch" ? "touch" : "md"}
          disabled={blocked || !text.trim()}
          style={{ height: minControlHeight, padding: "0 var(--sp-7)" }}
        >
          Send
        </Button>
      </div>
      <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>
        {waiting
          ? "Waiting on your answer above."
          : busy
            ? "Working. Enter sends when it's done."
            : voiceActive
              ? "Voice stream is open · speak or type"
              : "Enter sends · shift-enter for a new line"}
      </span>
    </form>
  );
}
