import { Badge, Button, EvidenceSection, MonoLabel, Panel, StatusMark, type EvidenceItem } from "../kit";
import type { HomeAction, HomeState, ReminderDetailPayload, ReminderEvidence } from "./api";
import type { LocalMark } from "./RemindersView";

/** What the badge calls each state, in the agent's words rather than the enum's. */
const LABELS: Record<HomeState, string> = {
  attention: "needs you",
  running: "working",
  done: "closed",
  failed: "missed",
  idle: "waiting",
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

const CONTROL = {
  font: "var(--text-mono-control)",
  letterSpacing: "var(--tracking-control)",
  textTransform: "uppercase",
} as const;

const COLUMN = { display: "flex", flexDirection: "column", gap: "var(--sp-4)" } as const;

export function ReminderDetail({
  reminder,
  mark,
  onMark,
  onBack,
  onInvoke,
}: {
  reminder: ReminderDetailPayload;
  /** Whether this one was closed or pushed in the browser this session. */
  mark: LocalMark | undefined;
  /** `wasDue` says whether the rail was counting it, so the rail can stop. */
  onMark: (mark: LocalMark, wasDue: boolean) => void;
  onBack: () => void;
  onInvoke: (action: HomeAction) => void;
}) {
  const state: HomeState = mark === "done" ? "done" : mark === "later" ? "idle" : reminder.state;
  const closed = state === "done";
  const group = mark === "done" ? "Closed" : mark === "later" ? "Someday" : reminder.group;
  const when = mark === "done" ? "Just now" : mark === "later" ? "In a week" : reminder.when;
  const wasDue = reminder.group === "Overdue" || reminder.group === "Today";

  return (
    <main style={{ gridColumn: "2 / span 2", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: "var(--sp-7)", padding: "var(--sp-8) var(--sp-10)", borderBottom: "var(--border)" }}>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onBack();
          }}
          style={{ ...CONTROL, color: "var(--text-3)" }}
        >
          ← Reminders
        </a>

        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--sp-9)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-5)" }}>
              <StatusMark state={state} size={14} />
              <h1 style={{ margin: 0, font: "var(--text-display)", letterSpacing: "var(--tracking-display)", color: "var(--text-1)", textWrap: "pretty" }}>
                {reminder.title}
              </h1>
              <Badge tone={state === "attention" ? "attention" : "neutral"} style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                {LABELS[state]}
              </Badge>
            </div>
            <div style={{ display: "flex", gap: "var(--sp-6)", font: "var(--text-mono)", color: "var(--text-4)" }}>
              <span>{group.toLowerCase()}</span>
              <span>·</span>
              <span>{when.toLowerCase()}</span>
              <span>·</span>
              <span>{reminder.source}</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--sp-3)", flexShrink: 0 }}>
            {closed ? (
              <Button onClick={onBack}>Back to the list</Button>
            ) : (
              <>
                <Button variant="affirm" onClick={() => onMark("done", wasDue)}>
                  Mark it done
                </Button>
                <Button onClick={() => onMark("later", wasDue)}>Remind me later</Button>
                {/* Forgetting a thing outright is the one action here with no
                    undo, and nothing writes yet, so it is shown and disabled. */}
                <Button variant="bare" size="sm" disabled>
                  Drop it
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "var(--sp-9) var(--sp-10) var(--sp-10)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: "var(--sp-11)", alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-8)" }}>
            <div style={COLUMN}>
              <MonoLabel>Why I set this</MonoLabel>
              {reminder.prose.map((p, i) => (
                <p key={i} style={PROSE}>
                  {p}
                </p>
              ))}
            </div>

            {/* A gate is a decision the agent is stopped on; a reminder without
                one is only nagging, and its buttons are offers rather than a
                question. The two read differently on purpose. */}
            {reminder.gate && !mark ? (
              <Panel tone="alert" style={{ maxWidth: 560 }}>
                <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>This is the decision I'm waiting on</span>
                <span style={{ font: "var(--text-body)", color: "var(--text-2)" }}>{reminder.gate.body ?? reminder.note}</span>
                <div style={{ display: "flex", gap: "var(--sp-3)", paddingTop: "var(--sp-2)" }}>
                  {reminder.gate.actions.map((a) => (
                    <Button key={a.id} variant={STANCE_TO_VARIANT[a.stance]} onClick={() => onInvoke(a)}>
                      {a.label}
                    </Button>
                  ))}
                </div>
              </Panel>
            ) : null}

            {!reminder.gate && reminder.actions.length > 0 && !closed ? (
              <div style={{ display: "flex", gap: "var(--sp-6)", ...CONTROL }}>
                {reminder.actions.map((a, i) => (
                  <a
                    key={a.id}
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      onInvoke(a);
                    }}
                    style={{ color: i === 0 ? "var(--accent-quiet)" : "var(--text-3)" }}
                  >
                    {a.label}
                  </a>
                ))}
              </div>
            ) : null}

            <EvidenceSection items={reminder.evidence.map(asEvidenceItem)} />

            <div style={COLUMN}>
              <MonoLabel>What I've done about it</MonoLabel>
              {reminder.history.length === 0 ? (
                <p style={{ ...PROSE, font: "var(--text-body-sm)", color: "var(--text-3)" }}>
                  Nothing has happened to this one since I set it.
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {reminder.history.map((h) => (
                    <div
                      key={`${h.t}-${h.text}`}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "150px 1fr",
                        gap: "var(--sp-6)",
                        alignItems: "baseline",
                        padding: "var(--sp-5) 0",
                        borderTop: "var(--border)",
                        maxWidth: 720,
                      }}
                    >
                      <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>{h.t}</span>
                      <span style={{ font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>{h.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-8)" }}>
            <div style={COLUMN}>
              <MonoLabel>This reminder</MonoLabel>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-5)" }}>
                {reminder.meta.map((pair) => (
                  <div key={pair.label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ font: "var(--text-mono-label)", letterSpacing: "var(--tracking-label)", textTransform: "uppercase", color: "var(--text-4)" }}>
                      {pair.label}
                    </span>
                    <span style={{ font: "var(--text-body-sm)", color: "var(--text-1)" }}>{pair.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {reminder.instruction ? (
              <div style={COLUMN}>
                <MonoLabel>Standing instruction</MonoLabel>
                <p style={{ margin: 0, font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>{reminder.instruction}</p>
                <Button variant="bare" size="sm" style={{ alignSelf: "flex-start" }} disabled>
                  Edit instructions
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}

/** The wire shape and the kit's shape are the same shape; this is the cast
 *  that says so, and drops the fields the viewer has no use for. */
function asEvidenceItem(e: ReminderEvidence): EvidenceItem {
  return e;
}
