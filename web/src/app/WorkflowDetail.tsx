import { useState } from "react";
import {
  Badge,
  Button,
  Chip,
  LogStream,
  Meter,
  MonoLabel,
  Panel,
  StatusMark,
  Tabs,
  ToolCalls,
  TraceTree,
  type LogLine,
  type TraceNode,
} from "../kit";
import { WorkflowRunForm } from "./WorkflowRunForm";
import type { HomeAction, WorkflowDetailPayload, WorkflowExecution, WorkflowTraceNode } from "./api";

/**
 * Starting a run, from the surface's point of view.
 *
 * The detail pane owns the form and nothing else: whether a request is in
 * flight, what the server said if it refused, and which run it opened all live
 * above, because the same three things drive the re-read that follows.
 */
export interface WorkflowTrigger {
  pending: boolean;
  /** What the server said when it refused. Null while nothing is wrong. */
  error: string | null;
  /** "Run 3", once one has been started from here. Null before that. */
  started: string | null;
  onRun: (args: Record<string, string>) => void;
  /** Drop the last refusal, so opening the form again starts clean. */
  onClear: () => void;
}

/**
 * The three things this pane can change about a workflow that are not a run.
 *
 * Separate from the trigger because they fail differently and are read
 * differently: a refused run belongs beside the form you were filling in, a
 * refused pause belongs beside the button you pressed. One `busy` for all three
 * is deliberate — they are the same workflow, and letting you stop a run while
 * a pause is still in flight only invents orderings for the server to resolve.
 */
export interface WorkflowEdits {
  busy: boolean;
  /** What the server said when it refused one. Null while nothing is wrong. */
  error: string | null;
  /** Stop the run going now. Only ever offered while one is. */
  onStop: () => void;
  /** Replace the standing rule. Empty text retires it without a successor. */
  onInstructions: (text: string) => void;
}

const TABS = ["Summary", "Executions", "Trace", "Logs"] as const;
type Tab = (typeof TABS)[number];

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

const CONTROL = {
  font: "var(--text-mono-control)",
  letterSpacing: "var(--tracking-control)",
  textTransform: "uppercase",
} as const;

const COLUMN = { display: "flex", flexDirection: "column", gap: "var(--sp-4)" } as const;

/**
 * How long a run took and how it ended, without saying either twice.
 *
 * A run still going has no duration, so the server puts what it is doing in
 * that slot instead — and "running · running" is the one pairing where the two
 * halves collapse into one word.
 */
function ranAs(run: WorkflowExecution): string {
  return run.duration === run.badge ? run.duration : `${run.duration} · ${run.badge}`;
}

export function WorkflowDetail({
  workflow,
  tab,
  onTab,
  paused,
  onTogglePause,
  onBack,
  onInvoke,
  trigger,
  edits,
  askOnOpen = false,
}: {
  workflow: WorkflowDetailPayload;
  tab: string;
  onTab: (tab: string) => void;
  /** Whether this workflow is paused, as the server has it. */
  paused: boolean;
  onTogglePause: () => void;
  onBack: () => void;
  onInvoke: (action: HomeAction) => void;
  trigger: WorkflowTrigger;
  edits: WorkflowEdits;
  /** Arrive with the trigger form already asking — what Run on the table
   *  means, as against Open. Read once, on mount. */
  askOnOpen?: boolean;
}) {
  const current: Tab = (TABS as readonly string[]).includes(tab) ? (tab as Tab) : "Summary";
  const state = paused ? "idle" : workflow.state;
  const badge = paused ? "paused" : workflow.badge;
  const [asking, setAsking] = useState(askOnOpen && workflow.runnable && workflow.inputs.length > 0);

  /* Which run every tab is about.
     Held here rather than inside the executions list because Trace and Logs
     draw the same run from the other side of the tab bar. Picking a run on one
     tab and finding another tab still showing the newest one is the sort of
     disagreement that makes a trace impossible to trust. */
  const [selected, setSelected] = useState("");
  const shown = workflow.executions.find((e) => e.id === selected) ?? workflow.executions[0];

  /* A workflow that takes no arguments has nothing to ask about, so Run starts
     it. One that does opens the form instead — and only ever on the Summary
     tab, which is where it is drawn. */
  /* Once the run is on the record the form has nothing left to ask, so it
     closes itself rather than sitting over the thing you just started. */
  if (asking && trigger.started && !trigger.pending && !trigger.error) setAsking(false);

  const press = () => {
    trigger.onClear();
    if (workflow.inputs.length === 0) {
      trigger.onRun({});
      return;
    }
    onTab("Summary");
    setAsking(true);
  };

  return (
    <main style={{ gridColumn: "2 / span 2", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: "var(--sp-7)", padding: "var(--sp-8) var(--sp-10) 0", borderBottom: "var(--border)" }}>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onBack();
          }}
          style={{ ...CONTROL, color: "var(--text-3)" }}
        >
          ← Workflows
        </a>

        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--sp-9)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-5)" }}>
              <StatusMark state={state} size={14} />
              <h1 style={{ margin: 0, font: "var(--text-display)", letterSpacing: "var(--tracking-display)", color: "var(--text-1)" }}>
                {workflow.name}
              </h1>
              {/* The word comes from the server, which can tell a run you
                  stopped from a workflow you paused. The mark beside it cannot
                  — five colours, six outcomes — and that is the mark's job. */}
              <Badge tone={state === "running" ? "running" : "neutral"}>
                {workflow.step && workflow.state === "running" ? `${badge} · step ${workflow.step}` : badge}
              </Badge>
            </div>
            <div style={{ display: "flex", gap: "var(--sp-6)", font: "var(--text-mono)", color: "var(--text-4)" }}>
              <span>{workflow.cadence.toLowerCase()}</span>
              <span>·</span>
              <span>{workflow.last.toLowerCase()}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--sp-3)", flexShrink: 0 }}>
            <Button disabled={edits.busy} onClick={onTogglePause}>{paused ? "Resume" : "Pause"}</Button>
            {/* Disabled where there is genuinely no code behind the row, rather
                than quietly missing — the design's workflows are on this table
                too, and a Run button on one of those would be a lie. Stopping a
                run is the half that is still unbuilt. */}
            <Button
              variant="affirm"
              disabled={!workflow.runnable || paused || trigger.pending || state === "running"}
              onClick={press}
            >
              {trigger.pending ? "Starting…" : state === "running" ? "Running" : "Run"}
            </Button>
            {workflow.state === "running" ? (
              <Button variant="danger" size="sm" disabled={edits.busy} onClick={edits.onStop}>
                {edits.busy ? "Stopping…" : "Kill run"}
              </Button>
            ) : null}
          </div>
        </div>

        <Tabs
          items={[{ label: "Summary" }, { label: "Executions", count: workflow.executions.length || null }, { label: "Trace" }, { label: "Logs" }]}
          value={current}
          onChange={onTab}
          style={{ borderBottom: "none" }}
        />
      </header>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "var(--sp-9) var(--sp-10) var(--sp-10)" }}>
        {current === "Summary" ? (
          <SummaryPane
            workflow={workflow}
            state={state}
            onInvoke={onInvoke}
            trigger={trigger}
            edits={edits}
            asking={asking}
            onCloseForm={() => setAsking(false)}
          />
        ) : null}
        {current === "Executions" ? (
          <ExecutionsPane workflow={workflow} run={shown} onSelect={setSelected} />
        ) : null}
        {current === "Trace" ? (shown ? <TracePane workflow={workflow} run={shown} /> : <Nothing />) : null}
        {current === "Logs" ? (shown ? <LogsPane run={shown} /> : <Nothing />) : null}
      </div>
    </main>
  );
}

function Nothing() {
  return <p style={{ ...PROSE, color: "var(--text-3)" }}>No run recorded for this workflow yet. I'll fill this in the first time it runs.</p>;
}

function SummaryPane({
  workflow,
  state,
  onInvoke,
  trigger,
  edits,
  asking,
  onCloseForm,
}: {
  workflow: WorkflowDetailPayload;
  state: WorkflowDetailPayload["state"];
  onInvoke: (action: HomeAction) => void;
  trigger: WorkflowTrigger;
  edits: WorkflowEdits;
  asking: boolean;
  onCloseForm: () => void;
}) {
  const latest = workflow.executions[0];
  /* Two different questions, and they were sharing a heading.
     What a workflow is for never changes; where it stands changes every run.
     The catalog answers the first; the newest run that actually wrote an
     account answers the second — not simply the newest run, because one going
     right now has not written anything yet, and one you stopped never will.
     Reading only the newest made a workflow that had run twice claim it had
     never run at all, the moment a third started. */
  const accounted = workflow.executions.find((e) => e.detail?.prose.length);
  const stands = workflow.summary ?? accounted?.detail?.prose[0] ?? null;
  const stale = accounted != null && accounted.id !== latest?.id;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: "var(--sp-11)", alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-8)" }}>
        {workflow.description ? (
          <div style={COLUMN}>
            <MonoLabel>What this does</MonoLabel>
            <p style={PROSE}>{workflow.description}</p>
          </div>
        ) : null}

        <div style={COLUMN}>
          <MonoLabel>Where this stands</MonoLabel>
          <p style={stands ? PROSE : { ...PROSE, color: "var(--text-3)" }}>
            {stands ?? "This one hasn't run yet, so there is nothing to account for."}
          </p>
          {/* Said out loud when the account is not the newest run's, so a
              write-up from two runs ago is never read as this one's. */}
          {stale ? (
            <p style={{ ...PROSE, color: "var(--text-3)" }}>That was {accounted?.label}, {accounted?.when.toLowerCase()}.</p>
          ) : null}
          {workflow.progress && state === "running" ? (
            <Meter value={workflow.progress.value} total={workflow.progress.total} style={{ maxWidth: 420 }} />
          ) : null}
          {state === "running" ? (
            <p style={{ ...PROSE, color: "var(--text-3)" }}>
              {trigger.started ?? latest?.label ?? "A run"} is going now. This page re-reads itself while it does, so
              leave it open.
            </p>
          ) : null}
        </div>

        {asking ? (
          <WorkflowRunForm
            inputs={workflow.inputs}
            pending={trigger.pending}
            error={trigger.error}
            onRun={(args) => trigger.onRun(args)}
            onCancel={onCloseForm}
          />
        ) : trigger.error ? (
          <Panel tone="alert" style={{ maxWidth: 560 }}>
            <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>I couldn't start it.</span>
            <span style={{ font: "var(--text-body)", color: "var(--text-2)" }}>{trigger.error}</span>
          </Panel>
        ) : null}

        {workflow.changed.length ? (
          <div style={COLUMN}>
            <MonoLabel>What changed</MonoLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
              {workflow.changed.map((line) => (
                <div key={line} style={{ display: "flex", gap: "var(--sp-4)", alignItems: "baseline", font: "var(--text-body)", color: "var(--text-2)" }}>
                  <span style={{ font: "var(--text-mono)", color: "var(--accent)" }}>·</span>
                  {line}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {edits.error ? (
          <Panel tone="alert" style={{ maxWidth: 560 }}>
            <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>That didn't take.</span>
            <span style={{ font: "var(--text-body)", color: "var(--text-2)" }}>{edits.error}</span>
          </Panel>
        ) : null}

        {workflow.gate ? (
          <Panel tone="alert" style={{ maxWidth: 560 }}>
            <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>{workflow.gate.title}</span>
            {workflow.gate.body ? <span style={{ font: "var(--text-body)", color: "var(--text-2)" }}>{workflow.gate.body}</span> : null}
            <div style={{ display: "flex", gap: "var(--sp-3)", paddingTop: "var(--sp-2)" }}>
              {workflow.gate.actions.map((action) => (
                <Button key={action.id} variant={STANCE_TO_VARIANT[action.stance]} onClick={() => onInvoke(action)}>
                  {action.label}
                </Button>
              ))}
            </div>
          </Panel>
        ) : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-8)" }}>
        <div style={COLUMN}>
          <MonoLabel>This workflow</MonoLabel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-5)" }}>
            {workflow.stats.map((stat) => (
              <div key={stat.label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <MonoLabel>{stat.label}</MonoLabel>
                <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>{stat.value}</span>
              </div>
            ))}
          </div>
        </div>
        <Instructions
          key={workflow.instructions ?? ""}
          text={workflow.instructions}
          busy={edits.busy}
          onSave={edits.onInstructions}
        />
      </div>
    </div>
  );
}

/**
 * The standing rule, and the one control on this page that rewrites something.
 *
 * Read-only until you press Edit, because the rule is the thing a run is
 * accountable to and a textarea that is always live invites a stray keystroke
 * to become policy. Saving replaces it on the server, which keeps the one it
 * replaced — the table is versioned, and a rule you gave in June is part of
 * why a run in June did what it did.
 *
 * Keyed on the stored text by its caller, so a save landing from elsewhere
 * remounts this with the new rule rather than leaving a stale draft over it.
 */
function Instructions({
  text,
  busy,
  onSave,
}: {
  text: string | null;
  busy: boolean;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft != null;

  return (
    <div style={COLUMN}>
      <MonoLabel>Standing instructions</MonoLabel>
      {editing ? (
        <>
          <textarea
            rows={5}
            autoFocus
            value={draft}
            placeholder="Anything that commits money waits for me."
            onChange={(event) => setDraft(event.target.value)}
            style={{
              boxSizing: "border-box",
              width: "100%",
              padding: "7px 10px",
              border: "var(--border-strong)",
              borderRadius: "var(--radius-control)",
              background: "var(--surface-app)",
              color: "var(--text-1)",
              font: "var(--text-body-sm)",
              lineHeight: 1.5,
              resize: "vertical",
              outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: "var(--sp-3)" }}>
            <Button
              variant="affirm"
              size="sm"
              disabled={busy || draft.trim() === (text ?? "")}
              onClick={() => {
                onSave(draft);
                setDraft(null);
              }}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button variant="bare" size="sm" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
          <span style={{ font: "var(--text-mono-meta)", color: "var(--text-4)" }}>
            {text ? "Clearing it retires the rule; it stays on the record against the runs it governed." : "Empty means no rule."}
          </span>
        </>
      ) : (
        <>
          <p style={{ margin: 0, font: "var(--text-body-sm)", color: text ? "var(--text-2)" : "var(--text-3)", textWrap: "pretty" }}>
            {text ?? "You haven't given me a rule for this one, so I run it the way it was set up."}
          </p>
          <Button variant="bare" size="sm" onClick={() => setDraft(text ?? "")} style={{ alignSelf: "flex-start" }}>
            {text ? "Edit instructions" : "Give me a rule"}
          </Button>
        </>
      )}
    </div>
  );
}

function ExecutionsPane({
  workflow,
  run,
  onSelect,
}: {
  workflow: WorkflowDetailPayload;
  run: WorkflowExecution | undefined;
  onSelect: (id: string) => void;
}) {
  const [mode, setMode] = useState<"Write-up" | "Transcript">("Write-up");

  if (!run) return <Nothing />;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "232px minmax(0, 1fr)", gap: "var(--sp-11)", alignItems: "start" }}>
      <div style={COLUMN}>
        <MonoLabel>Recent executions</MonoLabel>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {workflow.executions.map((execution) => (
            <ExecRow key={execution.id} run={execution} selected={execution.id === run.id} onClick={() => onSelect(execution.id)} />
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-7)", maxWidth: 720, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-6)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-5)" }}>
            <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>{run.label}</span>
            <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>
              {run.when.toLowerCase()} · {ranAs(run)}
            </span>
          </div>
          {run.detail && run.detail.transcript.length ? (
            <div style={{ display: "flex", gap: "var(--sp-2)", flexShrink: 0 }}>
              {(["Write-up", "Transcript"] as const).map((m) => (
                <Chip key={m} selected={mode === m} onClick={() => setMode(m)}>
                  {m}
                </Chip>
              ))}
            </div>
          ) : null}
        </div>

        {!run.detail ? (
          <p style={{ ...PROSE, color: "var(--text-3)" }}>
            I didn't keep a write-up for this one. The run is on the record — when it started, how long it took, how it ended — but not what
            I said about it at the time.
          </p>
        ) : mode === "Transcript" && run.detail.transcript.length ? (
          <Transcript turns={run.detail.transcript} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-6)" }}>
            {run.detail.prose.map((paragraph) => (
              <p key={paragraph} style={PROSE}>
                {paragraph}
              </p>
            ))}
            {/* A run writes its account at the end, so one that did not reach
                the end has none. Saying which of those happened beats an empty
                pane that reads as a rendering fault. */}
            {run.detail.prose.length === 0 ? (
              <p style={{ ...PROSE, color: "var(--text-3)" }}>{WITHOUT_WRITEUP[run.badge] ?? WITHOUT_WRITEUP.default}</p>
            ) : null}
            {run.error ? (
              <Panel tone="alert">
                <MonoLabel>Why it halted</MonoLabel>
                <span style={{ font: "var(--text-mono)", color: "var(--text-2)", textWrap: "pretty" }}>{run.error}</span>
              </Panel>
            ) : null}
            {run.detail.calls.length ? <ToolCalls calls={run.detail.calls} style={{ maxWidth: 560 }} /> : null}
            {run.detail.output ? <Output json={run.detail.output} /> : null}
            {run.state === "running" && run.detail.prose.length > 0 ? (
              <p style={{ ...PROSE, color: "var(--text-3)" }}>
                I'll finish the remaining steps and write the closing summary when this pass ends.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * What the workflow handed back, verbatim.
 *
 * The write-up above says what it means; this is the thing itself, for when the
 * two need to be checked against each other. Collapsed by default because a
 * screenshot sweep returns a page of JSON and the account of it is two lines.
 */
function Output({ json }: { json: string }) {
  const [open, setOpen] = useState(false);
  const lines = json.split("\n").length;

  /* `minWidth: 0` on the way down to the <pre>. A flex item's default minimum
     is its content, so a single long line of JSON widens every ancestor until
     the whole page scrolls sideways — the <pre>'s own `overflow: auto` never
     gets a chance to be the thing that scrolls. */
  return (
    <div style={{ ...COLUMN, minWidth: 0 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-3)",
          alignSelf: "flex-start",
          ...CONTROL,
          color: "var(--text-3)",
        }}
      >
        <span style={{ font: "var(--text-mono)" }}>{open ? "▾" : "▸"}</span>
        Result · {lines} lines
      </button>
      {open ? (
        <pre
          style={{
            margin: 0,
            minWidth: 0,
            maxHeight: 360,
            overflow: "auto",
            padding: "var(--sp-6)",
            borderRadius: "var(--radius-card)",
            background: "var(--surface-raised)",
            border: "var(--border)",
            font: "var(--text-mono)",
            color: "var(--text-2)",
            lineHeight: 1.6,
          }}
        >
          {json}
        </pre>
      ) : null}
    </div>
  );
}

function Transcript({ turns }: { turns: NonNullable<WorkflowExecution["detail"]>["transcript"] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-6)" }}>
      {turns.map((turn, i) => (
        <div
          key={`${turn.who}-${i}`}
          style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", alignItems: turn.who === "you" ? "flex-end" : "flex-start" }}
        >
          <MonoLabel>{turn.who === "you" ? "You" : "Solenoid"}</MonoLabel>
          <div
            style={{
              maxWidth: 520,
              padding: "var(--sp-5) var(--sp-7)",
              borderRadius: "var(--radius-card)",
              background: turn.who === "you" ? "var(--surface-note)" : "var(--surface-raised)",
              border: turn.who === "you" ? "none" : "var(--border)",
              font: "var(--text-body)",
              color: "var(--text-2)",
              textWrap: "pretty",
            }}
          >
            {turn.text}
          </div>
        </div>
      ))}
    </div>
  );
}

function ExecRow({ run, selected, onClick }: { run: WorkflowExecution; selected: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        all: "unset",
        cursor: "pointer",
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-4)",
        padding: "var(--sp-5) var(--sp-4)",
        borderTop: "var(--border)",
        background: selected ? "var(--surface-selected)" : hover ? "var(--surface-hover)" : "transparent",
        transition: "background var(--dur) var(--ease)",
      }}
    >
      <StatusMark state={run.state} size={9} />
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ font: "var(--text-ui-sm)", color: "var(--text-1)" }}>{run.when}</span>
        <span style={{ font: "var(--text-mono-meta)", color: "var(--text-4)" }}>
          {run.label} · {ranAs(run)}
        </span>
      </span>
    </button>
  );
}

function TracePane({ workflow, run }: { workflow: WorkflowDetailPayload; run: WorkflowExecution }) {
  const [open, setOpen] = useState(true);
  const nodes = (run.detail?.trace ?? []).map(toTraceNode);

  // Every tab draws the run picked on Executions, so this one has to account
  // for a run that kept nothing rather than drawing an empty tree as if the
  // run had genuinely done no work.
  if (nodes.length === 0) {
    return (
      <p style={{ ...PROSE, color: "var(--text-3)" }}>
        {run.label} kept no trace. {run.state === "idle" ? "It was stopped before it wrote one." : "Nothing was recorded step by step for it."}
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-6)", maxWidth: 900 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-6)" }}>
        <MonoLabel>{workflow.step ? `${run.label} · step ${workflow.step.replace("/", " of ")}` : run.label}</MonoLabel>
        <div style={{ display: "flex", gap: "var(--sp-2)", flexShrink: 0 }}>
          <Chip selected={open} onClick={() => setOpen(true)}>
            Expanded
          </Chip>
          <Chip selected={!open} onClick={() => setOpen(false)}>
            Collapsed
          </Chip>
        </div>
      </div>
      {/* Remounting is what makes the two chips reset every node's own state. */}
      <TraceTree key={String(open)} nodes={nodes} defaultOpen={open} />
      <p style={{ margin: 0, font: "var(--text-body-sm)", color: "var(--text-3)", maxWidth: "var(--measure)" }}>
        Amber steps are held on purpose, not broken. Grey steps are waiting on something above them.
      </p>
    </div>
  );
}

/** The wire spells every field out; the kit's node keeps them optional. */
function toTraceNode(node: WorkflowTraceNode): TraceNode {
  return {
    name: node.name,
    detail: node.detail,
    note: node.note,
    duration: node.duration,
    state: node.state,
    children: node.children.map(toTraceNode),
  };
}

/** Why a run has no account of itself, by how it ended. */
const WITHOUT_WRITEUP: Record<string, string> = {
  stopped: "You stopped this one before it finished, so it never wrote an account of itself. The log below has what it managed first.",
  running: "I'll write the account when this pass ends.",
  halted: "It halted before it could write anything up. The error is above and the log has the rest.",
  "needs you": "It's holding for a decision, so there's nothing final to say yet.",
  queued: "It hasn't started yet.",
  default: "Nothing was written up for this one.",
};

const LEVELS = ["All", "Warnings", "Errors"] as const;

function LogsPane({ run }: { run: WorkflowExecution }) {
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("All");
  const all = run.detail?.logs ?? [];

  if (all.length === 0) return <p style={{ ...PROSE, color: "var(--text-3)" }}>{run.label} kept no log.</p>;
  const lines: LogLine[] = all
    .filter((l) => level === "All" || (level === "Warnings" && (l.level === "warn" || l.level === "error")) || (level === "Errors" && l.level === "error"))
    // The log stream has four colours; `debug` shares the quietest of them.
    .map((l) => ({ t: l.t, level: l.level === "debug" ? "info" : l.level, text: l.text }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-6)", maxWidth: 900 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-6)" }}>
        <MonoLabel>{run.label} · raw log</MonoLabel>
        <div style={{ display: "flex", gap: "var(--sp-2)", flexShrink: 0 }}>
          {LEVELS.map((l) => (
            <Chip key={l} selected={level === l} onClick={() => setLevel(l)}>
              {l}
            </Chip>
          ))}
        </div>
      </div>
      <LogStream lines={lines} style={{ maxHeight: 420 }} />
      <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>
        {lines.length} of {all.length} lines
      </span>
    </div>
  );
}
