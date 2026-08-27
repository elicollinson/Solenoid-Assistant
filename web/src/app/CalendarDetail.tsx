import { Badge, Button, MonoLabel, StatusMark } from "../kit";
import type { ButtonVariant } from "../kit";
import type { CalendarItem, CalendarKind, CalendarMark, HomeAction, Load } from "./api";
import type { CalendarDetailPayload } from "./api";

/** What one block is, said in the singular — the legend says it in the plural
 *  because the legend is about the canvas. */
const KIND_LABEL: Record<CalendarKind, string> = {
  event: "yours",
  run: "my run",
  reminder: "reminder",
  hold: "held slot",
};

const STATE_LABEL: Record<CalendarMark, string> = {
  attention: "needs you",
  running: "running",
  done: "done",
  failed: "failed",
};

const VARIANT: Record<HomeAction["stance"], ButtonVariant> = {
  affirm: "affirm",
  neutral: "quiet",
  quiet: "quiet",
  danger: "danger",
  bare: "bare",
};

const CONTROL = {
  font: "var(--text-mono-control)",
  letterSpacing: "var(--tracking-control)",
  textTransform: "uppercase",
} as const;

/**
 * One thing on the canvas, opened.
 *
 * The block already carries what this is, when it is and how it is marked, so
 * the header draws from the block and only the account, the pairs and the way
 * through wait on the read. Clicking a block and watching its own title blink
 * out and back is the one thing an aside must not do.
 */
export function CalendarDetail({
  item,
  detail,
  onClose,
  onInvoke,
}: {
  item: CalendarItem;
  detail: Load<CalendarDetailPayload>;
  onClose: () => void;
  onInvoke: (action: HomeAction) => void;
}) {
  const shown = detail.status === "ready" ? detail.data : null;

  return (
    <aside
      style={{
        gridColumn: "3",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderLeft: "var(--border)",
        background: "var(--surface-panel)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--sp-5)",
          padding: "var(--sp-7) var(--sp-8) var(--sp-5)",
          borderBottom: "var(--border)",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)" }}>
          {item.state ? <StatusMark state={item.state} size={11} /> : null}
          <MonoLabel>{KIND_LABEL[item.kind]}</MonoLabel>
        </span>
        <Button variant="bare" size="sm" onClick={onClose} style={{ ...CONTROL, padding: 0 }}>
          Close
        </Button>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-8)",
          padding: "var(--sp-8)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
          <h2 style={{ margin: 0, font: "600 19px/1.3 var(--font-ui)", letterSpacing: "-0.01em", color: "var(--text-1)", textWrap: "pretty" }}>
            {item.title}
          </h2>
          <span style={{ font: "var(--text-mono)", color: "var(--text-3)" }}>{shown?.when ?? item.meta}</span>
          {item.state ? (
            <Badge
              tone={item.state === "attention" ? "attention" : item.state === "running" ? "running" : "neutral"}
              style={{ alignSelf: "flex-start" }}
            >
              {STATE_LABEL[item.state]}
            </Badge>
          ) : null}
        </div>

        {detail.status === "error" ? (
          <p style={{ margin: 0, font: "var(--text-body-sm)", color: "var(--text-3)", textWrap: "pretty" }}>
            I couldn&rsquo;t open it — {detail.message}.
          </p>
        ) : null}

        {shown && shown.account.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
            <MonoLabel>Why it is here</MonoLabel>
            {shown.account.map((paragraph) => (
              <p key={paragraph} style={{ margin: 0, font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>
                {paragraph}
              </p>
            ))}
          </div>
        ) : null}

        {shown && shown.pairs.length > 0 ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-5)" }}>
            {shown.pairs.map((pair) => (
              <div key={pair.label} style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                <span
                  style={{
                    font: "var(--text-mono-label)",
                    letterSpacing: "var(--tracking-label)",
                    textTransform: "uppercase",
                    color: "var(--text-4)",
                  }}
                >
                  {pair.label}
                </span>
                <span style={{ font: "var(--text-body-sm)", color: "var(--text-1)", textWrap: "pretty" }}>{pair.value}</span>
              </div>
            ))}
          </div>
        ) : null}

        {shown && shown.actions.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-3)" }}>
            {shown.actions.map((action) => (
              <Button key={action.id} variant={VARIANT[action.stance]} onClick={() => onInvoke(action)}>
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}

        {shown?.link ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--sp-4)",
              paddingTop: "var(--sp-5)",
              borderTop: "var(--border)",
            }}
          >
            <MonoLabel>Where this came from</MonoLabel>
            {/* Not a button. This is the same object seen from the screen that
                owns it, and the way there reads as a link. */}
            <a
              href="#"
              onClick={(event) => {
                event.preventDefault();
                if (shown.link) onInvoke(shown.link);
              }}
              style={{ font: "var(--text-body-sm)", color: "var(--accent)" }}
            >
              {shown.link.label} →
            </a>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
