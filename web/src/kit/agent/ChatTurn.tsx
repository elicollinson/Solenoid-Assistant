import type { CSSProperties, ReactNode } from "react";
import { MonoLabel } from "../core/MonoLabel";
import { ToolCalls, type ToolCall } from "./ToolCalls";

/**
 * One turn of a conversation with the agent.
 *
 * The two halves are drawn differently on purpose, and it is the design's most
 * load-bearing decision on this screen: **your words are a bubble and the
 * agent's are prose.** Yours are short, addressed, and belong to you — a
 * right-aligned card with a border says so. Its own are the page talking, and a
 * page does not put its own paragraphs in boxes.
 *
 * The alternative, which this replaced, was both sides as prose in a mono
 * gutter. It reads fine with two turns and becomes unskimmable at twenty:
 * nothing distinguishes a question from an answer except a word in the margin.
 *
 * The stamp sits above the turn rather than beside it, which is what lets the
 * same component work at 390px — a 96px gutter is a quarter of a phone.
 */
export function ChatTurn({
  by,
  at,
  children,
  calls = [],
  callsOpen = false,
  toolSummary,
  approval,
  note,
  pending = false,
  touch = false,
  style,
}: {
  by: "user" | "agent";
  /** "09:39", "Thu 09:39". Derived at read time — never stored. */
  at: string;
  children?: ReactNode;
  calls?: readonly ToolCall[];
  /** Expanded rather than collapsed. What a turn still running is doing is the
   *  thing you are watching; what a finished one did is a line you can open. */
  callsOpen?: boolean;
  /** "4 tool calls · docs.read, web.form_walk". The collapsed line. */
  toolSummary?: string | null;
  /**
   * The gate this turn stopped on, if it stopped.
   *
   * Its own slot rather than part of `children`, because it is a panel and the
   * prose above it is set with `pre-wrap`: nesting a block inside a container
   * whose whole job is to preserve the author's line breaks makes the panel's
   * layout depend on where the sentence ended.
   */
  approval?: ReactNode;
  /** "written to okf:policy/ferris-hold · rev 1". */
  note?: string | null;
  /** The turn still being written. Draws the caret and nothing else — no
   *  spinner: the tool calls above it already say what is happening. */
  pending?: boolean;
  /** The phone's type scale. */
  touch?: boolean;
  style?: CSSProperties;
}) {
  const mine = by === "user";
  const prose = touch ? "var(--text-phone-lede)" : "var(--text-body)";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: mine ? "flex-end" : "stretch",
        gap: mine ? "var(--sp-2)" : "var(--sp-3)",
        ...style,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
        <MonoLabel>{mine ? "You" : "Solenoid"}</MonoLabel>
        <span style={{ font: "var(--text-mono-meta)", color: "var(--text-4)", flexShrink: 0 }}>{at}</span>
      </span>

      {mine ? (
        <p
          style={{
            margin: 0,
            // Narrower than the column it sits in. A bubble that ran the full
            // width would stop reading as one side of a conversation.
            maxWidth: touch ? "30ch" : "44ch",
            padding: "var(--sp-5) var(--sp-6)",
            borderRadius: "var(--radius-card)",
            border: "var(--border-strong)",
            background: touch ? "var(--surface-raised)" : "var(--surface-panel)",
            font: prose,
            color: "var(--text-1)",
            textWrap: "pretty",
            whiteSpace: "pre-wrap",
          }}
        >
          {children}
        </p>
      ) : (
        <>
          {children || pending ? (
            <div
              style={{
                font: prose,
                color: "var(--text-2)",
                maxWidth: touch ? "none" : "var(--measure)",
                textWrap: "pretty",
                // The agent writes paragraphs; a transcript that ran them
                // together would be the one place in the app that does.
                whiteSpace: "pre-wrap",
              }}
            >
              {children}
              {pending ? <Caret /> : null}
            </div>
          ) : null}

          {calls.length || toolSummary ? (
            <ToolCalls
              calls={calls}
              summary={toolSummary ?? undefined}
              defaultOpen={callsOpen}
              style={{ maxWidth: touch ? "none" : "56ch" }}
            />
          ) : null}

          {approval}

          {note ? (
            <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>{note}</span>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The command caret, as the ask button carries it: a 3px teal bar. */
function Caret() {
  return (
    <span
      aria-label="still writing"
      style={{
        display: "inline-block",
        width: 3,
        height: "1em",
        marginLeft: 2,
        verticalAlign: "text-bottom",
        background: "var(--accent)",
        animation: "solenoid-caret 1.1s steps(1) infinite",
      }}
    />
  );
}
