// Concept documents: frontmatter + body, parsed and re-serialized without loss.
//
// Round-tripping preserves unknown frontmatter keys (§4.1) because the whole
// document is patched, never regenerated from a model's idea of what the file
// contained. Key order is canonicalized on write so diffs stay small.
import { OkfError } from "./bundle";
import { dumpYaml } from "./yaml";

export interface ParsedDocument {
  /** `null` when the file has no frontmatter block at all. */
  frontmatter: Record<string, unknown> | null;
  body: string;
}

export interface Concept {
  id: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

// Opening `---`, lazily-matched YAML, closing `---`. A BOM and CRLF line
// endings are tolerated; a `---` horizontal rule later in the body is not
// reachable because the match is anchored at the start of the file.
const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Canonical write order. Anything else keeps its existing relative order, after these. */
const FIELD_ORDER = [
  "okf_version",
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "status",
  // Attested Computation (§10)
  "runtime",
  "parameters",
  "computation",
  "executor",
  "attester",
  // Trust / lifecycle / provenance (§5)
  "generated",
  "verified",
  "stale_after",
  "sources",
  "usage_window",
];

export function parseDocument(text: string): ParsedDocument {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = FRONTMATTER_RE.exec(normalized);
  if (!match) return { frontmatter: null, body: normalized.replace(/^\n+/, "") };

  const raw = match[1] ?? "";
  let parsed: unknown;
  try {
    parsed = raw.trim() === "" ? {} : Bun.YAML.parse(raw);
  } catch (err) {
    throw new OkfError(
      `Frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      "bad_yaml",
    );
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OkfError("Frontmatter must be a YAML mapping", "bad_yaml");
  }
  return {
    frontmatter: parsed as Record<string, unknown>,
    body: normalized.slice(match[0].length).replace(/^\n+/, ""),
  };
}

/** Parse a concept, rejecting a document with no frontmatter block (§11.1). */
export function parseConcept(id: string, text: string): Concept {
  const { frontmatter, body } = parseDocument(text);
  if (!frontmatter) {
    throw new OkfError(`Concept "${id}" has no YAML frontmatter block`, "no_frontmatter");
  }
  return { id, frontmatter, body };
}

export function orderFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of FIELD_ORDER) {
    if (key in frontmatter && frontmatter[key] !== undefined) ordered[key] = frontmatter[key];
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key in ordered || value === undefined) continue;
    ordered[key] = value;
  }
  return ordered;
}

export function serializeConcept(concept: Pick<Concept, "frontmatter" | "body">): string {
  const yaml = dumpYaml(orderFrontmatter(concept.frontmatter));
  const body = concept.body.trim();
  return body === "" ? `---\n${yaml}---\n` : `---\n${yaml}---\n\n${body}\n`;
}

/**
 * Shallow merge of a frontmatter patch. Top-level keys are replaced wholesale
 * (a new `sources` list supersedes the old one rather than appending), and an
 * explicit `null` deletes the key — otherwise there is no way for a caller to
 * remove a field it can no longer justify.
 */
export function mergeFrontmatter(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}
