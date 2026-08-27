import { Badge, Button, MonoLabel, Panel, StatusMark } from "../kit";
import type { KnowledgeDetailPayload, KnowledgeField } from "./api";

/* One memory, read out. The design's object page is mostly its field table;
   here the table is conditional and the memory's own prose is not, because
   most of this store states what it knows in sentences rather than in fields. */

/* Field · value · when · where from · provenance. */
const FIELD_COLS = "132px 1fr 76px 116px 132px";

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

const PROSE = {
  margin: 0,
  font: "var(--text-body)",
  color: "var(--text-2)",
  textWrap: "pretty",
  maxWidth: "var(--measure)",
} as const;

export function KnowledgeObject({ memory, onBack }: { memory: KnowledgeDetailPayload; onBack: () => void }) {
  return (
    <main style={{ gridColumn: "2 / span 2", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: "var(--sp-7)", padding: "var(--sp-8) var(--sp-10)", borderBottom: "var(--border)" }}>
        <a
          href="#"
          onClick={(event) => {
            event.preventDefault();
            onBack();
          }}
          style={{ ...CONTROL, color: "var(--text-3)" }}
        >
          ← Things I know
        </a>

        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--sp-9)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-5)", flexWrap: "wrap" }}>
              <StatusMark state={memory.state} size={14} />
              <h1 style={{ margin: 0, font: "var(--text-display)", letterSpacing: "var(--tracking-display)", color: "var(--text-1)", textWrap: "pretty" }}>
                {memory.name}
              </h1>
              <Badge tone={memory.state === "attention" ? "attention" : "neutral"} style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                {memory.kind}
              </Badge>
              {memory.stale ? <Badge style={{ whiteSpace: "nowrap", flexShrink: 0 }}>unchecked</Badge> : null}
            </div>
            <div style={{ display: "flex", gap: "var(--sp-6)", font: "var(--text-mono)", color: "var(--text-4)", flexWrap: "wrap" }}>
              <span>{memory.uri}</span>
              <span>·</span>
              <span>rev {memory.rev}</span>
              <span>·</span>
              <span>{memory.facts === 0 ? "no discrete facts" : `${memory.facts} ${memory.facts === 1 ? "fact" : "facts"}`}</span>
            </div>
          </div>
          {/* Nothing writes to okf/ from here yet. The controls are drawn
              disabled rather than omitted, so the page says what it will do
              rather than pretending this is all a memory can be. */}
          <div style={{ display: "flex", gap: "var(--sp-3)", flexShrink: 0 }}>
            <Button variant="affirm" disabled>Correct something</Button>
            <Button disabled>Add a fact</Button>
            <Button variant="bare" size="sm" disabled>Forget this</Button>
          </div>
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "var(--sp-9) var(--sp-10) var(--sp-10)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: "var(--sp-11)", alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-8)" }}>
            <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
              <MonoLabel>How I came to know this</MonoLabel>
              {memory.account.map((paragraph) => (
                <p key={paragraph} style={PROSE}>
                  {paragraph}
                </p>
              ))}
            </section>

            {memory.conflict ? (
              <Panel tone="alert" style={{ maxWidth: 560 }}>
                <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>I'm holding two answers for one field</span>
                <span style={{ font: "var(--text-body)", color: "var(--text-2)", textWrap: "pretty" }}>{memory.conflict}</span>
                <div style={{ display: "flex", gap: "var(--sp-3)", paddingTop: "var(--sp-2)" }}>
                  <Button variant="affirm" disabled>Keep the newer one</Button>
                  <Button disabled>Keep the older one</Button>
                </div>
              </Panel>
            ) : null}

            {memory.fields.length ? (
              <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
                <MonoLabel>What I have</MonoLabel>
                <div style={{ display: "flex", flexDirection: "column", maxWidth: 760 }}>
                  <div style={{ display: "grid", gridTemplateColumns: FIELD_COLS, gap: "var(--sp-6)", padding: "0 var(--sp-3) var(--sp-4)" }}>
                    <span style={MONO_LABEL}>Field</span>
                    <span style={MONO_LABEL}>Value</span>
                    <span style={MONO_LABEL}>Written</span>
                    <span style={MONO_LABEL}>Where from</span>
                    <span style={MONO_LABEL}>Whose claim</span>
                  </div>
                  {memory.fields.map((field) => (
                    <FieldRow key={field.id} field={field} />
                  ))}
                </div>
              </section>
            ) : null}

            {memory.sections.length ? (
              <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-6)" }}>
                <MonoLabel>The memory, as I wrote it</MonoLabel>
                {memory.sections.map((section, index) => (
                  <div key={`${section.heading}-${index}`} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
                    {section.heading ? (
                      <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>{section.heading}</span>
                    ) : null}
                    {section.paragraphs.map((paragraph, i) => (
                      <p key={i} style={PROSE}>
                        {paragraph}
                      </p>
                    ))}
                  </div>
                ))}
              </section>
            ) : null}

            {memory.trail.length > 1 ? (
              <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
                <MonoLabel>What has changed</MonoLabel>
                <div style={{ display: "flex", flexDirection: "column", maxWidth: 720 }}>
                  {memory.trail.map((line, index) => (
                    <div
                      key={index}
                      style={{ display: "grid", gridTemplateColumns: "116px 84px 1fr", gap: "var(--sp-5)", alignItems: "baseline", padding: "var(--sp-4) var(--sp-3)", borderTop: "var(--border)" }}
                    >
                      <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>{line.t}</span>
                      <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>{line.kind.toLowerCase()}</span>
                      <span style={{ font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>{line.text}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-8)" }}>
            <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
              <MonoLabel>This memory</MonoLabel>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-5)" }}>
                {memory.meta.map((pair) => (
                  <div key={pair.label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={MONO_LABEL}>{pair.label}</span>
                    <span style={{ font: "var(--text-body-sm)", color: "var(--text-1)" }}>{pair.value}</span>
                  </div>
                ))}
              </div>
            </section>

            {memory.tags.length ? (
              <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
                <MonoLabel>Tags</MonoLabel>
                <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
                  {memory.tags.map((tag) => (
                    <span
                      key={tag}
                      style={{ font: "var(--text-mono)", color: "var(--text-3)", background: "var(--surface-sunken)", border: "var(--border)", borderRadius: "var(--radius-control)", padding: "2px var(--sp-3)" }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </section>
            ) : null}

            {/* The design calls this "Where I've used it" and lists reminders
                and runs. Nothing outside the bundle cites a memory yet, so what
                is true here is which other memories name this one. */}
            {memory.refs.length ? (
              <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
                <MonoLabel>{`What links here · ${memory.refs.length}`}</MonoLabel>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {memory.refs.slice(0, 12).map((ref) => (
                    <div key={ref.id} style={{ display: "flex", flexDirection: "column", gap: 3, padding: "var(--sp-5) 0", borderTop: "var(--border)" }}>
                      <span style={{ font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>{ref.label}</span>
                      <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>{ref.when}</span>
                    </div>
                  ))}
                  {memory.refs.length > 12 ? (
                    <span style={{ font: "var(--text-mono)", color: "var(--text-4)", paddingTop: "var(--sp-4)" }}>
                      {`and ${memory.refs.length - 12} more`}
                    </span>
                  ) : null}
                </div>
              </section>
            ) : null}

            {/* Listed, not clickable: a memory cites where it came from, not a
                copy of it, so there is nothing to open. */}
            {memory.sources.length ? (
              <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
                <MonoLabel>Where this came from</MonoLabel>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {memory.sources.map((source, index) => (
                    <div key={index} style={{ display: "flex", flexDirection: "column", gap: 3, padding: "var(--sp-4) 0", borderTop: "var(--border)" }}>
                      <span style={{ font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>{source.title}</span>
                      {source.who ? <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>{source.who}</span> : null}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
              <MonoLabel>The file</MonoLabel>
              <span style={{ font: "var(--text-mono)", color: "var(--text-3)", wordBreak: "break-all" }}>{memory.path}</span>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

function FieldRow({ field }: { field: KnowledgeField }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: FIELD_COLS,
        gap: "var(--sp-6)",
        alignItems: "baseline",
        padding: "var(--sp-5) var(--sp-3)",
        borderTop: "var(--border)",
      }}
    >
      <span style={{ font: "var(--text-mono)", color: "var(--text-3)" }}>{field.label}</span>
      <span style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-4)", minWidth: 0 }}>
        <span style={{ font: "var(--text-body-sm)", color: "var(--text-1)", textWrap: "pretty" }}>{field.value}</span>
        {field.conflict ? <StatusMark state="attention" size={8} style={{ flexShrink: 0, transform: "translateY(-1px)" }} /> : null}
      </span>
      <span style={{ font: "var(--text-mono)", color: "var(--text-4)" }}>{field.when}</span>
      <span style={{ font: "var(--text-mono)", color: "var(--text-4)", textWrap: "pretty" }}>{field.source}</span>
      <span style={{ font: "var(--text-mono)", color: "var(--text-4)", textWrap: "pretty" }}>{field.provenance}</span>
    </div>
  );
}
