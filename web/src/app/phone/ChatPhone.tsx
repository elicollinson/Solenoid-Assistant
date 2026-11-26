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
import { useId, useState, type KeyboardEvent } from "react";
import { Button, ConversationRow, RetroWigglyLine } from "../../kit";
import { hasActiveTurn, modelLabel, useFollowBottom, type ChatState } from "../chat";
import { LiveSection, StoredTurn } from "../ChatBlocks";
import type { VoiceModeState } from "../useVoiceMode";
import { PhoneScreen, type PhoneTab } from "./chrome";

const CONTROL = {
  font: "var(--text-mono-control)",
  letterSpacing: "var(--tracking-control)",
  textTransform: "uppercase",
} as const;

export function ChatPhone({ chat, voice, onTab }: { chat: ChatState; voice: VoiceModeState; onTab: (tab: PhoneTab) => void }) {
  // No ask dock on either of these screens. It is for the four that have no
  // way to say anything; here the thread has a composer and the list has "Start
  // a new one", and the floating disc lands on top of that button.
  const chrome = { tab: "Chat" as const, onTab };
  return chat.openId ? <Thread chat={chat} voice={voice} chrome={chrome} /> : <List chat={chat} chrome={chrome} />;
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
            voiceInvoked={row.voiceInvoked}
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
function Thread({ chat, voice, chrome }: { chat: ChatState; voice: VoiceModeState; chrome: Partial<Chrome> }) {
  const { box, content } = useFollowBottom();
  const live = chat.live;
  const busy = hasActiveTurn(live);
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-2)" }}>
          <button
            type="button"
            onClick={() => chat.open(null)}
            style={{
              all: "unset",
              appearance: "none",
              WebkitAppearance: "none",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              minHeight: "var(--touch)",
              alignSelf: "flex-start",
              padding: "0 var(--sp-4)",
              margin: "0 calc(var(--sp-4) * -1)",
              ...CONTROL,
              color: "var(--text-3)",
            }}
          >
            ← Conversations
          </button>
          <span
            style={{
              font: "var(--text-mono-meta)",
              padding: "2px 7px",
              borderRadius: "var(--radius-control)",
              background: "var(--surface-raised)",
              border: "var(--border)",
              color: chat.voiceInvoked || voice.active ? "var(--text-1)" : "var(--text-3)",
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              whiteSpace: "nowrap",
              fontSize: "10px",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            <span
              style={{
                width: "5px",
                height: "5px",
                borderRadius: "50%",
                backgroundColor: chat.voiceInvoked || voice.active ? "var(--signal-green)" : "var(--text-4)",
              }}
            />
            {chat.voiceInvoked || voice.active ? "Gemini Live" : modelLabel(chat.model) ?? "Model"}
          </span>
        </div>
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
            <StoredTurn key={turn.id} touch turn={turn} onAnswer={chat.answer} />
          ))}

          {live ? <LiveSection chat={chat} touch /> : null}
        </div>
      </div>

      {voice.error ? (
        <p role="alert" style={{ padding: "0 var(--gutter-phone) var(--sp-4)", margin: 0 }}>
          Voice mode failed: {voice.error}
        </p>
      ) : null}
      {voice.active ? (
        <div style={{ padding: "0 var(--gutter-phone) var(--sp-4)" }}>
          <RetroWigglyLine
            active={voice.active}
            analyserNode={voice.analyserNode}
            isWorking={voice.isWorking} isSpeaking={voice.isSpeaking}
            isMuted={voice.isMuted}
            extendedThinking={voice.extendedThinking}
            thinkingDisabled={voice.status !== "open" || voice.isWorking || voice.isSpeaking}
            reconnecting={voice.status === "connecting"}
            onToggleThinking={voice.toggleExtendedThinking}
            onToggleMute={voice.toggleMute}
            onEndVoice={voice.stopVoice}
          />
        </div>
      ) : null}

      <ThreadComposer
        chat={chat}
        // A turn that ended in an error is still on screen, but it is over —
        // and idle deferred approvals or background subagents leave the
        // composer open for the next thing you want to say.
        busy={busy}
        waiting={waiting}
        voiceActive={voice.active}
        onToggleVoice={voice.active ? voice.stopVoice : voice.startVoice}
      />
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
function ThreadComposer({
  chat,
  busy,
  waiting,
  voiceActive,
  onToggleVoice,
}: {
  chat: ChatState;
  busy: boolean;
  waiting: boolean;
  voiceActive?: boolean;
  onToggleVoice?: () => void;
}) {
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
      <Bar
        onSend={chat.send}
        disabled={waiting}
        busy={busy}
        voiceActive={voiceActive}
        onToggleVoice={onToggleVoice}
      />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-3)" }}>
        <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>
          {waiting
            ? "Answer above first."
            : busy
              ? "Working."
              : voiceActive
                ? "Voice stream open · speak or type"
                : "Enter sends."}
        </span>
        {busy && chat.cancel ? (
          <button
            type="button"
            onClick={chat.cancel}
            style={{
              all: "unset",
              appearance: "none",
              WebkitAppearance: "none",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              minHeight: "var(--touch)",
              padding: "0 var(--sp-3)",
              margin: "calc(var(--sp-2) * -1) calc(var(--sp-3) * -1)",
              ...CONTROL,
              color: "var(--danger-text)",
            }}
          >
            Stop
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Bar({
  onSend,
  disabled,
  busy,
  voiceActive,
  onToggleVoice,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
  busy: boolean;
  voiceActive?: boolean;
  onToggleVoice?: () => void;
}) {
  const [text, setText] = useState("");
  const inputId = useId();
  const canSend = !disabled && !busy && Boolean(text.trim());

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      if (event.key === "Enter") event.preventDefault();
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const said = text.trim();
        if (!said || disabled || busy) return;
        setText("");
        onSend(said);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-2)",
        minHeight: "var(--touch)",
        padding: "3px 3px 3px var(--sp-5)",
        borderRadius: "var(--radius-card)",
        border: "var(--border-strong)",
        background: "var(--surface-raised)",
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        Message Solenoid
      </label>
      <input
        id={inputId}
        name="say"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder={disabled ? "Answer above first" : voiceActive ? "Voice active — speak or type" : "Tell me what to do"}
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
      {onToggleVoice ? (
        <button
          type="button"
          onClick={onToggleVoice}
          style={{
            all: "unset",
            appearance: "none",
            WebkitAppearance: "none",
            boxSizing: "border-box",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "5px",
            minHeight: "var(--touch)",
            padding: "0 var(--sp-4)",
            borderRadius: "var(--radius-control)",
            background: voiceActive ? "var(--surface-selected)" : "var(--surface-panel)",
            border: voiceActive ? "1px solid var(--accent)" : "1px solid var(--line-strong)",
            color: voiceActive ? "var(--text-1)" : "var(--text-2)",
            font: "var(--text-mono-control)",
            letterSpacing: "var(--tracking-control)",
            textTransform: "uppercase",
            flexShrink: 0,
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
            }}
          />
          {voiceActive ? "End" : "Voice"}
        </button>
      ) : null}
      <button
        type="submit"
        disabled={!canSend}
        style={{
          all: "unset",
          appearance: "none",
          WebkitAppearance: "none",
          boxSizing: "border-box",
          cursor: canSend ? "pointer" : "default",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "var(--touch)",
          padding: "0 var(--sp-5)",
          borderRadius: "var(--radius-control)",
          background: "var(--affirm)",
          color: "var(--text-on-accent)",
          font: "var(--text-ui-sm)",
          opacity: canSend ? 1 : 0.45,
          flexShrink: 0,
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
