import { useState, type CSSProperties, type ReactNode } from "react";

/* A week (or single day) canvas. Draws day headers, two-hourly hairlines and a
   now-line, packs overlapping items into lanes, and positions whatever
   renderItem returns. It owns geometry only — never the look of an item. */

export interface TimeGridDay {
  key: string;
  label: string;
  date: string;
  today?: boolean;
}

export interface TimeGridItem {
  id: string;
  day: string;
  /** "HH:MM", local to the day column. */
  start: string;
  end: string;
  kind?: string;
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

interface Packed<T extends TimeGridItem> {
  item: T;
  lane: number;
  lanes: number;
}

/** Pack overlapping items into side-by-side lanes, one cluster at a time. */
function lanes<T extends TimeGridItem>(items: readonly T[]): Packed<T>[] {
  const sorted = items.slice().sort((a, b) => toMin(a.start) - toMin(b.start));
  const out: Packed<T>[] = [];
  let cluster: { item: T; lane: number }[] = [];
  let clusterEnd = -1;

  const flush = () => {
    const n = cluster.reduce((m, c) => Math.max(m, c.lane + 1), 0);
    for (const c of cluster) out.push({ ...c, lanes: n });
    cluster = [];
    clusterEnd = -1;
  };

  for (const it of sorted) {
    const s = toMin(it.start);
    const e = toMin(it.end);
    if (cluster.length && s >= clusterEnd) flush();
    const taken = cluster.filter((c) => toMin(c.item.end) > s).map((c) => c.lane);
    let lane = 0;
    while (taken.includes(lane)) lane += 1;
    cluster.push({ item: it, lane });
    clusterEnd = Math.max(clusterEnd, e);
  }
  if (cluster.length) flush();
  return out;
}

export function TimeGrid<T extends TimeGridItem>({
  days = [],
  items = [],
  startHour = 6,
  endHour = 22,
  pxPerHour = 46,
  step = 2,
  now = null,
  onSelectDay,
  renderItem,
}: {
  days?: readonly TimeGridDay[];
  items?: readonly T[];
  startHour?: number;
  endHour?: number;
  pxPerHour?: number;
  step?: number;
  /** Minutes past midnight, drawn only on the day marked `today`. */
  now?: number | null;
  onSelectDay?: (key: string) => void;
  renderItem: (item: T, ctx: { height: number; narrow: boolean }) => ReactNode;
}) {
  const top = (m: number) => ((m - startHour * 60) / 60) * pxPerHour;
  const height = (endHour - startHour) * pxPerHour;
  const marks: number[] = [];
  for (let h = startHour; h <= endHour; h += step) marks.push(h);

  return (
    <div style={{ display: "grid", gridTemplateColumns: `48px repeat(${days.length}, 1fr)`, alignItems: "start" }}>
      <div style={{ position: "sticky", top: 0, zIndex: 3, height: 46, background: "var(--surface-app)", borderBottom: "var(--border)" }} />
      {days.map((d) => (
        <DayHead key={d.key} d={d} onClick={onSelectDay ? () => onSelectDay(d.key) : null} />
      ))}

      <div style={{ position: "relative", height, borderRight: "var(--border)" }}>
        {/* The design drops the last mark, which is the one sitting on the
            canvas edge with no room under it. Said as a comparison rather than
            as "the last one" so that a canvas ending between two marks still
            labels the mark above the edge. Same output for the design's own
            06:00–22:00. */}
        {marks
          .filter((h) => h < endHour)
          .map((h) => (
            <span
              key={h}
              style={{ position: "absolute", top: top(h * 60) - 5, right: "var(--sp-4)", font: "var(--text-mono-label)", color: "var(--text-4)" }}
            >
              {String(h).padStart(2, "0")}
            </span>
          ))}
      </div>

      {days.map((d) => {
        const packed = lanes(items.filter((i) => i.day === d.key));
        return (
          <div
            key={d.key}
            style={{ position: "relative", height, borderRight: "var(--border)", background: d.today ? "var(--surface-panel)" : "transparent" }}
          >
            {marks.map((h) => (
              <span key={h} style={{ position: "absolute", left: 0, right: 0, top: top(h * 60), borderTop: "1px solid var(--line-hair)" }} />
            ))}

            {packed.map(({ item, lane, lanes: n }) => {
              const t = top(toMin(item.start));
              const h = Math.max(item.kind === "reminder" ? 19 : 26, top(toMin(item.end)) - t);
              return (
                <div
                  key={item.id}
                  style={{
                    position: "absolute",
                    top: t,
                    height: h,
                    left: `calc(${(lane / n) * 100}% + 2px)`,
                    width: `calc(${(1 / n) * 100}% - 5px)`,
                    zIndex: 2,
                  }}
                >
                  {renderItem(item, { height: h, narrow: n > 1 })}
                </div>
              );
            })}

            {now != null && d.today ? (
              <span style={{ position: "absolute", left: -3, right: 0, top: top(now), borderTop: "1px solid var(--accent)", zIndex: 4 }}>
                <span style={{ position: "absolute", left: 0, top: -3, width: 5, height: 5, borderRadius: "50%", background: "var(--accent)" }} />
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function DayHead({ d, onClick }: { d: TimeGridDay; onClick: (() => void) | null }) {
  const [hover, setHover] = useState(false);
  const style: CSSProperties = {
    all: "unset",
    position: "sticky",
    top: 0,
    zIndex: 3,
    boxSizing: "border-box",
    height: 46,
    display: "flex",
    alignItems: "baseline",
    gap: "var(--sp-3)",
    padding: "0 var(--sp-4)",
    cursor: onClick ? "pointer" : "default",
    background: hover && onClick ? "var(--surface-hover)" : d.today ? "var(--surface-panel)" : "var(--surface-app)",
    borderBottom: "var(--border)",
    borderRight: "var(--border)",
    transition: "background var(--dur) var(--ease)",
  };
  return (
    <button type="button" onClick={onClick ?? undefined} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={style}>
      <span style={{ font: "var(--text-mono-label)", letterSpacing: "var(--tracking-label)", textTransform: "uppercase", color: "var(--text-4)" }}>
        {d.label}
      </span>
      <span style={{ font: "var(--text-mono)", color: d.today ? "var(--accent)" : "var(--text-3)" }}>{d.date}</span>
    </button>
  );
}
