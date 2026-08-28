// Things I know, at 390px.
//
// The desktop draws the store as a table with a column for the uri, the facts,
// the group and the date. None of that fits, so a memory becomes a row of three
// lines — its name, what it is, and the machine facts — and everything else
// waits behind a tap. A field becomes two lines with its provenance note folded
// under it, because the note is the interesting half and a column would have
// truncated it.
//
// What the phone does not do is show every memory's own phone-length blurb. The
// design writes six by hand; this store holds three hundred, and they come out
// of `okf/` rather than out of the seed. The row draws the blurb the projection
// derived, which is the same sentence the desktop draws.
import { useState } from "react";
import { Badge, Button, Chip, MonoLabel, SectionRule, Sheet, StatusMark } from "../../kit";
import type { KnowledgeDetailPayload, KnowledgePayload, KnowledgeRow, Load } from "../api";
import { PhoneBody, PhoneRestraint, PhoneTitle } from "./chrome";

const MONO_META = { font: "var(--text-mono-meta)", color: "var(--text-4)" } as const;

/**
 * Two lines, then an ellipsis.
 *
 * The design's six memories are named like people — "Marta Vance" — and fit on
 * one line. This store's three hundred are named like sentences, and an
 * unclamped row runs to 357px: two and a half rows to a screen, and the list
 * becomes 60,000px of scrolling. The desktop already clamps its blurb for the
 * same reason; the phone has to clamp the name as well, because here the name
 * is the long half.
 */
const CLAMP_2 = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
  minWidth: 0,
} as const;

const LABEL = {
  font: "var(--text-mono-label)",
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--text-4)",
} as const;

export function MemoryPhone({
  knowledge,
  detail,
  openId,
  onOpen,
}: {
  knowledge: KnowledgePayload;
  detail: Load<KnowledgeDetailPayload>;
  openId: string | null;
  onOpen: (id: string | null) => void;
}) {
  const [group, setGroup] = useState<string | null>(null);

  const shown = group ? knowledge.rows.filter((row) => row.group === group) : knowledge.rows;
  const open = openId ? knowledge.rows.find((row) => row.id === openId) : undefined;

  return (
    <>
      <PhoneTitle title="Things I know" lede={knowledge.lede} />

      <div style={{ display: "flex", gap: "var(--sp-2)", padding: "0 var(--gutter-phone) var(--sp-6)", overflowX: "auto", flexShrink: 0 }}>
        {knowledge.filters.map((filter) => (
          <Chip
            key={filter.label}
            selected={group === filter.group}
            onClick={() => {
              setGroup(filter.group);
              onOpen(null);
            }}
            style={{ flexShrink: 0, minHeight: 34 }}
          >
            {filter.label}
          </Chip>
        ))}
      </div>

      <PhoneBody style={{ borderTop: "var(--border)", background: "var(--surface-panel)" }}>
        {knowledge.groups.map((name) => {
          const rows = shown.filter((row) => row.group === name);
          if (!rows.length) return null;
          return (
            <div key={name}>
              <SectionRule label={name} style={{ padding: "var(--sp-7) 0 var(--sp-4)" }} />
              {rows.map((row) => (
                <Row key={row.id} row={row} onOpen={() => onOpen(row.id)} />
              ))}
            </div>
          );
        })}
        <PhoneRestraint>{knowledge.restraint}</PhoneRestraint>
      </PhoneBody>

      {open ? <Detail row={open} detail={detail} onClose={() => onOpen(null)} /> : null}
    </>
  );
}

function Row({ row, onOpen }: { row: KnowledgeRow; onOpen: () => void }) {
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
        minHeight: "var(--touch)",
        padding: "var(--sp-6) var(--gutter-phone)",
        margin: "0 calc(-1 * var(--gutter-phone))",
        borderTop: "var(--border)",
        background: press ? "var(--surface-hover)" : "transparent",
        transition: "background var(--dur) var(--ease)",
      }}
    >
      <StatusMark state={row.state} size={11} style={{ marginTop: 5 }} />
      <span style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "flex-start", gap: "var(--sp-4)", font: "var(--text-phone-head)", color: "var(--text-1)" }}>
          <span style={CLAMP_2}>{row.name}</span>
          {row.state === "attention" ? (
            <Badge tone="attention" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
              needs you
            </Badge>
          ) : null}
        </span>
        {row.blurb ? (
          <span style={{ font: "var(--text-phone-body)", color: "var(--text-3)", textWrap: "pretty", ...CLAMP_2 }}>{row.blurb}</span>
        ) : null}
        <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)", ...MONO_META }}>
          {/* Most memories state what they know in prose, so "0 facts" is the
              common case and says nothing. The desktop prints a dash in its
              column; the phone has no column, so it prints nothing at all. */}
          {row.facts > 0 ? (
            <>
              <span>{row.facts === 1 ? "1 fact" : `${row.facts} facts`}</span>
              <span>·</span>
            </>
          ) : null}
          <span>{row.when}</span>
          {row.stale ? <span style={{ color: "var(--signal-amber-text)" }}>· due a check</span> : null}
        </span>
      </span>
    </button>
  );
}

/** One memory. The row is drawn from what the list already holds, so the sheet
 *  has a title and a mark before the read comes back. */
function Detail({
  row,
  detail,
  onClose,
}: {
  row: KnowledgeRow;
  detail: Load<KnowledgeDetailPayload>;
  onClose: () => void;
}) {
  const loaded = detail.status === "ready" && detail.data.id === row.id ? detail.data : null;

  return (
    <Sheet label={row.kind} onClose={onClose} height="var(--sheet-h)" style={{ bottom: "var(--tabbar-total)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
        {/* Top-aligned, not centred: these names run to two lines, and a mark
            centred against two lines sits in the gap between them looking
            detached from both. */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--sp-4)" }}>
          <StatusMark state={row.state} size={12} style={{ marginTop: 7 }} />
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
        {/* Only the uri breaks mid-token: it is one long unspaced string with
            nowhere else to break. Applying that to the whole line put "facts"
            on a line of its own underneath "0". */}
        <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>
          <span style={{ wordBreak: "break-all" }}>{row.uri}</span>
          {loaded ? <span style={{ whiteSpace: "nowrap" }}> · rev {loaded.rev}</span> : null}
          {row.facts > 0 ? (
            <span style={{ whiteSpace: "nowrap" }}> · {row.facts === 1 ? "1 fact" : `${row.facts} facts`}</span>
          ) : null}
        </span>
      </div>

      {detail.status === "error" ? (
        <p style={{ margin: 0, font: "var(--text-phone-body)", color: "var(--text-3)", textWrap: "pretty" }}>
          I couldn&rsquo;t open that one — {detail.message}.
        </p>
      ) : null}

      {row.blurb ? (
        <p style={{ margin: 0, font: "var(--text-phone-lede)", color: "var(--text-2)", textWrap: "pretty" }}>{row.blurb}</p>
      ) : null}

      {loaded?.conflict ? (
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
          <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>Two answers for one field</span>
          <span style={{ font: "var(--text-phone-body)", color: "var(--text-2)", textWrap: "pretty" }}>{loaded.conflict}</span>
          {/* Drawn disabled, like every other write here: `okf/` is the source
              of truth for memory and nothing in this app writes to it yet. The
              design draws both ways out, and a conflict panel that states the
              problem and offers no answer is the screen shrugging. */}
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
            <Button variant="affirm" size="touch" disabled>
              Keep the newer one
            </Button>
            <Button size="touch" disabled>
              Keep the older one
            </Button>
          </div>
        </div>
      ) : null}

      {loaded && loaded.account.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>How I came to know this</MonoLabel>
          {loaded.account.map((p) => (
            <p key={p} style={{ margin: 0, font: "var(--text-phone-body)", color: "var(--text-2)", textWrap: "pretty" }}>
              {p}
            </p>
          ))}
        </div>
      ) : null}

      {loaded && loaded.fields.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>What I have</MonoLabel>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {loaded.fields.map((field) => (
              <Field key={field.id} field={field} />
            ))}
          </div>
        </div>
      ) : null}

      {loaded && loaded.sections.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>As I wrote it down</MonoLabel>
          {loaded.sections.map((section) => (
            <div key={section.heading} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
              {section.heading ? <span style={LABEL}>{section.heading}</span> : null}
              {section.paragraphs.map((p) => (
                <p key={p} style={{ margin: 0, font: "var(--text-phone-body)", color: "var(--text-2)", textWrap: "pretty" }}>
                  {p}
                </p>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {loaded && loaded.meta.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>This memory</MonoLabel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-5)" }}>
            {loaded.meta.map((pair) => (
              <div key={pair.label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={LABEL}>{pair.label}</span>
                <span style={{ font: "var(--text-phone-body)", color: "var(--text-1)" }}>{pair.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {loaded && loaded.refs.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>Where I&rsquo;ve used it</MonoLabel>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {loaded.refs.map((ref) => (
              <div key={ref.id} style={{ display: "flex", flexDirection: "column", gap: 3, padding: "var(--sp-5) 0", borderTop: "var(--border)" }}>
                <span style={{ font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>{ref.label}</span>
                <span style={MONO_META}>{ref.when}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {loaded && loaded.sources.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
          <MonoLabel>Where it came from</MonoLabel>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {loaded.sources.map((source) => (
              <div
                key={source.title}
                style={{ display: "flex", flexDirection: "column", gap: 3, padding: "var(--sp-5) 0", borderTop: "var(--border)" }}
              >
                <span style={{ font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>{source.title}</span>
                <span style={MONO_META}>{source.who}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Correcting a memory writes to `okf/`, and nothing here writes yet. The
          buttons are the design's and they are drawn as unavailable rather than
          left out, so the screen does not quietly imply the store is read-only. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
        <Button variant="affirm" size="touch" disabled>
          Correct something
        </Button>
        <Button size="touch" disabled>
          Add a fact
        </Button>
        <Button variant="bare" size="touch" disabled>
          Forget this
        </Button>
      </div>
    </Sheet>
  );
}

/** A field, with its provenance note folded under it. Tapping opens the note —
 *  which is the half worth reading, and the half a column would have cut. */
function Field({ field }: { field: KnowledgeDetailPayload["fields"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minHeight: "var(--touch)",
        padding: "var(--sp-5) 0",
        borderTop: "var(--border)",
        background: open ? "var(--surface-hover)" : "transparent",
        transition: "background var(--dur) var(--ease)",
      }}
    >
      <span style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-4)" }}>
        <span style={LABEL}>{field.label}</span>
        {field.conflict ? <StatusMark state="attention" size={8} /> : null}
        <span style={{ marginLeft: "auto", font: "var(--text-mono-meta)", color: open ? "var(--text-2)" : "var(--text-4)" }}>
          {open ? "−" : "+"}
        </span>
      </span>
      <span style={{ font: "var(--text-phone-lede)", color: "var(--text-1)", textWrap: "pretty" }}>{field.value}</span>
      <span style={MONO_META}>
        {field.when} · {field.source}
      </span>
      {open && field.provenance ? (
        <span style={{ font: "var(--text-phone-note)", color: "var(--text-3)", textWrap: "pretty", paddingTop: "var(--sp-3)" }}>
          {field.provenance}
        </span>
      ) : null}
    </button>
  );
}
