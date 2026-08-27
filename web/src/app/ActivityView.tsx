import { useState } from "react";
import { ActivityItem, Button, Chip, Meter, SectionRule, ToolCalls } from "../kit";
import type { HomeAction, HomeFeedItem, HomePayload, HomeState } from "./api";

const FILTERS = ["All", "Needs you", "Running"] as const;
type Filter = (typeof FILTERS)[number];

const MATCHES: Record<Filter, (state: HomeState) => boolean> = {
  All: () => true,
  "Needs you": (state) => state === "attention",
  Running: (state) => state === "running",
};

const STANCE_TO_VARIANT: Record<HomeAction["stance"], "affirm" | "quiet" | "bare" | "danger"> = {
  affirm: "affirm",
  neutral: "quiet",
  quiet: "quiet",
  bare: "bare",
  danger: "danger",
};

const PROSE = {
  margin: 0,
  font: "var(--text-body)",
  color: "var(--text-2)",
  textWrap: "pretty",
  maxWidth: "var(--measure)",
} as const;

/* An action that resolves a decision reads as a button; one that is a plain
   affordance reads as a mono link. That is the actions table's own distinction,
   not a styling choice: a button commits, a link only navigates. */
function LinkRow({ actions, onInvoke }: { actions: HomeFeedItem["actions"]; onInvoke: (a: HomeAction) => void }) {
  return (
    <div style={{ display: "flex", gap: "var(--sp-6)", font: "var(--text-mono-control)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
      {actions.map((a, i) => (
        <a
          key={a.id}
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onInvoke(a);
          }}
          style={{ color: a.stance === "danger" ? "var(--danger-text)" : i === 0 ? "var(--accent-quiet)" : "var(--text-3)" }}
        >
          {a.label}
        </a>
      ))}
    </div>
  );
}

export function ActivityView({
  header,
  sections,
  resolved,
  onInvoke,
}: {
  header: HomePayload["header"];
  sections: HomePayload["sections"];
  resolved: ReadonlySet<string>;
  onInvoke: (action: HomeAction) => void;
}) {
  const [filter, setFilter] = useState<Filter>("All");
  const matches = MATCHES[filter];

  const visible = sections
    .map((section) => ({
      label: section.label,
      items: section.items.filter((item) => matches(effectiveState(item, resolved))),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <main style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <header
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: "var(--sp-9)",
          padding: "var(--sp-9) var(--sp-10) 18px",
          borderBottom: "var(--border)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
          <h1 style={{ margin: 0, font: "var(--text-display)", letterSpacing: "var(--tracking-display)", color: "var(--text-1)" }}>
            {header.greeting}
          </h1>
          <p style={{ margin: 0, font: "var(--text-body)", color: "var(--text-3)" }}>{header.lede}</p>
        </div>
        <div style={{ display: "flex", gap: "var(--sp-2)", flexShrink: 0 }}>
          {FILTERS.map((f) => (
            <Chip key={f} selected={filter === f} onClick={() => setFilter(f)}>
              {f}
            </Chip>
          ))}
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", padding: "0 var(--sp-10) var(--sp-10)" }}>
        {visible.length === 0 ? (
          // Two different empties, and only one of them is about the filter:
          // a feed with nothing in it at all is a new database or a pruned one,
          // and telling someone to try another filter would send them looking
          // for entries that do not exist under any of them.
          <p style={{ ...PROSE, paddingTop: "var(--sp-9)", color: "var(--text-3)" }}>
            {sections.length === 0
              ? "Nothing has happened yet. This fills in as I run things for you."
              : "Nothing here under that filter."}
          </p>
        ) : (
          visible.map((section) => (
            <div key={section.label} style={{ display: "flex", flexDirection: "column" }}>
              <SectionRule label={section.label} />
              {section.items.map((item, i) => (
                <FeedEntry
                  key={item.id}
                  item={item}
                  resolved={item.decisionId != null && resolved.has(item.decisionId)}
                  onInvoke={onInvoke}
                  style={i === 0 ? undefined : { marginTop: "var(--sp-6)" }}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </main>
  );
}

/** A locally resolved gate reads as done, exactly as it does in the design. */
function effectiveState(item: HomeFeedItem, resolved: ReadonlySet<string>): HomeState {
  return item.decisionId && resolved.has(item.decisionId) ? "done" : item.state;
}

function FeedEntry({
  item,
  resolved,
  onInvoke,
  style,
}: {
  item: HomeFeedItem;
  resolved: boolean;
  onInvoke: (a: HomeAction) => void;
  style?: React.CSSProperties;
}) {
  const state = resolved ? "done" : item.state;
  const gate = item.decisionId != null;

  const footer = resolved ? (
    // Nothing writes yet, so say so in mono rather than claiming the send.
    <span style={{ font: "var(--text-mono)", color: "var(--text-3)" }}>resolved locally · no write path yet</span>
  ) : item.actions.length === 0 ? null : gate ? (
    <>
      {item.actions.map((a) => (
        <Button key={a.id} variant={STANCE_TO_VARIANT[a.stance]} onClick={() => onInvoke(a)}>
          {a.label}
        </Button>
      ))}
    </>
  ) : (
    <LinkRow actions={item.actions} onInvoke={onInvoke} />
  );

  return (
    <ActivityItem
      state={state}
      title={item.title}
      badge={resolved ? null : item.badge}
      time={item.time}
      framed={item.framed}
      footer={footer}
      style={style}
    >
      <>
        {item.account ? <p style={PROSE}>{item.account}</p> : null}
        {item.progress ? <Meter value={item.progress.value} total={item.progress.total} /> : null}
        {/* The strip appears only when the agent wrote a line for it. Every run
            carries tool calls — the workflow's trace is the place to read them
            all — but the feed shows them under a summary or not at all. */}
        {item.toolSummary ? <ToolCalls summary={item.toolSummary} calls={item.toolCalls} /> : null}
      </>
    </ActivityItem>
  );
}
