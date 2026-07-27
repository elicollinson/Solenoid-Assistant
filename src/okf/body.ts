// Section-addressed body edits.
//
// Bodies are edited by heading, not by exact-string match: §4.2 already
// conventionalizes headings (`# Schema`, `# Examples`, `# Computation`), and a
// heading is a target small local models hit reliably where an exact-string
// anchor is a coin flip. Every op names the section it acts on and fails loudly
// when the precondition is wrong, so a wrong guess costs one cheap tool error
// rather than a silent clobber.
import { OkfError } from "./bundle";

export interface Section {
  level: number;
  title: string;
  /** Line index of the heading itself. */
  headingLine: number;
  /** First line of content after the heading. */
  contentStart: number;
  /** Line index one past the last line of the section. */
  end: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s{0,3}(```+|~~~+)/;

/**
 * Headings in a markdown body, ignoring anything inside a fenced code block —
 * a `# comment` line inside a computation fence is not a section.
 */
export function parseSections(body: string): Section[] {
  const lines = body.split("\n");
  const headings: { level: number; title: string; line: number }[] = [];
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (fence === null) fence = marker[0] === "`" ? "`" : "~";
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = HEADING_RE.exec(line);
    if (match) {
      headings.push({ level: (match[1] ?? "").length, title: (match[2] ?? "").trim(), line: i });
    }
  }

  return headings.map((heading, idx) => {
    // A section ends at the next heading of the same or higher rank, so
    // subsections travel with their parent.
    let end = lines.length;
    for (let j = idx + 1; j < headings.length; j++) {
      const next = headings[j];
      if (next && next.level <= heading.level) {
        end = next.line;
        break;
      }
    }
    return {
      level: heading.level,
      title: heading.title,
      headingLine: heading.line,
      contentStart: heading.line + 1,
      end,
    };
  });
}

export function findSection(body: string, title: string): Section | undefined {
  const wanted = title.trim().toLowerCase();
  return parseSections(body).find((s) => s.title.toLowerCase() === wanted);
}

export function sectionContent(body: string, section: Section): string {
  return body
    .split("\n")
    .slice(section.contentStart, section.end)
    .join("\n")
    .trim();
}

export type BodyOp =
  | { op: "replace"; section: string; content: string }
  | { op: "append"; section: string; content: string }
  | { op: "add"; section: string; content: string; level?: number }
  | { op: "delete"; section: string }
  | { op: "replaceAll"; content: string };

export function applyBodyOp(body: string, op: BodyOp): string {
  if (op.op === "replaceAll") return normalize(op.content);

  const existing = findSection(body, op.section);

  if (op.op === "add") {
    if (existing) {
      throw new OkfError(
        `Section "${op.section}" already exists; use op "replace" or "append"`,
        "section_exists",
      );
    }
    const heading = "#".repeat(clampLevel(op.level ?? 1));
    const prefix = body.trim() === "" ? "" : `${body.trim()}\n\n`;
    return normalize(`${prefix}${heading} ${op.section.trim()}\n\n${op.content.trim()}`);
  }

  if (!existing) {
    const available = parseSections(body).map((s) => s.title);
    throw new OkfError(
      `No section "${op.section}" in this concept${
        available.length ? ` (has: ${available.join(", ")})` : " (body has no headings)"
      }`,
      "section_not_found",
    );
  }

  const lines = body.split("\n");
  const before = lines.slice(0, existing.headingLine);
  const after = lines.slice(existing.end);
  const headingLine = lines[existing.headingLine] ?? "";

  if (op.op === "delete") return normalize([...before, ...after].join("\n"));

  const current = sectionContent(body, existing);
  const content =
    op.op === "replace" ? op.content.trim() : `${current}\n\n${op.content.trim()}`.trim();
  const rebuilt = content === "" ? [headingLine] : [headingLine, "", content];
  return normalize([...before, ...rebuilt, "", ...after].join("\n"));
}

function clampLevel(level: number): number {
  return Math.min(6, Math.max(1, Math.trunc(level)));
}

/** Collapse runs of blank lines and trim, so repeated edits don't accrete whitespace. */
function normalize(body: string): string {
  return body.replace(/\n{3,}/g, "\n\n").trim();
}
