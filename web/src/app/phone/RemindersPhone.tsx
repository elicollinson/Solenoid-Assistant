// Reminders at 390px.
//
// The design drew no phone screen for this, so it is the desktop's list and
// detail in the phone's own grammar: rows on hairline rules under the same
// six due-buckets, and a sheet in place of the detail page. What the desktop
// can do here the phone can do — Done and Later from the row or the sheet,
// the gate's buttons, the evidence viewer — and what the desktop cannot yet
// (drop a reminder, edit its rule) is drawn unavailable here too.
import { useState } from "react";
import { Badge, Button, Chip, EvidenceSection, MonoLabel, SectionRule, Sheet, StatusMark, type EvidenceItem } from "../../kit";
import type { HomeAction, HomeState, Load, ReminderDetailPayload, ReminderEvidence, ReminderGroup, ReminderRow, RemindersPayload } from "../api";
import { recount } from "../lede";
import { overdueClause, withLocalMark, type LocalMark } from "../RemindersView";
import { PhoneBody, PhoneTitle } from "./chrome";

const FILTERS = ["All", "Needs you", "Done"] as const;
type Filter = (typeof FILTERS)[number];

const MATCHES: Record<Filter, (row: ReminderRow) => boolean> = {
  All: () => true,
  "Needs you": (row) => row.state === "attention",
  Done: (row) => row.state === "done",
};

/** The order the server buckets them in. */
const GROUPS: readonly ReminderGroup[] = ["Overdue", "Today", "This week", "Later", "Someday", "Closed"];

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

export function RemindersPhone({
  reminders,
  detail,
  openId,
  onOpen,
  marks,
  onMark,
  onInvoke,
}: {
  reminders: RemindersPayload;
  detail: Load<ReminderDetailPayload>;
  openId: string | null;
  onOpen: (id: string | null) => void;
  /** Reminders closed or pushed in the browser this session. */
  marks: ReadonlyMap<string, LocalMark>;
  /** `wasDue` says whether it was counted as due, so the count can stop. */
  onMark: (id: string, mark: LocalMark, wasDue: boolean) => void;
  onInvoke: (action: HomeAction) => void;
}) {
  const [filter, setFilter] = useState<Filter>("All");
  const all = reminders.rows.map((row) => withLocalMark(row, marks));
  const shown = all.filter(MATCHES[filter]);
  // The chip narrows what is drawn; the sentence is about the whole list.
  const lede = marks.size === 0 ? reminders.lede : recount(reminders.lede, overdueClause(all));
  const open = openId ? all.find((row) => row.id === openId) : undefined;

  return (
    <>
      <PhoneTitle title="Reminders" lede={lede} />

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
            Nothing here under that filter.
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
                  onMark={(mark) => onMark(row.id, mark, row.group === "Overdue" || row.group === "Today")}
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
          mark={marks.get(open.id)}
          onMark={(mark, wasDue) => onMark(open.id, mark, wasDue)}
          onClose={() => onOpen(null)}
          onInvoke={onInvoke}
        />
      ) : null}
    </>
  );
}

/** One reminder in the list. A div rather than a button, because Done and
 *  Later are buttons of their own and a button cannot hold one. */
function Row({ row, onOpen, onMark }: { row: ReminderRow; onOpen: () => void; onMark: (mark: LocalMark) => void }) {
  const [press, setPress] = useState(false);
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
        opacity: closed ? 0.62 : 1,
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
        <span style={{ font: "var(--text-phone-body)", color: "var(--text-3)", textWrap: "pretty", ...CLAMP_2 }}>{row.note}</span>
        <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)", flexWrap: "wrap", ...MONO_META }}>
          <span>{row.when.toLowerCase()}</span>
          <span>·</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{row.source}</span>
        </span>
        {closed ? null : (
          <span style={{ display: "flex", gap: "var(--sp-6)", paddingTop: 2 }}>
            <Button
              variant="bare"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                onMark("done");
              }}
              style={{ ...CONTROL, padding: "8px 0", minHeight: 34 }}
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
              style={{ ...CONTROL, padding: "8px 0", minHeight: 34 }}
            >
              Later
            </Button>
          </span>
        )}
      </span>
    </div>
  );
}

/** One reminder. The row is handed in so the sheet has a title and a mark
 *  before the read comes back; the local mark reads through both. */
function Detail({
  row,
  detail,
  mark,
  onMark,
  onClose,
  onInvoke,
}: {
  row: ReminderRow;
  detail: Load<ReminderDetailPayload>;
  mark: LocalMark | undefined;
  onMark: (mark: LocalMark, wasDue: boolean) => void;
  onClose: () => void;
  onInvoke: (action: HomeAction) => void;
}) {
  const loaded = detail.status === "ready" && detail.data.id === row.id ? detail.data : null;
  const state = row.state;
  const closed = state === "done";
  // Whether it was due before any local mark: the mark itself moves it out.
  const wasDue = (loaded?.group ?? row.group) === "Overdue" || (loaded?.group ?? row.group) === "Today";

  return (
    <Sheet label={LABELS[state]} onClose={onClose} height="var(--sheet-h)" style={{ bottom: "var(--tabbar-total)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--sp-4)" }}>
          <StatusMark state={state} size={12} style={{ marginTop: 7 }} />
          <h2 style={{ margin: 0, font: "var(--text-phone-title)", letterSpacing: "var(--tracking-title)", color: "var(--text-1)", textWrap: "pretty" }}>
            {row.title}
          </h2>
        </div>
        <span style={{ font: "var(--text-mono)", color: "var(--text-4)", overflowWrap: "anywhere" }}>
          {[row.group.toLowerCase(), row.when.toLowerCase(), row.source].join(" · ")}
        </span>
      </div>

      {detail.status === "error" ? (
        <p style={{ ...PROSE, color: "var(--text-3)" }}>I couldn&rsquo;t open that one — {detail.message}.</p>
      ) : null}

      {closed ? null : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
          <Button variant="affirm" size="touch" onClick={() => onMark("done", wasDue)}>
            Mark it done
          </Button>
          <Button size="touch" onClick={() => onMark("later", wasDue)}>
            Remind me later
          </Button>
          {/* Forgetting a thing outright is the one action here with no undo,
              and nothing writes it yet — on either shell. */}
          <Button variant="bare" size="touch" disabled>
            Drop it
          </Button>
        </div>
      )}

      {loaded && loaded.prose.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>Why I set this</MonoLabel>
          {loaded.prose.map((p, i) => (
            <p key={i} style={{ ...PROSE, font: "var(--text-phone-lede)" }}>
              {p}
            </p>
          ))}
        </div>
      ) : null}

      {/* A gate is a decision the agent is stopped on; a reminder without one
          is only nagging, and its buttons are offers rather than a question. */}
      {loaded?.gate && !mark ? (
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
          <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>This is the decision I&rsquo;m waiting on</span>
          <span style={PROSE}>{loaded.gate.body ?? loaded.note}</span>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
            {loaded.gate.actions.map((a) => (
              <Button key={a.id} variant={STANCE_TO_VARIANT[a.stance]} size="touch" onClick={() => onInvoke(a)}>
                {a.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {loaded && !loaded.gate && loaded.actions.length > 0 && !closed ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-6)", ...CONTROL }}>
          {loaded.actions.map((a, i) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onInvoke(a)}
              style={{ all: "unset", cursor: "pointer", minHeight: 34, ...CONTROL, color: i === 0 ? "var(--accent-quiet)" : "var(--text-3)" }}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}

      {loaded ? <EvidenceSection items={loaded.evidence.map(asEvidenceItem)} /> : null}

      {loaded ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>What I&rsquo;ve done about it</MonoLabel>
          {loaded.history.length === 0 ? (
            <p style={{ ...PROSE, color: "var(--text-3)" }}>Nothing has happened to this one since I set it.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {loaded.history.map((h) => (
                <div key={`${h.t}-${h.text}`} style={{ display: "flex", flexDirection: "column", gap: 3, padding: "var(--sp-5) 0", borderTop: "var(--border)" }}>
                  <span style={MONO_META}>{h.t}</span>
                  <span style={{ font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>{h.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {loaded && loaded.meta.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>This reminder</MonoLabel>
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

      {loaded?.instruction ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>Standing instruction</MonoLabel>
          <p style={PROSE}>{loaded.instruction}</p>
          {/* Disabled on the desktop as well: a reminder's rule has no write path yet. */}
          <Button variant="bare" size="touch" disabled style={{ alignSelf: "flex-start" }}>
            Edit instructions
          </Button>
        </div>
      ) : null}
    </Sheet>
  );
}

/** The wire shape and the kit's shape are the same shape. */
function asEvidenceItem(e: ReminderEvidence): EvidenceItem {
  return e;
}
