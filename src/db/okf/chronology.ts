// The bundle's own history, read back out of log.md.
//
// The design gives every object a revision, an "Opened" date and a trail. None
// of that is in a memory's frontmatter: `generated.at` is when the file was
// last written, which cannot tell you it was written three times. log.md can —
// it is append-only, dated, and names the concept each entry touched, so the
// revision count and the opening date are derivable rather than invented.
//
// Written as a pure parse over the file's text so it is testable without a
// bundle, and so a malformed line is skipped rather than throwing: the log is
// maintained by the write path and a hand-edit should not stop an index.
import type { LogKind } from "../../okf/logFile";

export interface LogEntry {
  /** "2026-08-25" — the log groups by day and keeps no clock. */
  date: string;
  kind: LogKind | string;
  /** The entry with its markdown links flattened to their text. */
  message: string;
  /** Concept ids the entry links to: "memories/bamps-birthday". */
  targets: string[];
}

export interface Chronology {
  /** Newest first, as the file is written. */
  entries: LogEntry[];
  first: LogEntry;
  last: LogEntry;
}

/**
 * A log date as an instant.
 *
 * log.md records a calendar day and no clock, so midnight UTC is the wrong
 * reading of it: in America/New_York that lands at 20:00 the evening before,
 * and every entry renders a day early. Noon UTC is the same calendar day in
 * every zone the product runs in.
 */
export const dayInstant = (date: string) => new Date(`${date}T12:00:00Z`);

const DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
const ENTRY = /^[*-]\s+\*\*([^*]+)\*\*:\s*(.+?)\.?\s*$/;
const LINK = /\[([^\]]*)\]\(([^)]+)\)/g;

/** "/memories/bamps-birthday.md" and "memories/bamps-birthday.md" both mean
 *  the same concept; a `#fragment` or an off-bundle URL means neither. */
function conceptId(target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return null;
  const path = (target.split("#")[0] ?? "").replace(/^\//, "");
  return path.endsWith(".md") ? path.slice(0, -3) : null;
}

export function parseLog(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  let date: string | null = null;

  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = DATE_HEADING.exec(line);
    if (heading) { date = heading[1] ?? null; continue; }
    if (!date) continue;

    const entry = ENTRY.exec(line);
    if (!entry) continue;

    const body = entry[2] ?? "";
    const targets: string[] = [];
    LINK.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LINK.exec(body)) !== null) {
      const id = conceptId(match[2] ?? "");
      if (id && !targets.includes(id)) targets.push(id);
    }

    entries.push({
      date,
      kind: (entry[1] ?? "").trim(),
      message: body.replace(LINK, "$1").replace(/\s+/g, " ").trim(),
      targets,
    });
  }

  return entries;
}

/**
 * Index the log by the concept each entry names.
 *
 * `entries` keeps the file's newest-first order so it can be rendered as the
 * trail; `first` and `last` are the ends of it, which is what the revision
 * count and the "Opened" date are read off.
 */
export function chronologyByConcept(entries: readonly LogEntry[]): Map<string, Chronology> {
  const byConcept = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    for (const id of entry.targets) {
      const list = byConcept.get(id);
      if (list) list.push(entry);
      else byConcept.set(id, [entry]);
    }
  }

  const out = new Map<string, Chronology>();
  for (const [id, list] of byConcept) {
    // The log is newest-first, but a hand-edit need not be: sort so the ends
    // are the ends. Ties keep file order, which is the only order there is
    // within a day — the log records no clock.
    const sorted = [...list].sort((a, b) => b.date.localeCompare(a.date));
    const first = sorted[sorted.length - 1];
    const last = sorted[0];
    if (first && last) out.set(id, { entries: sorted, first, last });
  }
  return out;
}
