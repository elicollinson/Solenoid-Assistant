import { Badge, Button, EvidenceSection, MonoLabel, Panel, StatusMark, type EvidenceItem } from "../kit";
import type { HomeAction, HomeState, RecommendationDetailPayload, ReminderEvidence } from "./api";
import { LABELS, withLocalStance, type LocalStance } from "./RecommendationsView";

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

const MONO_LABEL = {
  font: "var(--text-mono-label)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--text-4)",
} as const;

const COLUMN = { display: "flex", flexDirection: "column", gap: "var(--sp-4)" } as const;

export function RecommendationDetail({
  recommendation,
  stance,
  onAnswer,
  onBack,
}: {
  recommendation: RecommendationDetailPayload;
  /** Whether this one was answered in the browser this session. */
  stance: LocalStance | undefined;
  /** The action carries the words you answered with. `wasOpen` says whether
   *  the rail was counting it, so the rail can stop. */
  onAnswer: (stance: LocalStance, wasOpen: boolean, action: HomeAction) => void;
  onBack: () => void;
}) {
  // One reading of the answer, shared with the list, so the header, the mark
  // and the row you came from cannot disagree about what just happened.
  const shown = withLocalStance(recommendation, stance ? new Map([[recommendation.id, stance]]) : new Map());
  const state: HomeState = shown.state;
  const settled = state !== "attention";
  const wasOpen = recommendation.group === "Waiting on you";
  const [affirm, quiet] = recommendation.actions;

  const answer = (action: HomeAction) =>
    onAnswer(action.stance === "affirm" ? "adopted" : "declined", wasOpen, action);

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
          ← Recommendations
        </a>

        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--sp-9)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-5)" }}>
              <StatusMark state={state} size={14} />
              <h1 style={{ margin: 0, font: "var(--text-display)", letterSpacing: "var(--tracking-display)", color: "var(--text-1)", textWrap: "pretty" }}>
                {recommendation.title}
              </h1>
              <Badge tone={state === "attention" ? "attention" : "neutral"} style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                {LABELS[state]}
              </Badge>
            </div>
            {/* Scope, then what it rests on, then when — and any of the three
                may be missing on a suggestion nothing was written up for.
                Each part holds together and the line wraps between them: a uri
                broken across two lines is a uri you cannot read or copy. */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-6)", font: "var(--text-mono)", color: "var(--text-4)" }}>
              {[shown.scope, shown.basis, shown.when.toLowerCase()]
                .filter((part): part is string => Boolean(part))
                .map((part, i) => (
                  <span key={part} style={{ display: "flex", gap: "var(--sp-6)", whiteSpace: "nowrap" }}>
                    {i > 0 ? <span>·</span> : null}
                    <span>{part}</span>
                  </span>
                ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--sp-3)", flexShrink: 0 }}>
            {settled || !affirm || !quiet ? (
              <Button onClick={onBack}>Back to the list</Button>
            ) : (
              <>
                <Button variant="affirm" onClick={() => answer(affirm)}>
                  {affirm.label}
                </Button>
                <Button onClick={() => answer(quiet)}>{quiet.label}</Button>
                {/* Putting it off would have to write a date to come back on,
                    and nothing writes yet. */}
                <Button variant="bare" size="sm" disabled>
                  Ask me again later
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
              <MonoLabel>What I noticed</MonoLabel>
              {recommendation.prose.map((p) => (
                <p key={p} style={PROSE}>
                  {p}
                </p>
              ))}
            </div>

            {/* The panel is the ask, and it only exists while it is being
                asked. Where the agent stopped short is the whole of what it
                wants permission for, so the same sentence carries it. */}
            {!settled && recommendation.restraint && affirm && quiet ? (
              <Panel tone="alert" style={{ maxWidth: 560 }}>
                <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>This is the permission I'm asking for</span>
                <span style={{ font: "var(--text-body)", color: "var(--text-2)", textWrap: "pretty" }}>{recommendation.restraint}</span>
                <div style={{ display: "flex", gap: "var(--sp-3)", paddingTop: "var(--sp-2)" }}>
                  <Button variant={STANCE_TO_VARIANT[affirm.stance]} onClick={() => answer(affirm)}>
                    {affirm.label}
                  </Button>
                  <Button onClick={() => answer(quiet)}>{quiet.label}</Button>
                </div>
              </Panel>
            ) : null}

            {recommendation.effect.length > 0 ? (
              <div style={COLUMN}>
                <MonoLabel>{settled ? "What changed" : "What changes if you say yes"}</MonoLabel>
                <div style={{ display: "flex", flexDirection: "column", maxWidth: 720 }}>
                  {recommendation.effect.map((pair) => (
                    <div
                      key={pair.label}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "260px 1fr",
                        gap: "var(--sp-6)",
                        alignItems: "baseline",
                        padding: "var(--sp-5) var(--sp-3)",
                        borderTop: "var(--border)",
                      }}
                    >
                      <span style={{ font: "var(--text-body-sm)", color: "var(--text-2)" }}>{pair.label}</span>
                      <span style={{ font: "var(--text-mono)", color: "var(--text-1)" }}>{pair.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <EvidenceSection items={recommendation.evidence.map(asEvidenceItem)} label="What I formed it from" />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-8)" }}>
            <div style={COLUMN}>
              <MonoLabel>This suggestion</MonoLabel>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-5)" }}>
                {recommendation.meta.map((pair) => (
                  <div key={pair.label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={MONO_LABEL}>{pair.label}</span>
                    <span style={{ font: "var(--text-body-sm)", color: "var(--text-1)" }}>{pair.value}</span>
                  </div>
                ))}
              </div>
            </div>

            {recommendation.restraint ? (
              <div style={COLUMN}>
                <MonoLabel>Where I stopped</MonoLabel>
                <p style={{ margin: 0, font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>
                  {recommendation.restraint}
                </p>
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
