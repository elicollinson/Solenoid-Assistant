import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "../core/Button";
import { MonoLabel } from "../core/MonoLabel";
import type { EvidenceKind } from "../types";

/* Universal evidence. A row per artifact the agent looked at; clicking one pops
   out the full source. The clause the agent acted on carries a 3px
   --signal-info left border wherever it appears. */

export interface EvidenceTurn {
  /** "you" renders the user's side a step darker. */
  from?: string;
  name: string;
  t: string;
  text: string;
  pinned?: boolean;
}

export interface EvidenceEmailBody {
  from: string;
  to: string;
  date: string;
  subject: string;
  body: readonly string[];
  quoted?: readonly string[];
  attachments?: readonly string[];
  /** Index into `body` of the paragraph the agent acted on. */
  pinned?: number;
}

export interface EvidenceShotBody {
  file: string;
  dims: string;
  regions: readonly { label: string; note: string }[];
  text?: string;
}

export interface EvidenceArticleBody {
  url: string;
  retrieved: string;
  words: number | string;
  headline: string;
  byline?: string;
  body: readonly string[];
  pinned?: number;
}

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind | string;
  title: string;
  who: string;
  when: string;
  /** "4 messages · 2 pinned" — the mono line under the title. */
  support?: string;
  ref?: string;
  /** Why the agent kept this one, written on the link rather than the source. */
  why?: string;
  messages?: readonly EvidenceTurn[];
  email?: EvidenceEmailBody;
  shot?: EvidenceShotBody;
  article?: EvidenceArticleBody;
}

const KIND_LABEL: Record<string, string> = {
  thread: "texts",
  email: "email",
  screenshot: "screenshot",
  chat: "chat",
  article: "article",
};

const MONO_LABEL: CSSProperties = {
  font: "var(--text-mono-label)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--text-4)",
};
const CONTROL: CSSProperties = {
  font: "var(--text-mono-control)",
  letterSpacing: "var(--tracking-control)",
  textTransform: "uppercase",
};
const PROSE: CSSProperties = {
  margin: 0,
  font: "var(--text-body)",
  color: "var(--text-2)",
  textWrap: "pretty",
  maxWidth: "var(--measure)",
};

const label = (kind: string) => KIND_LABEL[kind] ?? kind;

export function EvidenceSection({ items, label: heading = "What I looked at" }: { items?: readonly EvidenceItem[]; label?: string }) {
  const [open, setOpen] = useState<EvidenceItem | null>(null);
  if (!items || !items.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
      <MonoLabel>{heading}</MonoLabel>
      <EvidenceList items={items} onOpen={setOpen} />
      {open ? <EvidenceViewer item={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

export function EvidenceList({ items, onOpen }: { items: readonly EvidenceItem[]; onOpen: (item: EvidenceItem) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", maxWidth: 720 }}>
      {items.map((it) => (
        <EvidenceRow key={it.id} item={it} onOpen={() => onOpen(it)} />
      ))}
    </div>
  );
}

export function EvidenceRow({ item, onOpen }: { item: EvidenceItem; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        cursor: "pointer",
        display: "grid",
        gridTemplateColumns: "94px 1fr 116px 14px",
        gap: "var(--sp-6)",
        alignItems: "baseline",
        padding: "var(--sp-5) var(--sp-3)",
        borderTop: "var(--border)",
        background: hover ? "var(--surface-hover)" : "transparent",
        transition: "background var(--dur) var(--ease)",
      }}
    >
      <span style={MONO_LABEL}>{label(item.kind)}</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>{item.title}</span>
        <span style={{ font: "var(--text-body-sm)", color: "var(--text-3)", textWrap: "pretty" }}>{item.who}</span>
        {item.support ? <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>{item.support}</span> : null}
      </span>
      <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>{item.when}</span>
      <span style={{ font: "var(--text-mono)", color: hover ? "var(--text-2)" : "var(--text-4)", textAlign: "right" }}>›</span>
    </div>
  );
}

/** Compact reference list. Same items, sidebar weight: a line each, opens the
 *  same source viewer. */
export function EvidenceBrief({ items, label: heading = "Sources behind it" }: { items?: readonly EvidenceItem[]; label?: string }) {
  const [open, setOpen] = useState<EvidenceItem | null>(null);
  if (!items || !items.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
      <MonoLabel>{heading}</MonoLabel>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {items.map((it) => (
          <BriefRow key={it.id} item={it} onOpen={() => setOpen(it)} />
        ))}
      </div>
      {open ? <EvidenceViewer item={open} onClose={() => setOpen(null)} zIndex={60} /> : null}
    </div>
  );
}

function BriefRow({ item, onOpen }: { item: EvidenceItem; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 3,
        padding: "var(--sp-4) var(--sp-3)",
        borderTop: "var(--border)",
        background: hover ? "var(--surface-hover)" : "transparent",
        transition: "background var(--dur) var(--ease)",
      }}
    >
      <span style={{ font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>{item.title}</span>
      <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>
        {label(item.kind)}
        {item.support ? " · " + item.support : ""}
      </span>
    </div>
  );
}

export function EvidenceViewer({ item, onClose, zIndex = 40 }: { item: EvidenceItem; onClose: () => void; zIndex?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const Body = BODIES[item.kind] ?? Unknown;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex, display: "flex", justifyContent: "flex-end" }}>
      <div onClick={onClose} style={{ flex: 1, cursor: "default" }} />
      <aside
        style={{
          width: 640,
          maxWidth: "92vw",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          background: "var(--surface-app)",
          borderLeft: "1px solid var(--line-strong)",
        }}
      >
        <header style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)", padding: "var(--sp-8) var(--sp-9) var(--sp-7)", borderBottom: "var(--border)" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--sp-6)" }}>
            <span style={MONO_LABEL}>{label(item.kind)}</span>
            <Button variant="bare" size="sm" onClick={onClose} style={{ padding: 0, ...CONTROL }}>
              Close
            </Button>
          </div>
          <h2 style={{ margin: 0, font: "var(--text-title)", fontSize: 19, lineHeight: 1.3, color: "var(--text-1)", textWrap: "pretty" }}>{item.title}</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-5)", font: "var(--text-mono)", color: "var(--text-4)" }}>
            <span>{item.who}</span>
            <span>·</span>
            <span>{item.when}</span>
            {item.ref ? (
              <>
                <span>·</span>
                <span>{item.ref}</span>
              </>
            ) : null}
          </div>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "var(--sp-8) var(--sp-9)" }}>
          <Body item={item} />
        </div>

        {item.why ? (
          <footer
            style={{
              padding: "var(--sp-7) var(--sp-9)",
              borderTop: "var(--border)",
              background: "var(--surface-note)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--sp-3)",
            }}
          >
            <span style={MONO_LABEL}>Why I kept this</span>
            <span style={{ font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>{item.why}</span>
          </footer>
        ) : null}
      </aside>
    </div>
  );
}

/* The reusable reader for "where did this one thing come from": a subject (any
   field, value, decision or number in the app), the agent's note on it, and the
   artifacts behind it. `children` renders below the evidence list. */
export function EvidencePanel({
  label: heading = "field",
  title,
  value,
  meta,
  note,
  evidence,
  evidenceLabel = "What this came from",
  onClose,
  children,
}: {
  label?: string;
  title: ReactNode;
  value?: ReactNode;
  meta?: readonly (readonly [string, string])[];
  note?: string;
  evidence?: readonly EvidenceItem[];
  evidenceLabel?: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState<EvidenceItem | null>(null);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (open) setOpen(null);
      else onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, open]);

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 40, display: "flex", justifyContent: "flex-end" }}>
        <div onClick={onClose} style={{ flex: 1, cursor: "default" }} />
        <aside
          style={{
            width: 520,
            maxWidth: "92vw",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            background: "var(--surface-app)",
            borderLeft: "1px solid var(--line-strong)",
            opacity: open ? 0.4 : 1,
            transition: "opacity var(--dur) var(--ease)",
          }}
        >
          <header style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)", padding: "var(--sp-8) var(--sp-9) var(--sp-7)", borderBottom: "var(--border)" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "var(--sp-6)" }}>
              <span style={MONO_LABEL}>{heading}</span>
              <Button variant="bare" size="sm" onClick={onClose} style={{ padding: 0, ...CONTROL }}>
                Close
              </Button>
            </div>
            <h2 style={{ margin: 0, font: "var(--text-mono)", fontSize: 13, color: "var(--text-3)" }}>{title}</h2>
            {value ? <span style={{ font: "var(--text-title)", fontSize: 19, lineHeight: 1.3, color: "var(--text-1)", textWrap: "pretty" }}>{value}</span> : null}
            {meta && meta.length ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-5)", font: "var(--text-mono)", color: "var(--text-4)" }}>
                {meta.map(([k, v], i) => (
                  <span key={k} style={{ display: "flex", gap: "var(--sp-5)" }}>
                    {i ? <span>·</span> : null}
                    <span>
                      {k} {v}
                    </span>
                  </span>
                ))}
              </div>
            ) : null}
          </header>

          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "var(--sp-8) var(--sp-9)", display: "flex", flexDirection: "column", gap: "var(--sp-8)" }}>
            {note ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
                <span style={MONO_LABEL}>Why I hold it this way</span>
                <p style={{ ...PROSE, font: "var(--text-body-sm)" }}>{note}</p>
              </div>
            ) : null}

            <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
              <span style={MONO_LABEL}>{evidenceLabel}</span>
              {evidence && evidence.length ? (
                <EvidenceList items={evidence} onOpen={setOpen} />
              ) : (
                <p style={{ ...PROSE, font: "var(--text-body-sm)", color: "var(--text-3)" }}>
                  I kept the fact and not the source. That predates the point where I started filing what I read.
                </p>
              )}
            </div>

            {children}
          </div>
        </aside>
      </div>
      {open ? <EvidenceViewer item={open} onClose={() => setOpen(null)} zIndex={60} /> : null}
    </>
  );
}

/* ── kind bodies ───────────────────────────────────────────── */

function Turn({ m }: { m: EvidenceTurn }) {
  const mine = m.from === "you";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "96px 1fr", gap: "var(--sp-6)", alignItems: "baseline", padding: "var(--sp-5) 0", borderTop: "var(--border)" }}>
      <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ ...MONO_LABEL, color: mine ? "var(--text-3)" : "var(--text-4)" }}>{m.name}</span>
        <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>{m.t}</span>
      </span>
      <span
        style={{
          font: "var(--text-body)",
          color: "var(--text-2)",
          textWrap: "pretty",
          ...(m.pinned
            ? {
                borderLeft: "3px solid var(--signal-info)",
                background: "var(--surface-raised)",
                padding: "var(--sp-4) var(--sp-5)",
                borderRadius: "var(--radius-control)",
                color: "var(--text-1)",
              }
            : null),
        }}
      >
        {m.text}
      </span>
    </div>
  );
}

function Thread({ item }: { item: EvidenceItem }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {(item.messages ?? []).map((m, i) => (
        <Turn key={i} m={m} />
      ))}
    </div>
  );
}

function Chat({ item }: { item: EvidenceItem }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-6)" }}>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {(item.messages ?? []).map((m, i) => (
          <Turn key={i} m={m} />
        ))}
      </div>
      <div style={{ borderTop: "var(--border)", paddingTop: "var(--sp-5)", ...MONO_LABEL }}>Read only · this conversation is closed</div>
    </div>
  );
}

function Email({ item }: { item: EvidenceItem }) {
  const e = item.email;
  if (!e) return <Unknown item={item} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-7)" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "72px 1fr",
          gap: "var(--sp-4) var(--sp-6)",
          padding: "var(--sp-6)",
          background: "var(--surface-raised)",
          border: "var(--border)",
          borderRadius: "var(--radius-card)",
        }}
      >
        {([["From", e.from], ["To", e.to], ["Date", e.date], ["Subject", e.subject]] as const).map(([k, v]) => (
          <span key={k} style={{ display: "contents" }}>
            <span style={MONO_LABEL}>{k}</span>
            <span style={{ font: "var(--text-body-sm)", color: "var(--text-1)" }}>{v}</span>
          </span>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
        {e.body.map((p, i) => (
          <p key={i} style={{ ...PROSE, ...(e.pinned === i ? { borderLeft: "3px solid var(--signal-info)", paddingLeft: "var(--sp-5)", color: "var(--text-1)" } : null) }}>
            {p}
          </p>
        ))}
      </div>
      {e.quoted ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)", borderLeft: "var(--border)", paddingLeft: "var(--sp-6)" }}>
          <span style={MONO_LABEL}>Quoted</span>
          {e.quoted.map((p, i) => (
            <p key={i} style={{ ...PROSE, font: "var(--text-body-sm)", color: "var(--text-4)" }}>
              {p}
            </p>
          ))}
        </div>
      ) : null}
      {e.attachments ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
          <span style={MONO_LABEL}>Attached</span>
          {e.attachments.map((a) => (
            <span key={a} style={{ font: "var(--text-mono)", color: "var(--text-3)", padding: "var(--sp-3) var(--sp-4)", border: "var(--border)", borderRadius: "var(--radius-control)" }}>
              {a}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Screenshot({ item }: { item: EvidenceItem }) {
  const s = item.shot;
  if (!s) return <Unknown item={item} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-6)" }}>
      <div
        style={{
          background: "var(--surface-sunken)",
          border: "var(--border)",
          borderRadius: "var(--radius-card)",
          height: 300,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>
          {s.file} · {s.dims}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {s.regions.map((r) => (
          <div
            key={r.label}
            style={{ display: "grid", gridTemplateColumns: "96px 1fr", gap: "var(--sp-6)", alignItems: "baseline", padding: "var(--sp-5) 0", borderTop: "var(--border)" }}
          >
            <span style={MONO_LABEL}>{r.label}</span>
            <span style={{ font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>{r.note}</span>
          </div>
        ))}
      </div>
      {s.text ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
          <span style={MONO_LABEL}>Text I read off it</span>
          <div
            style={{
              font: "var(--text-mono)",
              color: "var(--text-2)",
              lineHeight: 1.7,
              background: "var(--surface-raised)",
              border: "var(--border)",
              borderRadius: "var(--radius-card)",
              padding: "var(--sp-6)",
              whiteSpace: "pre-wrap",
            }}
          >
            {s.text}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Article({ item }: { item: EvidenceItem }) {
  const a = item.article;
  if (!a) return <Unknown item={item} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-6)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)", paddingBottom: "var(--sp-6)", borderBottom: "var(--border)" }}>
        <span style={{ font: "var(--text-mono)", color: "var(--text-4)", wordBreak: "break-all" }}>{a.url}</span>
        <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>
          retrieved {a.retrieved} · {a.words} words
        </span>
      </div>
      <h3 style={{ margin: 0, font: "var(--text-title)", color: "var(--text-1)", textWrap: "pretty" }}>{a.headline}</h3>
      {a.byline ? <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>{a.byline}</span> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
        {a.body.map((p, i) => (
          <p key={i} style={{ ...PROSE, ...(a.pinned === i ? { borderLeft: "3px solid var(--signal-info)", paddingLeft: "var(--sp-5)", color: "var(--text-1)" } : null) }}>
            {p}
          </p>
        ))}
      </div>
      <Button variant="bare" size="sm" style={{ alignSelf: "flex-start", padding: 0, ...CONTROL }}>
        Open the original →
      </Button>
    </div>
  );
}

function Unknown({ item }: { item: EvidenceItem }) {
  return <p style={PROSE}>I kept a reference to this but can&rsquo;t render it here: {item.ref}</p>;
}

const BODIES: Record<string, (props: { item: EvidenceItem }) => ReactNode> = {
  thread: Thread,
  chat: Chat,
  email: Email,
  screenshot: Screenshot,
  article: Article,
};
