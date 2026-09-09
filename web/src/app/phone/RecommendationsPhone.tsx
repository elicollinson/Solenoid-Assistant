// Recommendations at 390px.
//
// No phone screen was drawn for this either, so it is the desktop's three
// shelves — waiting on you, standing, set aside — as rows on hairline rules,
// and a sheet for one suggestion. Adopting or declining is the same act it is
// on the desktop: the row moves at once and the write follows, and a refusal
// puts the row back where it was.
import { useState } from "react";
import { Badge, Button, Chip, EvidenceSection, MonoLabel, SectionRule, Sheet, StatusMark, type EvidenceItem } from "../../kit";
import type {
  HomeAction,
  Load,
  RecommendationDetailPayload,
  RecommendationGroup,
  RecommendationRow,
  RecommendationsPayload,
  ReminderEvidence,
} from "../api";
import { recount } from "../lede";
import { LABELS, waitingClause, withLocalStance, type LocalStance } from "../RecommendationsView";
import { PhoneBody, PhoneTitle } from "./chrome";

const FILTERS = ["All", "Waiting on you", "Standing", "Set aside"] as const;
type Filter = (typeof FILTERS)[number];

/** The order the server shelves them in. */
const GROUPS: readonly RecommendationGroup[] = ["Waiting on you", "Standing", "Set aside"];

const STANCE_TO_VARIANT: Record<HomeAction["stance"], "affirm" | "quiet" | "bare" | "danger"> = {
  affirm: "affirm",
  neutral: "quiet",
  quiet: "quiet",
  bare: "bare",
  danger: "danger",
};

const MONO_META = { font: "var(--text-mono-meta)", color: "var(--text-4)" } as const;
const CONTROL = {
  font: "var(--text-mono-control)",
  letterSpacing: "var(--tracking-control)",
  textTransform: "uppercase",
} as const;
const LABEL = {
  font: "var(--text-mono-label)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--text-4)",
} as const;
const CLAMP_2 = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
} as const;
const PROSE = { margin: 0, font: "var(--text-phone-body)", color: "var(--text-2)", textWrap: "pretty" } as const;

export function RecommendationsPhone({
  recommendations,
  detail,
  openId,
  onOpen,
  stances,
  onAnswer,
}: {
  recommendations: RecommendationsPayload;
  detail: Load<RecommendationDetailPayload>;
  openId: string | null;
  onOpen: (id: string | null) => void;
  /** Suggestions answered in the browser this session, ahead of the write. */
  stances: ReadonlyMap<string, LocalStance>;
  /** The action carries the words you answered with. `wasOpen` says whether
   *  it was still being asked, so the count can stop. */
  onAnswer: (id: string, stance: LocalStance, wasOpen: boolean, action: HomeAction) => void;
}) {
  const [filter, setFilter] = useState<Filter>("All");
  const all = recommendations.rows.map((row) => withLocalStance(row, stances));
  const shown = all.filter((row) => filter === "All" || row.group === filter);
  const lede = stances.size === 0 ? recommendations.lede : recount(recommendations.lede, waitingClause(all));
  const open = openId ? all.find((row) => row.id === openId) : undefined;

  return (
    <>
      <PhoneTitle title="Recommendations" lede={lede} />

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
        {shown.length === 0 ? (
          <p style={{ margin: "var(--sp-9) 0 0", font: "var(--text-phone-body)", color: "var(--text-3)", textWrap: "pretty" }}>
            {recommendations.rows.length === 0 ? "Nothing to suggest yet. When I notice a pattern worth a rule, it goes here." : "Nothing here under that filter."}
          </p>
        ) : null}
        {GROUPS.map((group) => {
          const rows = shown.filter((row) => row.group === group);
          if (!rows.length) return null;
          return (
            <div key={group}>
              <SectionRule label={group} style={{ padding: "var(--sp-7) 0 var(--sp-4)" }} />
              {rows.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  onOpen={() => onOpen(row.id)}
                  onAnswer={(stance, action) => onAnswer(row.id, stance, row.group === "Waiting on you", action)}
                />
              ))}
            </div>
          );
        })}
      </PhoneBody>

      {open ? (
        <Detail
          row={open}
          detail={detail}
          onAnswer={(stance, action) => onAnswer(open.id, stance, open.group === "Waiting on you", action)}
          onClose={() => onOpen(null)}
        />
      ) : null}
    </>
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
  const [press, setPress] = useState(false);
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
      onPointerDown={() => setPress(true)}
      onPointerUp={() => setPress(false)}
      onPointerLeave={() => setPress(false)}
      style={{
        boxSizing: "border-box",
        cursor: "pointer",
        display: "grid",
        gridTemplateColumns: "18px 1fr",
        gap: "var(--sp-5)",
        alignItems: "start",
        minHeight: "var(--touch)",
        padding: "var(--sp-6) var(--gutter-phone)",
        margin: "0 calc(-1 * var(--gutter-phone))",
        borderTop: "var(--border)",
        background: press ? "var(--surface-hover)" : "transparent",
        // Something you turned down stays readable and stops competing.
        opacity: row.state === "idle" ? 0.62 : 1,
        transition: "background var(--dur) var(--ease)",
      }}
    >
      <StatusMark state={row.state} size={11} style={{ marginTop: 5 }} />
      <span style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "flex-start", gap: "var(--sp-4)", font: "var(--text-phone-head)", color: "var(--text-1)" }}>
          <span style={{ textWrap: "pretty" }}>{row.title}</span>
          {row.state === "attention" ? (
            <Badge tone="attention" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
              needs you
            </Badge>
          ) : null}
        </span>
        <span style={{ font: "var(--text-phone-body)", color: "var(--text-3)", textWrap: "pretty", ...CLAMP_2 }}>{row.blurb}</span>
        <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)", flexWrap: "wrap", ...MONO_META }}>
          <span>{row.basis}</span>
          <span>·</span>
          <span>{row.when.toLowerCase()}</span>
          {settled || !affirm ? (
            <>
              <span>·</span>
              <span style={{ ...CONTROL, color: "var(--text-4)" }}>{LABELS[row.state]}</span>
            </>
          ) : null}
        </span>
        {settled || !affirm ? null : (
          <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--sp-4)", paddingTop: 4 }}>
            <Button
              variant="affirm"
              size="touch"
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
                size="touch"
                onClick={(event) => {
                  event.stopPropagation();
                  onAnswer("declined", quiet);
                }}
                style={CONTROL}
              >
                No
              </Button>
            ) : null}
          </span>
        )}
      </span>
    </div>
  );
}

/** One suggestion. The row already carries the local answer, so the header
 *  and the row you came from cannot disagree about what just happened. */
function Detail({
  row,
  detail,
  onAnswer,
  onClose,
}: {
  row: RecommendationRow;
  detail: Load<RecommendationDetailPayload>;
  onAnswer: (stance: LocalStance, action: HomeAction) => void;
  onClose: () => void;
}) {
  const loaded = detail.status === "ready" && detail.data.id === row.id ? detail.data : null;
  const state = row.state;
  const settled = state !== "attention";
  const [affirm, quiet] = loaded?.actions ?? row.actions;
  const answer = (action: HomeAction) => onAnswer(action.stance === "affirm" ? "adopted" : "declined", action);

  return (
    <Sheet label={LABELS[state]} onClose={onClose} height="var(--sheet-h)" style={{ bottom: "var(--tabbar-total)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--sp-4)" }}>
          <StatusMark state={state} size={12} style={{ marginTop: 7 }} />
          <h2 style={{ margin: 0, font: "var(--text-phone-title)", letterSpacing: "var(--tracking-title)", color: "var(--text-1)", textWrap: "pretty" }}>
            {row.title}
          </h2>
        </div>
        {/* Scope, what it rests on, when — any may be missing. Each part holds
            together and the line wraps between them: a uri broken across two
            lines is a uri you cannot read. */}
        <span style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-4)", font: "var(--text-mono)", color: "var(--text-4)" }}>
          {[row.scope, row.basis, row.when.toLowerCase()]
            .filter((part): part is string => Boolean(part))
            .map((part, i) => (
              <span key={part} style={{ display: "flex", gap: "var(--sp-4)", whiteSpace: "nowrap" }}>
                {i > 0 ? <span>·</span> : null}
                <span>{part}</span>
              </span>
            ))}
        </span>
      </div>

      {detail.status === "error" ? (
        <p style={{ ...PROSE, color: "var(--text-3)" }}>I couldn&rsquo;t open that one — {detail.message}.</p>
      ) : null}

      {settled || !affirm || !quiet ? null : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
          <Button variant="affirm" size="touch" onClick={() => answer(affirm)}>
            {affirm.label}
          </Button>
          <Button size="touch" onClick={() => answer(quiet)}>
            {quiet.label}
          </Button>
          {/* Putting it off would have to write a date to come back on, and
              nothing writes that yet — on either shell. */}
          <Button variant="bare" size="touch" disabled>
            Ask me again later
          </Button>
        </div>
      )}

      {loaded && loaded.prose.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>What I noticed</MonoLabel>
          {loaded.prose.map((p, i) => (
            <p key={i} style={{ ...PROSE, font: "var(--text-phone-lede)" }}>
              {p}
            </p>
          ))}
        </div>
      ) : null}

      {/* The panel is the ask, and it only exists while it is being asked. */}
      {loaded && !settled && loaded.restraint && affirm && quiet ? (
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
          <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>This is the permission I&rsquo;m asking for</span>
          <span style={PROSE}>{loaded.restraint}</span>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
            <Button variant={STANCE_TO_VARIANT[affirm.stance]} size="touch" onClick={() => answer(affirm)}>
              {affirm.label}
            </Button>
            <Button size="touch" onClick={() => answer(quiet)}>
              {quiet.label}
            </Button>
          </div>
        </div>
      ) : null}

      {loaded && loaded.effect.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>{settled ? "What changed" : "What changes if you say yes"}</MonoLabel>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {loaded.effect.map((pair) => (
              <div key={pair.label} style={{ display: "flex", flexDirection: "column", gap: 3, padding: "var(--sp-5) 0", borderTop: "var(--border)" }}>
                <span style={{ font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>{pair.label}</span>
                <span style={{ font: "var(--text-mono)", color: "var(--text-1)", overflowWrap: "anywhere" }}>{pair.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {loaded ? <EvidenceSection items={loaded.evidence.map(asEvidenceItem)} label="What I formed it from" /> : null}

      {loaded && loaded.meta.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>This suggestion</MonoLabel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-5)" }}>
            {loaded.meta.map((pair) => (
              <div key={pair.label} style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                <span style={LABEL}>{pair.label}</span>
                <span style={{ font: "var(--text-phone-body)", color: "var(--text-1)", overflowWrap: "anywhere" }}>{pair.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {loaded?.restraint ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>Where I stopped</MonoLabel>
          <p style={PROSE}>{loaded.restraint}</p>
        </div>
      ) : null}
    </Sheet>
  );
}

/** The wire shape and the kit's shape are the same shape. */
function asEvidenceItem(e: ReminderEvidence): EvidenceItem {
  return e;
}
