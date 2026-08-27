import { useState } from "react";
import { Badge, Button, Chip, SectionRule, StatusMark } from "../kit";
import { recount, spell } from "./lede";
import type { HomeAction, HomeState, RecommendationGroup, RecommendationRow, RecommendationsPayload } from "./api";

const FILTERS = ["All", "Waiting on you", "Standing", "Set aside"] as const;
type Filter = (typeof FILTERS)[number];

/** The order the server shelves them in, kept here so a shelf with nothing on
 *  it draws no heading rather than an empty one. */
const GROUPS: readonly RecommendationGroup[] = ["Waiting on you", "Standing", "Set aside"];

/** What the mark means on this surface. A suggestion is not "done" — it is in
 *  force, which is a thing that keeps happening. */
export const LABELS: Record<HomeState, string> = {
  attention: "needs you",
  running: "applying",
  done: "in force",
  idle: "set aside",
  failed: "dropped",
};

/* Status · title and blurb · what it rests on · when · the two words.
   Wider than the design's last column by 28px, taken off the title: the agent
   writes its own affirm labels and "Hand me the thread instead" does not fit
   in 208. */
const COLS = "26px 1fr 168px 116px 236px";

const CONTROL = {
  font: "var(--text-mono-control)",
  letterSpacing: "var(--tracking-control)",
  textTransform: "uppercase",
} as const;

/** What a suggestion was answered as in the browser. Nothing writes yet. */
export type LocalStance = "adopted" | "declined";

/**
 * An answer given here reads through the whole row, exactly as a written one
 * would: it moves off "Waiting on you", loses its buttons, and says what just
 * happened rather than keeping the line that argued for it.
 */
export function withLocalStance(row: RecommendationRow, stances: ReadonlyMap<string, LocalStance>): RecommendationRow {
  const stance = stances.get(row.id);
  if (!stance) return row;
  if (stance === "adopted") {
    return {
      ...row,
      state: "done",
      group: "Standing",
      when: "Just now",
      blurb: "You took this just now. I'll hold to it from the next run and say so when it first applies.",
      actions: [],
    };
  }
  return {
    ...row,
    state: "idle",
    group: "Set aside",
    when: "Just now",
    blurb: "You said no. I've set it aside and won't raise it again unless what I'm seeing changes.",
    actions: [],
  };
}

/** How many are yours to answer, said the way the server said it. */
function waitingClause(rows: readonly RecommendationRow[]): string {
  const open = rows.filter((row) => row.group === "Waiting on you").length;
  if (open === 0) return "Nothing is waiting on you right now.";
  if (open === 1) return "One is waiting on you, and I haven't acted on it.";
  return `${spell(open)} are waiting on you, and I haven't acted on any of them.`;
}

export function RecommendationsView({
  recommendations,
  stances,
  onAnswer,
  onOpen,
}: {
  recommendations: RecommendationsPayload;
  /** Suggestions answered in the browser this session. */
  stances: ReadonlyMap<string, LocalStance>;
  /** The action carries the words you answered with, so the aside's copy of
   *  this suggestion stops asking too. `wasOpen` says whether the rail was
   *  counting it, so the rail can stop. */
  onAnswer: (id: string, stance: LocalStance, wasOpen: boolean, action: HomeAction) => void;
  onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("All");
  const all = recommendations.rows.map((row) => withLocalStance(row, stances));
  const rows = all.filter((row) => filter === "All" || row.group === filter);
  // The chip narrows what is drawn; the sentence is about the whole list.
  const lede =
    stances.size === 0
      ? recommendations.lede
      : recount(recommendations.lede, waitingClause(all));

  return (
    <main style={{ gridColumn: "2 / span 2", display: "flex", flexDirection: "column", minHeight: 0 }}>
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
            Recommendations
          </h1>
          <p style={{ margin: 0, font: "var(--text-body)", color: "var(--text-3)", maxWidth: "var(--measure)", textWrap: "pretty" }}>
            {lede}
          </p>
        </div>
        <div style={{ display: "flex", gap: "var(--sp-2)", flexShrink: 0 }}>
          {FILTERS.map((f) => (
            <Chip key={f} selected={filter === f} onClick={() => setFilter(f)}>
              {f}
            </Chip>
          ))}
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 var(--sp-10) var(--sp-10)" }}>
        {rows.length === 0 ? (
          <p style={{ margin: 0, padding: "var(--sp-9) var(--sp-3)", font: "var(--text-body)", color: "var(--text-3)" }}>
            Nothing here under that filter.
          </p>
        ) : (
          GROUPS.map((group) => {
            const onShelf = rows.filter((row) => row.group === group);
            if (onShelf.length === 0) return null;
            return (
              <div key={group} style={{ display: "flex", flexDirection: "column" }}>
                <SectionRule label={group} />
                {onShelf.map((row) => (
                  <Row
                    key={row.id}
                    row={row}
                    onOpen={() => onOpen(row.id)}
                    onAnswer={(stance, action) => onAnswer(row.id, stance, row.group === "Waiting on you", action)}
                  />
                ))}
              </div>
            );
          })
        )}
      </div>
    </main>
  );
}

function Row({
  row,
  onOpen,
  onAnswer,
}: {
  row: RecommendationRow;
  onOpen: () => void;
  onAnswer: (stance: LocalStance, action: HomeAction) => void;
}) {
  const [hover, setHover] = useState(false);
  const settled = row.state !== "attention";
  const [affirm, quiet] = row.actions;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        cursor: "pointer",
        boxSizing: "border-box",
        display: "grid",
        gridTemplateColumns: COLS,
        gap: "var(--sp-6)",
        alignItems: "start",
        padding: "var(--sp-6) var(--sp-3)",
        borderTop: "var(--border)",
        background: hover && !settled ? "var(--surface-hover)" : "transparent",
        // Something you turned down stays readable and stops competing.
        opacity: row.state === "idle" ? 0.6 : 1,
        transition: "background var(--dur) var(--ease)",
      }}
    >
      <StatusMark state={row.state} style={{ marginTop: 4 }} />
      <span style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)", font: "var(--text-title)", color: "var(--text-1)" }}>
          {row.title}
          {row.state === "attention" ? (
            <Badge tone="attention" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
              needs you
            </Badge>
          ) : null}
        </span>
        <span
          style={{
            font: "var(--text-body-sm)",
            color: "var(--text-3)",
            maxWidth: "var(--measure)",
            textWrap: "pretty",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {row.blurb}
        </span>
      </span>
      <span style={{ font: "var(--text-mono)", color: "var(--text-4)", paddingTop: 2 }}>{row.basis}</span>
      <span style={{ font: "var(--text-mono)", color: "var(--text-3)", paddingTop: 2 }}>{row.when}</span>
      <span style={{ display: "flex", justifyContent: "flex-end", gap: "var(--sp-3)", paddingTop: 1 }}>
        {settled || !affirm ? (
          <span style={{ ...CONTROL, color: "var(--text-4)" }}>{LABELS[row.state]}</span>
        ) : (
          <>
            {/* The affirm carries the specific thing you would be agreeing to,
                so it keeps the agent's own words. The quiet answer is always
                the same act, and its own phrasing — "Keep asking me", "Leave
                the schedule" — says what I would do instead, which is a
                sentence rather than a label. It gets said in the detail, where
                there is a line to say it on. */}
            <Button
              variant="affirm"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                onAnswer("adopted", affirm);
              }}
            >
              {affirm.label}
            </Button>
            {quiet ? (
              <Button
                variant="bare"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  onAnswer("declined", quiet);
                }}
                style={{ ...CONTROL, padding: 0 }}
              >
                No
              </Button>
            ) : null}
          </>
        )}
      </span>
    </div>
  );
}
