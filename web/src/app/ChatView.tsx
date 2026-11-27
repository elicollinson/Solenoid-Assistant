import type { CSSProperties } from "react";
import {
  Button,
  Composer,
  ConversationRow,
  MonoLabel,
  RetroWigglyLine,
  StatusMark,
} from "../kit";
import { hasActiveTurn, modelLabel, useFollowBottom, type ChatState } from "./chat";
import { LiveSection, StoredTurn } from "./ChatBlocks";
import type { VoiceModeState } from "./useVoiceMode";

/**
 * Shared horizontal rail for the header, transcript, and composer so the title,
 * model badge, right-aligned user bubbles, and composer edges line up cleanly
 * at standard desktop widths while staying bounded on ultrawide monitors.
 * Individual agent paragraphs stay constrained to `--measure` inside `ChatTurn`.
 */
const COLUMN: CSSProperties = {
  width: "100%",
  maxWidth: 880,
  marginInline: "auto",
};

/**
 * Talking to the agent, on the desktop.
 *
 * Two columns rather than one, and the second is not an afterthought: the
 * conversation list lives in the aside, which is where every other screen in
 * this app puts "the other things like the one you are looking at". Chat is the
 * only surface where that list is also the navigation, so it carries the New
 * control, and the restraint line sits under it.
 */
export function ChatView({ chat, voice }: { chat: ChatState; voice: VoiceModeState }) {
  const { box, content } = useFollowBottom();
  const live = chat.live;
  const open = Boolean(chat.openId);
  const busy = hasActiveTurn(live);
  const waiting = Boolean(live?.pending);

  return (
    <>
      <main style={{ gridColumn: "2", display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
        <header
          style={{
            padding: "var(--sp-9) var(--sp-10) 18px",
            borderBottom: "var(--border)",
          }}
        >
          <div
            style={{
              ...COLUMN,
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              gap: "var(--sp-8)",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", minWidth: 0 }}>
              <h1
                style={{
                  margin: 0,
                  font: "var(--text-display)",
                  letterSpacing: "var(--tracking-display)",
                  color: "var(--text-1)",
                  textWrap: "pretty",
                }}
              >
                {chat.title ?? (open ? "New conversation" : "Chat")}
              </h1>
              <p
                style={{
                  margin: 0,
                  font: "var(--text-body)",
                  color: "var(--text-3)",
                  maxWidth: "var(--measure)",
                  textWrap: "pretty",
                }}
              >
                {open
                  ? chat.lede || "Ask me anything. Anything needing your word stops here as a bubble."
                  : EMPTY_LIST}
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)", flexShrink: 0 }}>
              {open ? (
                <span
                  style={{
                    font: "var(--text-mono-meta)",
                    padding: "4px 9px",
                    borderRadius: "var(--radius-control)",
                    background: "var(--surface-raised)",
                    border: "var(--border)",
                    color: chat.voiceInvoked || voice.active ? "var(--text-1)" : "var(--text-3)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    whiteSpace: "nowrap",
                    fontSize: "11px",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: "6px",
                      height: "6px",
                      borderRadius: "50%",
                      backgroundColor: chat.voiceInvoked || voice.active ? "var(--signal-green)" : "var(--text-4)",
                    }}
                  />
                  {chat.voiceInvoked || voice.active ? "Gemini Live" : modelLabel(chat.model) ?? "Model"}
                </span>
              ) : null}

              {chat.waiting ? (
                <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
                  <StatusMark state="attention" size={11} />
                  <span style={{ font: "var(--text-mono)", color: "var(--text-3)" }}>
                    {chat.waiting === 1 ? "one is waiting on you" : `${chat.waiting} are waiting on you`}
                  </span>
                </span>
              ) : null}
            </div>
          </div>
        </header>

        <div ref={box} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 var(--sp-10) var(--sp-9)" }}>
          <div ref={content} style={{ ...COLUMN, display: "flex", flexDirection: "column" }}>
            {chat.status === "error" ? (
              <Notice>
                I couldn't read it — {chat.message}. Start the server with <code>bun run start:server</code>.
              </Notice>
            ) : null}

            {open && chat.status === "ready" && !chat.stored.length && !live ? (
              <Notice>Nothing said yet. Whatever you send starts this one off.</Notice>
            ) : null}

            {open ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-8)", paddingTop: "var(--sp-6)" }}>
                {chat.stored.map((turn) => (
                  <StoredTurn key={turn.id} turn={turn} onAnswer={chat.answer} />
                ))}
                {live ? <LiveSection chat={chat} /> : null}
              </div>
            ) : null}
          </div>
        </div>

        <footer
          style={{
            padding: "var(--sp-6) var(--sp-10) var(--sp-8)",
            borderTop: "var(--border)",
            background: "var(--surface-panel)",
          }}
        >
          <div style={{ ...COLUMN, display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
            {voice.error ? (
              <p role="alert" style={{ margin: 0, font: "var(--text-body-sm)", color: "var(--danger-text)" }}>
                Voice mode failed: {voice.error}
              </p>
            ) : null}
            {voice.active ? (
              <div>
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
            <Composer
              onSend={chat.send}
              onCancel={chat.cancel}
              busy={busy}
              waiting={waiting}
              voiceActive={voice.active}
              onToggleVoice={voice.active ? voice.stopVoice : voice.startVoice}
              commands={chat.skills}
              placeholder={voice.active ? "Voice mode active — speak or type" : "Tell me what to do"}
              style={{ borderTop: "none", padding: 0 }}
            />
          </div>
        </footer>
      </main>

      <aside
        style={{
          gridColumn: "3",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          borderLeft: "var(--border)",
          background: "var(--surface-panel)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--sp-5)",
            padding: "var(--sp-8) var(--sp-8) var(--sp-6)",
            borderBottom: "var(--border)",
          }}
        >
          <MonoLabel style={{ letterSpacing: "0.14em" }}>Conversations</MonoLabel>
          <Button
            variant="bare"
            size="sm"
            onClick={chat.start}
            style={{
              font: "var(--text-mono-control)",
              letterSpacing: "var(--tracking-control)",
              textTransform: "uppercase",
            }}
          >
            New
          </Button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {chat.conversations.map((row) => (
            <ConversationRow
              key={row.id}
              title={row.title}
              lede={row.lede}
              when={row.when}
              state={row.state}
              voiceInvoked={row.voiceInvoked}
              selected={row.id === chat.openId}
              onOpen={() => chat.open(row.id)}
            />
          ))}
        </div>

        {chat.restraint ? (
          <p
            style={{
              margin: 0,
              padding: "var(--sp-7) var(--sp-8) var(--sp-8)",
              borderTop: "var(--border)",
              font: "var(--text-body-sm)",
              color: "var(--text-3)",
              textWrap: "pretty",
            }}
          >
            {chat.restraint}
          </p>
        ) : null}
      </aside>
    </>
  );
}

/** What the screen says when nothing is open. The design's own sentence. */
const EMPTY_LIST =
  "Nothing said yet. Whatever you send starts a conversation of its own, and I'll keep it here.";

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        padding: "var(--sp-9) 0",
        font: "var(--text-body)",
        color: "var(--text-3)",
        textWrap: "pretty",
      }}
    >
      {children}
    </p>
  );
}
