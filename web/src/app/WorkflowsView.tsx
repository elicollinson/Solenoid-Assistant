import { useState } from "react";
import { Badge, Button, Chip, MonoLabel, StatusMark } from "../kit";
import type { WorkflowRow, WorkflowsPayload } from "./api";

const FILTERS = ["All", "Needs you", "Running", "Scheduled", "Paused"] as const;
type Filter = (typeof FILTERS)[number];

const MATCHES: Record<Filter, (row: WorkflowRow) => boolean> = {
  All: () => true,
  "Needs you": (row) => row.state === "attention",
  Running: (row) => row.state === "running",
  Scheduled: (row) => row.scheduled,
  Paused: (row) => row.paused,
};

/* Status · name · cadence · last run · step. The step column doubles as the
   hover slot for the row's controls, so nothing shifts when you point at it. */
const COLS = "26px 1fr 190px 210px 150px";

const CONTROL = {
  font: "var(--text-mono-control)",
  letterSpacing: "var(--tracking-control)",
  textTransform: "uppercase",
} as const;

export function WorkflowsView({
  workflows,
  busy,
  error,
  onTogglePause,
  onOpen,
  onRun,
}: {
  workflows: WorkflowsPayload;
  /** True while a pause is in flight. Every row's control waits on it, because
   *  the answer that lands is a re-read of the whole table. */
  busy: boolean;
  /** What the server said when it refused one. Null while nothing is wrong. */
  error: string | null;
  onTogglePause: (slug: string, paused: boolean) => void;
  onOpen: (slug: string) => void;
  /** Open the workflow with its trigger form already asking. */
  onRun: (slug: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("All");
  const rows = workflows.rows.filter(MATCHES[filter]);

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
            Workflows
          </h1>
          <p style={{ margin: 0, font: "var(--text-body)", color: "var(--text-3)" }}>{workflows.lede}</p>
        </div>
        <div style={{ display: "flex", gap: "var(--sp-2)", flexShrink: 0 }}>
          {FILTERS.map((f) => (
            <Chip key={f} selected={filter === f} onClick={() => setFilter(f)}>
              {f}
            </Chip>
          ))}
        </div>
      </header>

      {error ? (
        <p
          style={{
            margin: 0,
            padding: "var(--sp-5) var(--sp-10)",
            font: "var(--text-body-sm)",
            color: "var(--danger-text)",
            borderBottom: "var(--border)",
          }}
        >
          {error}
        </p>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "var(--sp-8) var(--sp-10) var(--sp-10)" }}>
        <div style={{ display: "grid", gridTemplateColumns: COLS, gap: "var(--sp-6)", padding: "0 var(--sp-3) var(--sp-4)" }}>
          <span />
          <MonoLabel>Workflow</MonoLabel>
          <MonoLabel>Cadence</MonoLabel>
          <MonoLabel>Last run</MonoLabel>
          <MonoLabel style={{ textAlign: "right" }}>Step</MonoLabel>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {rows.length === 0 ? (
            <p style={{ margin: 0, padding: "var(--sp-7) var(--sp-3)", font: "var(--text-body)", color: "var(--text-3)" }}>
              Nothing here under that filter.
            </p>
          ) : (
            rows.map((row) => (
              <Row
                key={row.slug}
                row={row}
                busy={busy}
                onOpen={() => onOpen(row.slug)}
                onRun={() => onRun(row.slug)}
                onTogglePause={() => onTogglePause(row.slug, !row.paused)}
              />
            ))
          )}
        </div>
      </div>
    </main>
  );
}

function Row({
  row,
  busy,
  onOpen,
  onRun,
  onTogglePause,
}: {
  row: WorkflowRow;
  busy: boolean;
  onOpen: () => void;
  onRun: () => void;
  onTogglePause: () => void;
}) {
  const [hover, setHover] = useState(false);

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
        alignItems: "center",
        padding: "var(--sp-6) var(--sp-3)",
        borderTop: "var(--border)",
        background: hover ? "var(--surface-hover)" : "transparent",
        opacity: row.paused ? 0.55 : 1,
        transition: "background var(--dur) var(--ease)",
      }}
    >
      <StatusMark state={row.state} />
      <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)", font: "var(--text-title)", color: "var(--text-1)" }}>
        {row.name}
        {row.paused ? <Badge>paused</Badge> : null}
        {!row.paused && row.state === "running" ? <Badge tone="running">running</Badge> : null}
        {!row.paused && row.state === "attention" ? <Badge tone="attention">needs you</Badge> : null}
        {!row.paused && row.state === "failed" ? <Badge>halted</Badge> : null}
      </span>
      <span style={{ font: "var(--text-body-sm)", color: "var(--text-3)" }}>{row.cadence}</span>
      <span style={{ font: "var(--text-mono)", color: "var(--text-3)" }}>{row.last}</span>
      <span style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "var(--sp-4)" }}>
        {hover ? (
          <>
            {/* Offered on every row, not only the scheduled ones: pausing is
                written now, and it stops a manual Run as firmly as it stops
                the next scheduled firing. */}
            <Button
              variant="bare"
              size="sm"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePause();
              }}
              style={CONTROL}
            >
              {row.paused ? "Resume" : "Pause"}
            </Button>
            {/* Run goes through the workflow's own screen rather than firing
                from the row: most of them take arguments, and a table row is
                the wrong place to ask for them. It arrives with the form open,
                which is the difference between this and Open. Absent on a row
                with no code behind it — the design's workflows are on this
                table too, and a Run button on one of those would be a lie. */}
            {row.runnable && !row.paused && row.state !== "running" ? (
              <Button
                variant="bare"
                size="sm"
                onClick={(event) => {
                  event.stopPropagation();
                  onRun();
                }}
                style={CONTROL}
              >
                Run
              </Button>
            ) : null}
            <Button variant="bare" size="sm" onClick={onOpen} style={CONTROL}>
              Open
            </Button>
          </>
        ) : (
          <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>{row.paused ? "—" : (row.step ?? "—")}</span>
        )}
      </span>
    </div>
  );
}
