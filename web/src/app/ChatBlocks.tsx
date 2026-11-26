import { useState } from "react";
import { ApprovalBubble, Badge, ChatTurn, MonoLabel, StatusMark } from "../kit";
import {
  echoed,
  hasActiveTurn,
  liveProse,
  type ChatChoice,
  type ChatState,
  type ChatToolCall,
  type ChatTurnRow,
  type SubagentStatusItem,
} from "./chat";

/** Quiet provenance tag for non-text turns (`voice` or `subagent`). */
export function TurnProvenance({
  source,
  align = "start",
}: {
  source?: "text" | "voice" | "subagent";
  align?: "start" | "end";
}) {
  if (source !== "voice" && source !== "subagent") return null;
  const justifyContent = align === "end" ? "flex-end" : "flex-start";

  if (source === "subagent") {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent, gap: "var(--sp-2)" }}>
        <Badge tone="neutral">Background subagent</Badge>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent, gap: "var(--sp-2)" }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          padding: "2px 6px",
          borderRadius: "var(--radius-control)",
          background: "var(--surface-hover)",
          color: "var(--text-3)",
          font: "var(--text-mono-label)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: "var(--signal-green)",
          }}
        />
        Voice
      </span>
    </div>
  );
}

/** Live tool-call list with per-call running, completed, and failed states. */
export function LiveToolCalls({
  calls,
  touch = false,
}: {
  calls: readonly ChatToolCall[];
  touch?: boolean;
}) {
  const [open, setOpen] = useState(true);
  if (!calls.length) return null;

  const runningCount = calls.filter((c) => c.status === "running").length;
  const line = `${calls.length} tool call${calls.length === 1 ? "" : "s"}${
    runningCount ? ` · ${runningCount} running` : ""
  }`;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-1)",
        padding: "var(--sp-3) var(--sp-4)",
        borderRadius: "var(--radius-control)",
        background: "var(--surface-sunken)",
        font: "var(--text-mono)",
        color: "var(--text-3)",
        maxWidth: touch ? "none" : "56ch",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          all: "unset",
          appearance: "none",
          WebkitAppearance: "none",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-3)",
          font: "inherit",
          color: "inherit",
        }}
      >
        <span style={{ color: "var(--accent)" }}>{open ? "▾" : "▸"}</span>
        {line}
      </button>
      {open
        ? calls.map((c, i) => {
            const status = c.status ?? (c.ok ? "completed" : "failed");
            const markState = status === "running" ? "running" : status === "failed" ? "failed" : "done";
            return (
              <div
                key={c.id ?? `${c.name}-${i}`}
                data-tool-status={status}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--sp-2)",
                  paddingLeft: 18,
                  color: status === "failed" ? "var(--danger-text)" : "var(--text-3)",
                }}
              >
                <StatusMark state={markState} size={9} />
                <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  {c.name}
                  {c.arg ? ` ${c.arg}` : ""}
                  {status === "running" ? (
                    <span style={{ color: "var(--text-4)" }}>{" · running"}</span>
                  ) : c.duration ? (
                    <span style={{ color: status === "failed" ? "var(--danger-text)" : "var(--text-4)" }}>
                      {` · ${c.duration}`}
                    </span>
                  ) : status === "failed" ? (
                    <span style={{ color: "var(--danger-text)" }}>{" · failed"}</span>
                  ) : null}
                </span>
              </div>
            );
          })
        : null}
    </div>
  );
}

/** Quiet live reasoning stream shown above prose when reasoning tokens arrive. */
export function LiveReasoning({ text, touch = false }: { text?: string; touch?: boolean }) {
  if (!text?.trim()) return null;
  return (
    <div
      style={{
        font: "var(--text-mono)",
        color: "var(--text-4)",
        borderLeft: "2px solid var(--line-strong)",
        paddingLeft: "var(--sp-4)",
        marginBottom: "var(--sp-3)",
        maxWidth: touch ? "none" : "56ch",
        whiteSpace: "pre-wrap",
      }}
    >
      {text}
    </div>
  );
}

/** Live summary strip of background subagents attached to this conversation. */
export function ActiveSubagentsBar({
  subagents,
  touch = false,
}: {
  subagents?: readonly SubagentStatusItem[];
  touch?: boolean;
}) {
  if (!subagents?.length) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-3)",
        padding: "var(--sp-4) var(--sp-5)",
        borderRadius: "var(--radius-card)",
        border: "var(--border)",
        background: "var(--surface-sunken)",
        maxWidth: touch ? "none" : "56ch",
      }}
    >
      <MonoLabel>
        {subagents.length === 1 ? "Background subagent" : "Background subagents"}
      </MonoLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
        {subagents.map((sa) => {
          const markState =
            sa.status === "failed" ? "failed" : sa.status === "running" ? "running" : "done";
          return (
            <div
              key={sa.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--sp-3)",
                minWidth: 0,
              }}
            >
              <StatusMark state={markState} size={10} />
              <span
                style={{
                  font: "var(--text-mono)",
                  color: "var(--text-1)",
                  minWidth: 0,
                  overflowWrap: "anywhere",
                }}
              >
                {sa.name}
                {sa.current ? (
                  <span style={{ color: "var(--text-3)" }}>{` · ${sa.current}`}</span>
                ) : null}
              </span>
              <Badge
                tone={sa.status === "running" ? "running" : "neutral"}
                style={{ marginLeft: "auto", flexShrink: 0 }}
              >
                {sa.status}
              </Badge>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Non-blocking deferred approval card requested by a background subagent. */
export function DeferredApprovalCard({
  reference,
  title,
  why,
  hold,
  facts,
  choices,
  settled,
  subagentName,
  touch = false,
  onChoose,
}: {
  reference: string;
  title: string;
  why?: string | null;
  hold?: string | null;
  facts: ReadonlyArray<readonly [string, string]>;
  choices: readonly ChatChoice[];
  settled?: string | null;
  subagentName?: string | null;
  touch?: boolean;
  onChoose: (actionId: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-2)",
        maxWidth: touch ? "none" : "62ch",
      }}
    >
      {subagentName ? (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", flexWrap: "wrap" }}>
          <Badge tone={settled ? "neutral" : "attention"}>Deferred · {subagentName}</Badge>
          {!settled ? (
            <span style={{ font: "var(--text-mono-meta)", color: "var(--text-4)" }}>
              background subagent
            </span>
          ) : null}
        </div>
      ) : null}
      <ApprovalBubble
        touch={touch}
        reference={reference}
        title={title}
        why={why}
        hold={hold}
        facts={facts}
        choices={choices}
        settled={settled}
        onChoose={onChoose}
      />
    </div>
  );
}

/** One persisted turn from SQLite/checkpoints, including provenance and deferred approvals. */
export function StoredTurn({
  turn,
  onAnswer,
  touch = false,
}: {
  turn: ChatTurnRow;
  onAnswer: (actionId: string) => void;
  touch?: boolean;
}) {
  const hasDeferred = Boolean(turn.deferredApprovals?.length);
  const approvalNode =
    turn.approval || hasDeferred ? (
      <>
        {turn.approval ? (
          turn.approval.deferred ? (
            <DeferredApprovalCard
              touch={touch}
              reference={turn.approval.ref}
              title={turn.approval.title}
              why={turn.approval.why}
              hold={turn.approval.hold}
              facts={turn.approval.facts}
              choices={turn.approval.choices}
              settled={turn.approval.settled}
              subagentName={turn.approval.subagentName}
              onChoose={onAnswer}
            />
          ) : (
            <ApprovalBubble
              touch={touch}
              reference={turn.approval.ref}
              title={turn.approval.title}
              why={turn.approval.why}
              hold={turn.approval.hold}
              facts={turn.approval.facts}
              choices={turn.approval.choices}
              settled={turn.approval.settled}
              onChoose={onAnswer}
            />
          )
        ) : null}
        {turn.deferredApprovals?.map((def) => (
          <DeferredApprovalCard
            key={def.decisionId}
            touch={touch}
            reference={def.ref}
            title={def.title}
            why={def.why}
            hold={def.hold}
            facts={def.facts}
            choices={def.choices}
            settled={def.settled}
            subagentName={def.subagentName}
            onChoose={onAnswer}
          />
        ))}
      </>
    ) : null;

  const node = (
    <ChatTurn
      touch={touch}
      by={turn.by}
      at={turn.at}
      calls={turn.calls}
      toolSummary={turn.toolSummary}
      note={turn.note}
      approval={approvalNode}
    >
      {/* An approval's own turn IS the ask, and the bubble says it.
          Repeating the body above would print it twice. */}
      {turn.approval ? null : turn.body}
    </ChatTurn>
  );

  if (turn.source === "voice" || turn.source === "subagent") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
        <TurnProvenance source={turn.source} align={turn.by === "user" ? "end" : "start"} />
        {node}
      </div>
    );
  }

  return node;
}

/**
 * The live slice of a conversation: in-flight streaming turn (user text or
 * async subagent synthesis), running tools, active background subagents, and
 * non-blocking deferred approvals.
 */
export function LiveSection({
  chat,
  touch = false,
}: {
  chat: ChatState;
  touch?: boolean;
}) {
  const live = chat.live;
  if (!live) return null;

  const active = hasActiveTurn(live);
  const showTurn = active || Boolean(live.error);
  const showUserBubble =
    showTurn && live.source !== "subagent" && Boolean(live.asked.trim()) && !echoed(chat);
  const prose = liveProse(live);

  const storedDeferredIds = new Set(
    chat.stored.flatMap((t) => (t.deferredApprovals ?? []).map((d) => d.decisionId)),
  );
  const liveDeferred = (live.deferredApprovals ?? []).filter(
    (d) => !storedDeferredIds.has(d.decisionId),
  );

  const agentTurn = showTurn ? (
    <ChatTurn
      touch={touch}
      by="agent"
      at="now"
      calls={[]}
      note={live.opened.length ? `opened ${live.opened.join(", ")}` : null}
      pending={active}
      approval={
        live.calls.length || live.pending ? (
          <>
            <LiveToolCalls calls={live.calls} touch={touch} />
            {live.pending ? (
              <ApprovalBubble
                touch={touch}
                reference={live.pending.ref}
                title={live.pending.title}
                why={live.pending.why}
                hold={live.pending.hold}
                facts={live.pending.facts}
                choices={live.pending.actions}
                onChoose={chat.answer}
              />
            ) : null}
          </>
        ) : null
      }
    >
      <LiveReasoning text={live.streamingReasoning} touch={touch} />
      {prose}
      {live.error ? (
        <span
          style={{
            font: touch ? "var(--text-phone-note)" : "var(--text-body-sm)",
            color: "var(--danger-text)",
          }}
        >
          That turn didn't finish — {live.error}
        </span>
      ) : null}
    </ChatTurn>
  ) : null;

  return (
    <>
      {showUserBubble ? (
        <ChatTurn touch={touch} by="user" at="now">
          {live.asked}
        </ChatTurn>
      ) : null}

      {agentTurn ? (
        live.source === "subagent" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
            <TurnProvenance source="subagent" />
            {agentTurn}
          </div>
        ) : (
          agentTurn
        )
      ) : null}

      <ActiveSubagentsBar subagents={live.activeSubagents} touch={touch} />

      {liveDeferred.map((def) => (
        <DeferredApprovalCard
          key={def.decisionId}
          touch={touch}
          reference={def.ref}
          title={def.title}
          why={def.why}
          hold={def.hold}
          facts={def.facts}
          choices={def.actions}
          subagentName={def.subagentName}
          onChoose={chat.answer}
        />
      ))}
    </>
  );
}
