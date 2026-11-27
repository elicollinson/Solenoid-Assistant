import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "../core/Button";
import { MonoLabel } from "../core/MonoLabel";

export interface ComposerCommand {
  name: string;
  title?: string;
  description: string;
  source?: string;
}

/** Match commands against a leading `/<query>` prefix, prioritizing name prefix hits. */
export function filterSlashCommands(
  text: string,
  commands: readonly ComposerCommand[],
): { query: string; matches: ComposerCommand[] } | null {
  if (!commands.length) return null;
  const match = /^\/([a-z0-9_-]*)$/i.exec(text);
  if (!match) return null;
  const query = (match[1] ?? "").toLowerCase();
  const matches = commands
    .filter((cmd) => {
      if (!query) return true;
      return (
        cmd.name.toLowerCase().includes(query) ||
        (cmd.title?.toLowerCase().includes(query) ?? false) ||
        cmd.description.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(query) ? 0 : 1;
      const bPrefix = b.name.toLowerCase().startsWith(query) ? 0 : 1;
      return aPrefix - bPrefix || a.name.localeCompare(b.name);
    });
  return { query, matches };
}

/**
 * Where you type.
 *
 * A textarea that grows to what you have written and then scrolls, rather than
 * a single line: the things people ask an assistant are frequently two
 * sentences, and a one-line field makes you write as if you were searching.
 *
 * Enter sends and shift-enter breaks the line, which is the convention every
 * chat has trained; the hint says so once, quietly, rather than in a tooltip
 * nobody opens. Typing `/` opens an inline combobox picker for available skills.
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
  commands = [],
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
  /** Slash-invocable skills shown when typing `/` at the start of the field. */
  commands?: readonly ComposerCommand[];
  style?: CSSProperties;
}) {
  const [text, setText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const listId = useId();
  const minControlHeight = size === "touch" ? 44 : 40;

  // Grow to fit. Reset to auto first or the box can only ever get taller.
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.max(minControlHeight, Math.min(node.scrollHeight, 160))}px`;
  }, [text, minControlHeight]);

  const blocked = busy || waiting;
  const slash = !waiting && !dismissed ? filterSlashCommands(text, commands) : null;
  const matches = slash?.matches ?? [];
  const showPicker = Boolean(slash && matches.length > 0);
  const activeIndex = showPicker ? Math.min(selectedIndex, matches.length - 1) : 0;
  const activeCommand = showPicker ? matches[activeIndex] : undefined;
  const activeOptionId = showPicker ? `${listId}-opt-${activeIndex}` : undefined;

  const send = () => {
    const said = text.trim();
    if (!said || blocked) return;
    onSend(said);
    setText("");
    setSelectedIndex(0);
    setDismissed(false);
  };

  const pickCommand = (name: string) => {
    setText(`/${name} `);
    setSelectedIndex(0);
    setDismissed(false);
    field.current?.focus();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Pairing isComposing with keyCode === 229 catches Safari's out-of-order
    // confirming Enter keydown during CJK / IME composition.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    if (showPicker && activeCommand) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        pickCommand(activeCommand.name);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        // Exact match (e.g. `/intro`) sends directly; partial prefix completes `/<name> `.
        if (text.trim().toLowerCase() === `/${activeCommand.name.toLowerCase()}`) {
          send();
        } else {
          pickCommand(activeCommand.name);
        }
        return;
      }
    }

    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    send();
  };

  return (
    <form
      onSubmit={onSubmit}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
        padding: "var(--sp-4) 0 0",
        borderTop: "var(--border-strong)",
        ...style,
      }}
    >
      {showPicker ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Skills"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: "calc(100% + var(--sp-2))",
            zIndex: 20,
            maxHeight: 260,
            overflowY: "auto",
            borderRadius: "var(--radius-card)",
            border: "var(--border-strong)",
            background: "var(--surface-raised)",
            boxShadow: "var(--shadow-float)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "var(--sp-2) var(--sp-5)",
              borderBottom: "var(--border)",
              background: "var(--surface-panel)",
            }}
          >
            <MonoLabel>Skills</MonoLabel>
            <span style={{ font: "var(--text-mono-meta)", color: "var(--text-4)" }}>
              ↑↓ choose · Tab or Enter
            </span>
          </div>
          {matches.map((cmd, index) => {
            const selected = index === activeIndex;
            return (
              <button
                key={cmd.name}
                id={`${listId}-opt-${index}`}
                type="button"
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setSelectedIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pickCommand(cmd.name);
                }}
                style={{
                  all: "unset",
                  appearance: "none",
                  WebkitAppearance: "none",
                  boxSizing: "border-box",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  width: "100%",
                  padding: "var(--sp-3) var(--sp-5)",
                  borderTop: index === 0 ? "none" : "var(--border)",
                  background: selected ? "var(--surface-selected)" : "transparent",
                  transition: "background var(--dur) var(--ease)",
                }}
              >
                <span style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-3)" }}>
                  <span
                    style={{
                      font: "var(--text-mono-control)",
                      color: "var(--accent-quiet)",
                    }}
                  >
                    /{cmd.name}
                  </span>
                  {cmd.title ? (
                    <span style={{ font: "var(--text-ui-sm)", color: "var(--text-1)" }}>
                      {cmd.title}
                    </span>
                  ) : null}
                </span>
                <span
                  style={{
                    font: "var(--text-body-sm)",
                    color: "var(--text-3)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {cmd.description}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

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
          role={commands.length ? "combobox" : undefined}
          aria-expanded={commands.length ? showPicker : undefined}
          aria-controls={showPicker ? listId : undefined}
          aria-activedescendant={activeOptionId}
          aria-autocomplete={commands.length ? "list" : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setSelectedIndex(0);
            setDismissed(false);
          }}
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
              : commands.length
                ? "Enter sends · shift-enter for a new line · / for skills"
                : "Enter sends · shift-enter for a new line"}
      </span>
    </form>
  );
}
