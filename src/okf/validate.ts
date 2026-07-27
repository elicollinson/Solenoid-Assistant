// Conformance checking (§11).
//
// §11 is permissive on purpose, and the severity split here mirrors it exactly:
// only the three structural rules are errors. Missing optional families,
// unknown types, unknown keys and broken links are reported as `info` because
// the spec says a consumer MUST NOT reject a bundle over them — a validator
// that treats "not yet written" as a defect would train an agent to stop
// linking forward.
import { join } from "node:path";
import { INDEX_FILENAME, LOG_FILENAME, type Bundle } from "./bundle";
import { parseDocument } from "./concept";
import { conceptLinks } from "./links";
import { listMarkdownFiles, scanConcepts } from "./scan";

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
  severity: "error" | "info";
}

export interface ValidationReport {
  conformant: boolean;
  conceptCount: number;
  errors: ValidationIssue[];
  info: ValidationIssue[];
}

const DATE_HEADING_RE = /^##\s+(.*?)\s*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function validateBundle(bundle: Bundle): Promise<ValidationReport> {
  const errors: ValidationIssue[] = [];
  const info: ValidationIssue[] = [];

  const { concepts, problems } = await scanConcepts(bundle);

  // §11.1 — every non-reserved .md parses as frontmatter + body.
  for (const problem of problems) {
    errors.push({
      path: `${problem.id}.md`,
      code: "unparseable",
      message: problem.message,
      severity: "error",
    });
  }

  const ids = new Set(concepts.map((c) => c.id));
  for (const concept of concepts) {
    // §11.2 — non-empty `type`.
    const type = concept.frontmatter.type;
    if (typeof type !== "string" || type.trim() === "") {
      errors.push({
        path: `${concept.id}.md`,
        code: "missing_type",
        message: "frontmatter has no non-empty `type`",
        severity: "error",
      });
    }
    for (const link of conceptLinks(concept.id, concept.body)) {
      if (link.kind === "concept" && link.id && !ids.has(link.id)) {
        info.push({
          path: `${concept.id}.md`,
          code: "broken_link",
          message: `links to "${link.id}", which does not exist (may be not-yet-written knowledge)`,
          severity: "info",
        });
      }
    }
  }

  // §11.3 — reserved files follow §8 and §9 where present.
  for (const rel of await listMarkdownFiles(bundle)) {
    if (rel.endsWith(INDEX_FILENAME)) {
      errors.push(...(await checkIndex(bundle, rel)));
    } else if (rel.endsWith(LOG_FILENAME)) {
      errors.push(...(await checkLog(bundle, rel)));
    }
  }

  return { conformant: errors.length === 0, conceptCount: concepts.length, errors, info };
}

async function checkIndex(bundle: Bundle, rel: string): Promise<ValidationIssue[]> {
  const { frontmatter } = parseDocument(await Bun.file(join(bundle.root, rel)).text());
  if (!frontmatter) return [];
  const isRoot = rel === INDEX_FILENAME;
  const keys = Object.keys(frontmatter);
  if (isRoot && keys.every((k) => k === "okf_version")) return [];
  return [
    {
      path: rel,
      code: "index_frontmatter",
      message: isRoot
        ? `a bundle-root index.md may only carry \`okf_version\` (§12); found: ${keys.join(", ")}`
        : "index.md must not contain frontmatter (§8)",
      severity: "error",
    },
  ];
}

async function checkLog(bundle: Bundle, rel: string): Promise<ValidationIssue[]> {
  const text = await Bun.file(join(bundle.root, rel)).text();
  const issues: ValidationIssue[] = [];
  for (const line of text.split("\n")) {
    const match = DATE_HEADING_RE.exec(line);
    const heading = match?.[1];
    if (heading !== undefined && !ISO_DATE_RE.test(heading)) {
      issues.push({
        path: rel,
        code: "log_date",
        message: `date heading "${heading}" is not ISO 8601 YYYY-MM-DD (§9)`,
        severity: "error",
      });
    }
  }
  return issues;
}
