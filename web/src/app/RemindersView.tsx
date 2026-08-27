import { useState } from "react";
import { Badge, Button, Chip, SectionRule, StatusMark } from "../kit";
import { recount, spell } from "./lede";
import type { ReminderGroup, ReminderRow, RemindersPayload } from "./api";

const FILTERS = ["All", "Needs you", "Done"] as const;
type Filter = (typeof FILTERS)[number];

const MATCHES: Record<Filter, (row: ReminderRow) => boolean> = {
  All: () => true,
  "Needs you": (row) => row.state === "attention",
  Done: (row) => row.state === "done",
};

/** The order the server buckets them in, kept here so a group with no rows
 *  draws no heading rather than an empty one. */
const GROUPS: readonly ReminderGroup[] = ["Overdue", "Today", "This week", "Later", "Someday", "Closed"];

/* Status · title and note · source · when · the controls. */
const COLS = "26px 1fr 210px 132px 150px";

const CONTROL = {
  font: "var(--text-mono-control)",
  letterSpacing: "var(--tracking-control)",
  textTransform: "uppercase",
} as const;

/** What a reminder was locally marked as. Nothing writes yet. */
export type LocalMark = "done" | "later";

/**
 * A local mark reads through the whole row, exactly as a written one would:
 * closing it moves it to Closed and greys it, pushing it drops the date and
 * moves it to Someday. Both replace the note, because the old one explained a
 * date that no longer applies.
 */
export function withLocalMark(row: ReminderRow, marks: ReadonlyMap<string, LocalMark>): ReminderRow {
  const mark = marks.get(row.id);
  if (!mark) return row;
  if (mark === "done") {
    return { ...row, state: "done", group: "Closed", when: "Just now", note: "You closed this out, so I stopped tracking it.", gated: false };
  }
  return { ...row, state: "idle", group: "Someday", when: "In a week", note: "Pushed a week. I'll raise it again then and not before.", gated: false };
}

/**
 * How late you are, said the way the server said it. Closing an overdue one
 * here takes it off this count, which is the whole point: the sentence would
 * otherwise keep insisting on something the list below it no longer shows.
 */
function overdueClause(rows: readonly ReminderRow[]): string {
  const late = rows.filter((row) => row.group === "Overdue").length;
  if (late === 0) return "Nothing is overdue.";
  if (late === 1) return "One of them is past when you asked to hear about it.";
  return `${spell(late)} of them are past when you asked to hear about them.`;
}

export function RemindersView({
  reminders,
  marks,
  onMark,
  onOpen,
}: {
  reminders: RemindersPayload;
  /** Reminders closed or pushed in the browser this session. */
  marks: ReadonlyMap<string, LocalMark>;
  /** `wasDue` says whether the rail was counting it, so the rail can stop. */
  onMark: (id: string, mark: LocalMark, wasDue: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("All");
  const all = reminders.rows.map((row) => withLocalMark(row, marks));
  const rows = all.filter(MATCHES[filter]);
  // The chip narrows what is drawn; the sentence is about the whole list.
  const lede = marks.size === 0 ? reminders.lede : recount(reminders.lede, overdueClause(all));

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
            Reminders
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
            const inGroup = rows.filter((row) => row.group === group);
            if (inGroup.length === 0) return null;
            return (
              <div key={group} style={{ display: "flex", flexDirection: "column" }}>
                <SectionRule label={group} />
                {inGroup.map((row) => (
                  <Row
                    key={row.id}
                    row={row}
                    onOpen={() => onOpen(row.id)}
                    onMark={(mark) => onMark(row.id, mark, row.group === "Overdue" || row.group === "Today")}
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

function Row({ row, onOpen, onMark }: { row: ReminderRow; onOpen: () => void; onMark: (mark: LocalMark) => void }) {
  const [hover, setHover] = useState(false);
  const closed = row.state === "done";

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
        background: hover && !closed ? "var(--surface-hover)" : "transparent",
        opacity: closed ? 0.6 : 1,
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
          {row.note}
        </span>
      </span>
      <span style={{ font: "var(--text-mono)", color: "var(--text-4)", paddingTop: 2 }}>{row.source}</span>
      <span style={{ font: "var(--text-mono)", color: "var(--text-3)", paddingTop: 2 }}>{row.when}</span>
      <span style={{ display: "flex", justifyContent: "flex-end", gap: "var(--sp-5)", paddingTop: 1 }}>
        {closed ? (
          <span style={{ ...CONTROL, color: "var(--text-4)" }}>Closed</span>
        ) : (
          <>
            <Button
              variant="bare"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                onMark("done");
              }}
              style={{ ...CONTROL, padding: 0 }}
            >
              Done
            </Button>
            <Button
              variant="bare"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                onMark("later");
              }}
              style={{ ...CONTROL, padding: 0 }}
            >
              Later
            </Button>
          </>
        )}
      </span>
    </div>
  );
}
