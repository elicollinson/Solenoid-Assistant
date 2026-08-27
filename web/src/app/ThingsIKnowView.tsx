import { useState } from "react";
import { Badge, Chip, SectionRule, StatusMark } from "../kit";
import type { KnowledgePayload, KnowledgeRow } from "./api";

/* The OKF renderer: everything I hold about you, grouped by what it is about.
   The design draws six objects and needs no way to find one. This store has
   314, so the chips are joined by a filter box — client-side, because 314 rows
   filter faster than a round trip. When it outgrows that, search.ts has the
   FTS5 table waiting. */

/* Status · name and blurb · uri · facts · when. */
const COLS = "26px 1fr 232px 108px 116px";

const MONO = { font: "var(--text-mono)", color: "var(--text-4)", paddingTop: 2 } as const;

function matches(row: KnowledgeRow, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return row.name.toLowerCase().includes(needle) || row.blurb.toLowerCase().includes(needle) || row.uri.toLowerCase().includes(needle);
}

export function ThingsIKnowView({ knowledge, onOpen }: { knowledge: KnowledgePayload; onOpen: (id: string) => void }) {
  const [group, setGroup] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const shown = knowledge.rows.filter((row) => (group === null || row.group === group) && matches(row, query));

  return (
    <main style={{ gridColumn: "2 / span 2", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: "var(--sp-6)", padding: "var(--sp-9) var(--sp-10) 18px", borderBottom: "var(--border)" }}>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "var(--sp-9)" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
            <h1 style={{ margin: 0, font: "var(--text-display)", letterSpacing: "var(--tracking-display)", color: "var(--text-1)" }}>
              Things I know
            </h1>
            <p style={{ margin: 0, font: "var(--text-body)", color: "var(--text-3)", textWrap: "pretty", maxWidth: "var(--measure)" }}>
              {knowledge.lede}
            </p>
          </div>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a memory"
            aria-label="Find a memory"
            style={{
              flexShrink: 0,
              width: 220,
              font: "var(--text-body-sm)",
              color: "var(--text-1)",
              background: "var(--surface-sunken)",
              border: "var(--border)",
              borderRadius: "var(--radius-control)",
              padding: "var(--sp-3) var(--sp-4)",
              outline: "none",
            }}
          />
        </div>

        <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
          {knowledge.filters.map((filter) => (
            <Chip key={filter.label} selected={group === filter.group} onClick={() => setGroup(filter.group)}>
              {`${filter.label} ${filter.count}`}
            </Chip>
          ))}
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 var(--sp-10) var(--sp-10)" }}>
        {shown.length === 0 ? (
          <p style={{ margin: 0, padding: "var(--sp-9) 0", font: "var(--text-body)", color: "var(--text-3)" }}>
            {`Nothing here matches "${query}". I only search what I've written down, not what I could work out.`}
          </p>
        ) : (
          knowledge.groups.map((name) => {
            const rows = shown.filter((row) => row.group === name);
            if (!rows.length) return null;
            return (
              <div key={name}>
                <SectionRule label={`${name} · ${rows.length}`} />
                {rows.map((row) => (
                  <Row key={row.id} row={row} onOpen={() => onOpen(row.id)} />
                ))}
              </div>
            );
          })
        )}
      </div>
    </main>
  );
}

function Row({ row, onOpen }: { row: KnowledgeRow; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        cursor: "pointer",
        display: "grid",
        gridTemplateColumns: COLS,
        gap: "var(--sp-6)",
        alignItems: "start",
        padding: "var(--sp-6) var(--sp-3)",
        borderTop: "var(--border)",
        background: hover ? "var(--surface-hover)" : "transparent",
        transition: "background var(--dur) var(--ease)",
      }}
    >
      <StatusMark state={row.state} style={{ marginTop: 4 }} />
      <span style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: "var(--sp-4)", font: "var(--text-title)", color: "var(--text-1)" }}>
          {row.name}
          {row.state === "attention" ? <Badge tone="attention" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>needs you</Badge> : null}
          {row.stale ? <Badge style={{ whiteSpace: "nowrap", flexShrink: 0 }}>unchecked</Badge> : null}
        </span>
        <span
          style={{
            font: "var(--text-body-sm)",
            color: "var(--text-3)",
            maxWidth: "var(--measure)",
            textWrap: "pretty",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {row.blurb}
        </span>
      </span>
      <span style={MONO}>{row.uri.replace(/^okf:memories\//, "")}</span>
      {/* Most memories state what they know in prose, so a zero here is the
          common case and reads better as a dash than as "0 facts". */}
      <span style={MONO}>{row.facts === 0 ? "—" : `${row.facts} ${row.facts === 1 ? "fact" : "facts"}`}</span>
      <span style={{ ...MONO, color: "var(--text-3)", textAlign: "right" }}>{row.when}</span>
    </div>
  );
}
