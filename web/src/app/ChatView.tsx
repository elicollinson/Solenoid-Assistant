import { ApprovalBubble, Button, ChatTurn, Composer, ConversationRow, MonoLabel, StatusMark } from "../kit";
import { spoken, useFollowBottom, type ChatState } from "./chat";

/**
 * Talking to the agent, on the desktop.
 *
 * Two columns rather than one, and the second is not an afterthought: the
 * conversation list lives in the aside, which is where every other screen in
 * this app puts "the other things like the one you are looking at". Chat is the
 * only surface where that list is also the navigation, so it carries the New
 * control, and the restraint line sits under it.
 *
 * The transcript is held to `--measure` inside the canvas. A conversation is
 * prose, and prose at 900px is unreadable — the same decision the reminders
 * lede makes with the same empty half.
 */
export function ChatView({ chat }: { chat: ChatState }) {
  const { box, content } = useFollowBottom();
  const live = chat.live;
  const open = Boolean(chat.openId);

  return (
    <>
      <main style={{ gridColumn: "2", display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
        <header
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: "var(--sp-8)",
            padding: "var(--sp-9) var(--sp-10) 18px",
            borderBottom: "var(--border)",
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
          {chat.waiting ? (
            <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", flexShrink: 0 }}>
              <StatusMark state="attention" size={11} />
              <span style={{ font: "var(--text-mono)", color: "var(--text-3)" }}>
                {chat.waiting === 1 ? "one is waiting on you" : `${chat.waiting} are waiting on you`}
              </span>
            </span>
          ) : null}
        </header>

        <div ref={box} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 var(--sp-10) var(--sp-9)" }}>
          <div ref={content} style={{ maxWidth: "var(--measure)", display: "flex", flexDirection: "column" }}>
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
                  <ChatTurn
                    key={turn.id}
                    by={turn.by}
                    at={turn.at}
                    calls={turn.calls}
                    toolSummary={turn.toolSummary}
                    note={turn.note}
                    approval={
                      turn.approval ? (
                        <ApprovalBubble
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
                    {/* An approval's own turn IS the ask, and the bubble says
                        it. Repeating the body above would print it twice. */}
                    {turn.approval ? null : turn.body}
                  </ChatTurn>
                ))}
                {live ? <Live chat={chat} /> : null}
              </div>
            ) : null}
          </div>
        </div>

        <footer
          style={{
            display: "flex",
            flexDirection: "column",
            padding: "var(--sp-6) var(--sp-10) var(--sp-8)",
            borderTop: "var(--border)",
            background: "var(--surface-panel)",
          }}
        >
          <div style={{ maxWidth: "var(--measure)" }}>
            <Composer
              onSend={chat.send}
              busy={Boolean(live)}
              waiting={Boolean(live?.pending)}
              placeholder="Tell me what to do"
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

/**
 * The turn in flight.
 *
 * Drawn from the stream rather than from the database, and it looks exactly
 * like a stored turn on purpose: when the run finishes, the live copy is
 * dropped and the written one takes its place, and that swap should be
 * invisible.
 */
function Live({ chat }: { chat: ChatState }) {
  const live = chat.live!;
  return (
    <>
      <ChatTurn by="user" at="now">
        {live.asked}
      </ChatTurn>
      <ChatTurn
        by="agent"
        at="now"
        calls={live.calls}
        callsOpen
        note={live.opened.length ? `opened ${live.opened.join(", ")}` : null}
        pending={!live.error}
        approval={
          live.pending ? (
            <ApprovalBubble
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
          <span style={{ font: "var(--text-body-sm)", color: "var(--danger-text)" }}>
            That turn didn't finish — {live.error}
          </span>
        ) : null}
      </ChatTurn>
    </>
  );
}

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
