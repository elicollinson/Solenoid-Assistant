// Workflows at 390px.
//
// The desktop draws a table and filters it. The cadence, last-run and step
// columns do not survive the width, so a row keeps the name, one line from me,
// and the machine facts on a second line; everything else waits behind a tap.
//
// That one line is written rather than derived — `WorkflowRow.lede`, served
// only to the phone. Shortening the desktop's summary by machine is how a
// workflow ends up claiming something it did not do.
//
// The list also groups where the desktop only filters. At this width the five
// filters are a horizontal scroll you have to reach for, and the thing you
// opened the screen to find — what is waiting on you — should be at the top
// without being asked for.
import { useState } from "react";
import { Badge, Button, Chip, Meter, MonoLabel, SectionRule, Sheet, StatusMark } from "../../kit";
import type { HomeAction, HomeState, Load, WorkflowDetailPayload, WorkflowRow, WorkflowsPayload } from "../api";
import { PhoneBody, PhoneRestraint, PhoneTitle } from "./chrome";

const FILTERS = ["All", "Needs you", "Running", "Scheduled", "Paused"] as const;
type Filter = (typeof FILTERS)[number];

/** The order the phone groups them in: what wants you, then what is moving,
 *  then what stopped, then what is quiet. Same urgency the server sorts by. */
const GROUPS: readonly (readonly [HomeState, string])[] = [
  ["attention", "Waiting on you"],
  ["running", "Going now"],
  ["failed", "Stopped"],
  ["done", "Ran, nothing needed"],
  ["idle", "Paused by you"],
];

const SHEET_LABEL: Record<HomeState, string> = {
  attention: "needs you",
  running: "running",
  failed: "halted",
  done: "done",
  idle: "paused workflow",
};

const MONO_META = { font: "var(--text-mono-meta)", color: "var(--text-4)" } as const;

function matches(row: WorkflowRow, filter: Filter, paused: boolean): boolean {
  if (filter === "All") return true;
  if (filter === "Needs you") return !paused && row.state === "attention";
  if (filter === "Running") return !paused && row.state === "running";
  if (filter === "Scheduled") return !paused && row.scheduled;
  return paused;
}

export function WorkflowsPhone({
  workflows,
  detail,
  openSlug,
  onOpen,
  pausedLocally,
  onTogglePause,
  onInvoke,
}: {
  workflows: WorkflowsPayload;
  detail: Load<WorkflowDetailPayload>;
  openSlug: string | null;
  onOpen: (slug: string | null) => void;
  pausedLocally: ReadonlySet<string>;
  onTogglePause: (slug: string) => void;
  onInvoke: (action: HomeAction) => void;
}) {
  const [filter, setFilter] = useState<Filter>("All");

  // A pause taken here has not reached the database, so the row's own `paused`
  // is the server's answer and this is what is no longer true about it.
  const isPaused = (row: WorkflowRow) => (pausedLocally.has(row.slug) ? !row.paused : row.paused);
  const shown = workflows.rows.filter((row) => matches(row, filter, isPaused(row)));
  const open = openSlug ? workflows.rows.find((r) => r.slug === openSlug) : undefined;

  return (
    <>
      <PhoneTitle title="Workflows" lede={workflows.lede} />

      <div style={{ display: "flex", gap: "var(--sp-2)", padding: "0 var(--gutter-phone) var(--sp-6)", overflowX: "auto", flexShrink: 0 }}>
        {FILTERS.map((label) => (
          <Chip
            key={label}
            selected={filter === label}
            onClick={() => {
              setFilter(label);
              onOpen(null);
            }}
            style={{ flexShrink: 0, minHeight: 34 }}
          >
            {label}
          </Chip>
        ))}
      </div>

      <PhoneBody style={{ borderTop: "var(--border)", background: "var(--surface-panel)" }}>
        {GROUPS.map(([state, label]) => {
          const rows = shown.filter((row) => (isPaused(row) ? "idle" : row.state) === state);
          if (!rows.length) return null;
          return (
            <div key={state}>
              <SectionRule label={label} style={{ padding: "var(--sp-7) 0 var(--sp-4)" }} />
              {rows.map((row) => (
                <Row key={row.slug} row={row} paused={isPaused(row)} onOpen={() => onOpen(row.slug)} />
              ))}
            </div>
          );
        })}
        {shown.length === 0 ? (
          <p style={{ margin: "var(--sp-9) 0 0", font: "var(--text-phone-body)", color: "var(--text-3)", textWrap: "pretty" }}>
            Nothing under {filter.toLowerCase()}.
          </p>
        ) : null}
        <PhoneRestraint>{workflows.restraint}</PhoneRestraint>
      </PhoneBody>

      {open ? (
        <Detail
          row={open}
          paused={isPaused(open)}
          detail={detail}
          onClose={() => onOpen(null)}
          onTogglePause={() => onTogglePause(open.slug)}
          onInvoke={onInvoke}
        />
      ) : null}
    </>
  );
}

function Row({ row, paused, onOpen }: { row: WorkflowRow; paused: boolean; onOpen: () => void }) {
  const [press, setPress] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      onPointerDown={() => setPress(true)}
      onPointerUp={() => setPress(false)}
      onPointerLeave={() => setPress(false)}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        display: "grid",
        gridTemplateColumns: "18px 1fr",
        gap: "var(--sp-5)",
        alignItems: "start",
        width: "auto",
        minHeight: "var(--touch)",
        padding: "var(--sp-6) var(--gutter-phone)",
        // The row bleeds to the edge of the phone; the gutter its parent
        // supplies is put back as padding so nothing is inset twice.
        margin: "0 calc(-1 * var(--gutter-phone))",
        borderTop: "var(--border)",
        background: press ? "var(--surface-hover)" : "transparent",
        opacity: paused ? 0.62 : 1,
        transition: "background var(--dur) var(--ease)",
      }}
    >
      <StatusMark state={paused ? "idle" : row.state} size={11} style={{ marginTop: 5 }} />
      <span style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)", font: "var(--text-phone-head)", color: "var(--text-1)" }}>
          {row.name}
          {!paused && row.state === "attention" ? (
            <Badge tone="attention" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
              needs you
            </Badge>
          ) : null}
          {!paused && row.state === "running" ? (
            <Badge tone="running" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
              running
            </Badge>
          ) : null}
        </span>
        {row.lede ? (
          <span style={{ font: "var(--text-phone-body)", color: "var(--text-3)", textWrap: "pretty" }}>{row.lede}</span>
        ) : null}
        <span style={{ display: "flex", gap: "var(--sp-4)", ...MONO_META }}>
          <span>{row.cadence.toLowerCase()}</span>
          {row.step ? (
            <>
              <span>·</span>
              <span>step {row.step}</span>
            </>
          ) : null}
        </span>
      </span>
    </button>
  );
}

/**
 * One workflow, as much of it as fits.
 *
 * Not the desktop's four tabs. Summary is what the phone keeps — where the run
 * stands, what changed, the gate, the stats and the rule — and the trace, the
 * logs and the turn-by-turn transcript stay on the desktop, where there is room
 * to read them. Cutting them to fit would make them worse, not smaller.
 */
function Detail({
  row,
  paused,
  detail,
  onClose,
  onTogglePause,
  onInvoke,
}: {
  row: WorkflowRow;
  paused: boolean;
  detail: Load<WorkflowDetailPayload>;
  onClose: () => void;
  onTogglePause: () => void;
  onInvoke: (action: HomeAction) => void;
}) {
  const loaded = detail.status === "ready" && detail.data.slug === row.slug ? detail.data : null;
  const state = paused ? "idle" : row.state;

  return (
    <Sheet label={SHEET_LABEL[state]} onClose={onClose} height={660} style={{ bottom: "var(--tabbar-total)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)" }}>
          <StatusMark state={state} size={12} />
          <h2
            style={{
              margin: 0,
              font: "var(--text-phone-title)",
              letterSpacing: "var(--tracking-title)",
              color: "var(--text-1)",
              textWrap: "pretty",
            }}
          >
            {row.name}
          </h2>
        </div>
        <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>
          {[row.cadence.toLowerCase(), row.last.toLowerCase(), row.step ? `step ${row.step}` : null].filter(Boolean).join(" · ")}
        </span>
      </div>

      {detail.status === "error" ? (
        <p style={{ margin: 0, font: "var(--text-phone-body)", color: "var(--text-3)", textWrap: "pretty" }}>
          I couldn&rsquo;t open it — {detail.message}.
        </p>
      ) : null}

      {loaded?.summary ? (
        <p style={{ margin: 0, font: "var(--text-phone-lede)", color: "var(--text-2)", textWrap: "pretty" }}>{loaded.summary}</p>
      ) : null}

      {loaded?.progress && state === "running" ? <Meter value={loaded.progress.value} total={loaded.progress.total} /> : null}

      {loaded?.gate && !paused ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--sp-4)",
            padding: "var(--sp-6)",
            background: "var(--surface-alert)",
            border: "var(--border-alert)",
            borderRadius: "var(--radius-card)",
          }}
        >
          <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>{loaded.gate.title}</span>
          {loaded.gate.body ? (
            <span style={{ font: "var(--text-phone-body)", color: "var(--text-2)", textWrap: "pretty" }}>{loaded.gate.body}</span>
          ) : null}
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
            {loaded.gate.actions.map((a) => (
              <Button key={a.id} variant={a.stance === "affirm" ? "affirm" : "quiet"} size="touch" onClick={() => onInvoke(a)}>
                {a.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {loaded && loaded.changed.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>What changed</MonoLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
            {loaded.changed.map((text) => (
              <div
                key={text}
                style={{
                  display: "flex",
                  gap: "var(--sp-4)",
                  alignItems: "baseline",
                  font: "var(--text-phone-body)",
                  color: "var(--text-2)",
                  textWrap: "pretty",
                }}
              >
                <span style={{ font: "var(--text-mono)", color: "var(--accent)" }}>·</span>
                {text}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {loaded && loaded.stats.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>This workflow</MonoLabel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-5)" }}>
            {loaded.stats.map((stat) => (
              <div key={stat.label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span
                  style={{
                    font: "var(--text-mono-label)",
                    letterSpacing: "var(--tracking-label)",
                    textTransform: "uppercase",
                    color: "var(--text-4)",
                  }}
                >
                  {stat.label}
                </span>
                <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>{stat.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {loaded?.instructions ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>Standing instructions</MonoLabel>
          <p style={{ margin: 0, font: "var(--text-phone-body)", color: "var(--text-2)", textWrap: "pretty" }}>{loaded.instructions}</p>
        </div>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
        {/* Nothing writes to the database yet, so a run started here would be a
            button that lies. The pause below is honest because it only changes
            what this browser draws, and says so by moving the row. */}
        <Button variant="affirm" size="touch" disabled>
          Run it now
        </Button>
        {row.scheduled || paused ? (
          <Button size="touch" onClick={onTogglePause}>
            {paused ? "Put it back on schedule" : "Hold it off the schedule"}
          </Button>
        ) : null}
      </div>
    </Sheet>
  );
}
