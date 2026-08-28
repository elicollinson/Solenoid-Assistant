// Chat at 390px: two screens in one frame.
//
// The conversation list, and one thread. The design draws both and they are one
// destination — you arrive at the list, drill into a thread, and come back with
// the link at the top rather than with the tab bar. That is why this is not two
// tabs: the bar says where you are in the app, and both of these are Chat.
//
// The transcript keeps the desktop's grammar — your words in a bubble, the
// agent's as prose, approvals as one standard bubble — but the bubble goes full
// width and its buttons stack, because at this width a row of two buttons is
// two half-buttons.
import { ApprovalBubble, Button, ChatTurn, ConversationRow } from "../../kit";
import { spoken, useFollowBottom, type ChatState } from "../chat";
import { PhoneScreen, type PhoneTab } from "./chrome";

const CONTROL = {
  font: "var(--text-mono-control)",
  letterSpacing: "var(--tracking-control)",
  textTransform: "uppercase",
} as const;

export function ChatPhone({ chat, onTab }: { chat: ChatState; onTab: (tab: PhoneTab) => void }) {
  // No ask dock on either of these screens. It is for the four that have no
  // way to say anything; here the thread has a composer and the list has "Start
  // a new one", and the floating disc lands on top of that button.
  const chrome = { tab: "Chat" as const, onTab };
  return chat.openId ? <Thread chat={chat} chrome={chrome} /> : <List chat={chat} chrome={chrome} />;
}

type Chrome = Parameters<typeof PhoneScreen>[0];

/** Everything you have said to it, newest first. */
function List({ chat, chrome }: { chat: ChatState; chrome: Partial<Chrome> }) {
  return (
    <PhoneScreen
      {...(chrome as Chrome)}
      meta={chat.waiting ? `${chat.waiting} open` : undefined}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-3)",
          padding: "0 var(--gutter-phone) var(--sp-7)",
          flexShrink: 0,
        }}
      >
        <h1
          style={{
            margin: 0,
            font: "var(--text-phone-display)",
            letterSpacing: "var(--tracking-display)",
            color: "var(--text-1)",
          }}
        >
          Conversations
        </h1>
        <p style={{ margin: 0, font: "var(--text-phone-lede)", color: "var(--text-3)", textWrap: "pretty" }}>
          Everything we've said, newest first. Sending from anywhere else starts a new one.
        </p>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          borderTop: "var(--border)",
          background: "var(--surface-panel)",
          padding: "0 var(--gutter-phone) var(--sp-8)",
        }}
      >
        {chat.status === "error" ? (
          <Note>I couldn't read them — {chat.message}.</Note>
        ) : null}

        {chat.conversations.map((row) => (
          <ConversationRow
            key={row.id}
            touch
            title={row.title}
            lede={row.lede}
            when={row.when}
            state={row.state}
            onOpen={() => chat.open(row.id)}
            // The rows run edge to edge; the padding above is for the prose.
            style={{ margin: "0 calc(-1 * var(--gutter-phone))", padding: "var(--sp-6) var(--gutter-phone)" }}
          />
        ))}

        {chat.status === "ready" && !chat.conversations.length ? (
          <Note>Nothing said yet. Whatever you send starts a conversation of its own.</Note>
        ) : null}

        {chat.restraint ? (
          <p style={{ margin: "var(--sp-8) 0 0", font: "var(--text-phone-note)", color: "var(--text-3)" }}>
            {chat.restraint}
          </p>
        ) : null}
      </div>

      <div style={{ padding: "var(--sp-6) var(--gutter-phone)", borderTop: "var(--border)", flexShrink: 0 }}>
        <Button variant="affirm" size="touch" onClick={chat.start} style={{ width: "100%" }}>
          Start a new one
        </Button>
      </div>
    </PhoneScreen>
  );
}

/** One conversation, and where you say the next thing. */
function Thread({ chat, chrome }: { chat: ChatState; chrome: Partial<Chrome> }) {
  const { box, content } = useFollowBottom();
  const live = chat.live;
  const waiting = Boolean(live?.pending);

  return (
    <PhoneScreen {...(chrome as Chrome)}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-3)",
          padding: "0 var(--gutter-phone) var(--sp-6)",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => chat.open(null)}
          style={{
            all: "unset",
            cursor: "pointer",
            alignSelf: "flex-start",
            // A touch target rather than a glyph: the word is small, what your
            // thumb has to hit is not.
            padding: "var(--sp-3) var(--sp-4)",
            margin: "calc(var(--sp-3) * -1) calc(var(--sp-4) * -1)",
            ...CONTROL,
            color: "var(--text-3)",
          }}
        >
          ← Conversations
        </button>
        <h1
          style={{
            margin: 0,
            font: "var(--text-phone-title)",
            letterSpacing: "var(--tracking-title)",
            color: "var(--text-1)",
            textWrap: "pretty",
          }}
        >
          {chat.title ?? "New conversation"}
        </h1>
      </div>

      <div
        ref={box}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "var(--sp-7) var(--gutter-phone) var(--sp-8)",
          borderTop: "var(--border)",
          background: "var(--surface-panel)",
        }}
      >
        <div ref={content} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-8)" }}>
          {chat.status === "error" ? <Note>I couldn't read it — {chat.message}.</Note> : null}

          {chat.status === "ready" && !chat.stored.length && !live ? (
            <Note>Nothing said yet. Whatever you send starts this one off.</Note>
          ) : null}

          {chat.stored.map((turn) => (
            <ChatTurn
              key={turn.id}
              touch
              by={turn.by}
              at={turn.at}
              calls={turn.calls}
              toolSummary={turn.toolSummary}
              note={turn.note}
              approval={
                turn.approval ? (
                  <ApprovalBubble
                    touch
                    reference={turn.approval.ref}
                    title={turn.approval.title}
                    why={turn.approval.why}
                    hold={turn.approval.hold}
                    facts={turn.approval.facts}
                    choices={turn.approval.choices}
                    settled={turn.approval.settled}
                    onChoose={chat.answer}
                  />
                ) : null
              }
            >
              {turn.approval ? null : turn.body}
            </ChatTurn>
          ))}

          {live ? (
            <>
              <ChatTurn touch by="user" at="now">
                {live.asked}
              </ChatTurn>
              <ChatTurn
                touch
                by="agent"
                at="now"
                calls={live.calls}
                callsOpen
                note={live.opened.length ? `opened ${live.opened.join(", ")}` : null}
                pending={!live.error}
                approval={
                  live.pending ? (
                    <ApprovalBubble
                      touch
                      reference={live.pending.ref}
                      title={live.pending.title}
                      why={live.pending.why}
                      hold={live.pending.hold}
                      facts={live.pending.facts}
                      choices={live.pending.actions}
                      onChoose={chat.answer}
                    />
                  ) : null
                }
              >
                {spoken(live)}
                {live.error ? (
                  <span style={{ font: "var(--text-phone-note)", color: "var(--danger-text)" }}>
                    That turn didn't finish — {live.error}
                  </span>
                ) : null}
              </ChatTurn>
            </>
          ) : null}
        </div>
      </div>

      <ThreadComposer chat={chat} busy={Boolean(live)} waiting={waiting} />
    </PhoneScreen>
  );
}

/**
 * The phone's composer: one line, not a growing box.
 *
 * Different from the desktop's on purpose. A textarea that grows eats the
 * transcript on a 844px screen, and the keyboard has already taken half of it —
 * so this is the design's single-line bar, and Enter is the only way to send.
 */
function ThreadComposer({ chat, busy, waiting }: { chat: ChatState; busy: boolean; waiting: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-3)",
        padding: "var(--sp-6) var(--gutter-phone)",
        borderTop: "var(--border)",
        background: "var(--surface-app)",
        flexShrink: 0,
      }}
    >
      <Bar onSend={chat.send} disabled={waiting} busy={busy} />
      <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>
        {waiting ? "Answer above first." : busy ? "Working." : "Enter sends."}
      </span>
    </div>
  );
}

function Bar({ onSend, disabled, busy }: { onSend: (text: string) => void; disabled: boolean; busy: boolean }) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const field = event.currentTarget.elements.namedItem("say");
        if (!(field instanceof HTMLInputElement)) return;
        const said = field.value.trim();
        if (!said || disabled || busy) return;
        field.value = "";
        onSend(said);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-4)",
        minHeight: "var(--touch)",
        padding: "0 var(--sp-3) 0 var(--sp-5)",
        borderRadius: "var(--radius-card)",
        border: "var(--border-strong)",
        background: "var(--surface-raised)",
      }}
    >
      <input
        name="say"
        disabled={disabled}
        placeholder={disabled ? "Answer above first" : "Tell me what to do"}
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
      <button
        type="submit"
        disabled={disabled || busy}
        style={{
          all: "unset",
          cursor: disabled || busy ? "default" : "pointer",
          display: "inline-flex",
          alignItems: "center",
          minHeight: 34,
          padding: "0 var(--sp-5)",
          borderRadius: "var(--radius-control)",
          background: "var(--affirm)",
          color: "var(--text-on-accent)",
          font: "var(--text-ui-sm)",
          opacity: disabled || busy ? 0.45 : 1,
        }}
      >
        Send
      </button>
    </form>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: 0, padding: "var(--sp-8) 0", font: "var(--text-phone-lede)", color: "var(--text-3)", textWrap: "pretty" }}>
      {children}
    </p>
  );
}
