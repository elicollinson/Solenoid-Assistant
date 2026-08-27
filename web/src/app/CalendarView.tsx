import { useState } from "react";
import { CalendarEvent, Chip, TimeGrid } from "../kit";
import type { CalendarItem, CalendarKind, CalendarPayload } from "./api";

const MODES = ["Week", "Day"] as const;
type Mode = (typeof MODES)[number];

/** What each kind is called under the swatches. Plural, because the legend is
 *  about the canvas rather than about one block on it. */
const LEGEND_LABEL: Record<CalendarKind, string> = {
  event: "yours",
  run: "my runs",
  reminder: "reminders",
  hold: "held",
};

/* The same four planes CalendarEvent draws, at swatch size. Told apart by
   plane and rule rather than by colour alone: the run and the reminder both
   carry a signal hue, and the difference between them is where it sits. */
const SWATCH: Record<CalendarKind, React.CSSProperties> = {
  event: { width: 16, height: 10, background: "var(--surface-raised)", border: "1px solid var(--line-strong)", borderRadius: 2 },
  run: {
    width: 16,
    height: 10,
    background: "color-mix(in oklab, var(--signal-green) 13%, var(--surface-panel))",
    borderLeft: "3px solid var(--signal-green)",
    borderRadius: 2,
  },
  reminder: {
    width: 16,
    height: 8,
    background: "color-mix(in oklab, var(--signal-amber) 10%, var(--surface-panel))",
    borderTop: "2px solid var(--signal-amber)",
  },
  hold: { width: 16, height: 10, border: "1px dashed var(--line-strong)", borderRadius: 2 },
};

const LABEL = {
  font: "var(--text-mono-label)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--text-4)",
} as const;

export function CalendarView({
  calendar,
  selected,
  detailOpen,
  onOpen,
}: {
  calendar: CalendarPayload;
  /** What is open in the aside, so the block can say so too. */
  selected: string | null;
  /** The aside takes the third column when there is something in it, and the
   *  canvas gives it up rather than scrolling underneath. */
  detailOpen: boolean;
  onOpen: (id: string | null) => void;
}) {
  const [mode, setMode] = useState<Mode>("Week");
  const [day, setDay] = useState("d0");

  const days = mode === "Week" ? calendar.days : calendar.days.filter((d) => d.key === day);
  const items = calendar.items.filter((item) => days.some((d) => d.key === item.day));
  const shown = calendar.days.find((d) => d.key === day);

  return (
    <main
      style={{
        gridColumn: detailOpen ? "2" : "2 / span 2",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
      }}
    >
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
          <h1 style={{ margin: 0, font: "var(--text-display)", letterSpacing: "var(--tracking-display)", color: "var(--text-1)" }}>
            Calendar
          </h1>
          <p style={{ margin: 0, font: "var(--text-body)", color: "var(--text-3)", maxWidth: "var(--measure)", textWrap: "pretty" }}>
            {calendar.lede}
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--sp-4)", flexShrink: 0 }}>
          <span style={{ font: "var(--text-mono)", color: "var(--text-4)", whiteSpace: "nowrap" }}>{calendar.range}</span>
          <div style={{ display: "flex", gap: "var(--sp-2)" }}>
            {MODES.map((m) => (
              <Chip key={m} selected={mode === m} onClick={() => setMode(m)}>
                {m}
              </Chip>
            ))}
          </div>
        </div>
      </header>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--sp-6)",
          padding: "var(--sp-5) var(--sp-10)",
          borderBottom: "var(--border)",
        }}
      >
        <Legend />
        {mode === "Day" && shown ? (
          <span style={{ display: "flex", gap: "var(--sp-6)", font: "var(--text-mono)", color: "var(--text-4)" }}>
            {shown.counts.map((c) => (
              <span key={c.label} style={{ whiteSpace: "nowrap" }}>
                {c.label.toLowerCase()} <span style={{ color: "var(--text-2)" }}>{c.value}</span>
              </span>
            ))}
          </span>
        ) : null}
      </div>

      {mode === "Day" ? (
        <div style={{ display: "flex", gap: "var(--sp-3)", padding: "var(--sp-5) var(--sp-10) 0", flexWrap: "wrap" }}>
          {calendar.days.map((d) => (
            <Chip key={d.key} selected={day === d.key} onClick={() => setDay(d.key)}>
              {d.label} {d.date}
            </Chip>
          ))}
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "var(--sp-3) var(--sp-10) var(--sp-10)" }}>
        <TimeGrid
          days={days}
          items={items}
          now={calendar.now}
          startHour={calendar.startHour}
          endHour={calendar.endHour}
          pxPerHour={mode === "Day" ? 58 : 46}
          // A day header in week mode is the way into that day. In day mode you
          // are already there, and it would do nothing.
          onSelectDay={
            mode === "Week"
              ? (key) => {
                  setDay(key);
                  setMode("Day");
                }
              : undefined
          }
          renderItem={(item, geo) => (
            <CalendarEvent
              kind={item.kind}
              state={item.state ?? undefined}
              title={item.title}
              meta={item.meta}
              tall={fitsTwoLines(geo, mode)}
              selected={selected === item.id}
              // Clicking the open one closes it, so the canvas comes back
              // without having to find the close button first.
              onClick={() => onOpen(selected === item.id ? null : item.id)}
            />
          )}
        />
        {mode === "Day" && shown?.restraint ? (
          <p
            style={{
              margin: "var(--sp-7) 0 0",
              font: "var(--text-body-sm)",
              color: "var(--text-3)",
              maxWidth: "var(--measure)",
              textWrap: "pretty",
            }}
          >
            {shown.restraint}
          </p>
        ) : null}
      </div>
    </main>
  );
}

/**
 * Whether the second line fits.
 *
 * Forty pixels is two lines of type. The extra clause is for a block sharing
 * its day with another: half the width leaves the mono line nowhere to go, so
 * below fifty-six pixels it is the title alone.
 */
function fitsTwoLines(geo: { height: number; narrow: boolean }, mode: Mode): boolean {
  if (geo.height < 40) return false;
  return !(geo.narrow && mode === "Week" && geo.height < 56);
}

function Legend() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-6)" }}>
      {(Object.keys(SWATCH) as CalendarKind[]).map((kind) => (
        <span key={kind} style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)", whiteSpace: "nowrap" }}>
          <span style={{ flex: "0 0 auto", ...SWATCH[kind] }} />
          <span style={LABEL}>{LEGEND_LABEL[kind]}</span>
        </span>
      ))}
    </div>
  );
}

export type { CalendarItem };
