// log.md maintenance (§9).
//
// Appended by the write path, never by the model — same reasoning as index.md.
// Entries land in the bundle-root log so there is exactly one chronology per
// bundle; §9 permits per-directory logs, but two writers for one event is how
// histories start disagreeing.
import { join } from "node:path";
import { LOG_FILENAME, writeFileAtomic, type Bundle } from "./bundle";
import { isoDate } from "./trust";

export type LogKind = "Creation" | "Update" | "Move" | "Deprecation" | "Initialization";

const TITLE = "# Bundle Update Log";
const DATE_HEADING_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;

export async function appendLogEntry(
  bundle: Bundle,
  kind: LogKind,
  message: string,
): Promise<void> {
  const path = join(bundle.root, LOG_FILENAME);
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : "";
  await writeFileAtomic(path, insertEntry(existing, isoDate(bundle.now()), kind, message));
}

/** Pure insertion, so the date-grouping rules are testable without a filesystem. */
export function insertEntry(
  existing: string,
  date: string,
  kind: LogKind,
  message: string,
): string {
  const entry = `* **${kind}**: ${message}`;
  const lines = existing.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const hasTitle = (lines[0] ?? "").startsWith("# ");
  const title = hasTitle ? (lines[0] as string) : TITLE;
  const rest = hasTitle ? lines.slice(1) : lines;

  const headings: { index: number; date: string }[] = [];
  rest.forEach((line, index) => {
    const found = DATE_HEADING_RE.exec(line.trim())?.[1];
    if (found) headings.push({ index, date: found });
  });

  const next = [...rest];
  const sameDay = headings.find((h) => h.date === date);
  if (sameDay) {
    next.splice(sameDay.index + 1, 0, entry); // newest-first inside the group too
  } else {
    // Date groups are newest-first, so a new group goes above the first group
    // older than it — which is the top for today's entry and the bottom for a
    // backdated one. With no groups at all it goes first, pushing any
    // placeholder prose down.
    const older = headings.find((h) => h.date < date);
    const at = older ? older.index : headings.length === 0 ? 0 : next.length;
    next.splice(at, 0, `## ${date}`, entry, "");
  }

  const body = next.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return `${title}\n\n${body}\n`;
}
