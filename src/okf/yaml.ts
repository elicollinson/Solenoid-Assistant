// Frontmatter emitter for OKF.
//
// Parsing stays on `Bun.YAML.parse` (battle-tested). Only the dump side is
// ours: `Bun.YAML.stringify` collapses an object onto a single flow-style line
// (`{type: X,title: Y,...}`), which round-trips fine but destroys the
// line-per-fact diffability OKF exists for (spec §1). The value space that
// actually appears in frontmatter is JSON-shaped — scalars, lists, maps — so a
// small deterministic emitter covers it, and the round-trip tests
// (dump -> Bun.YAML.parse -> deep equal) are the guarantee that quoting is right.
//
// Rendering rules are chosen to match the spec's own examples: scalar lists and
// small all-scalar maps go inline (`tags: [a, b]`, `generated: { by, at }`),
// anything larger or nested goes block (`sources:` entries, `executor:`).

/** Max rendered width before a flow collection is broken out into block style. */
const FLOW_MAX_WIDTH = 72;
/** Max entries in a map before it is broken out into block style. */
const FLOW_MAX_ENTRIES = 4;

const RESERVED_WORD = /^(true|false|yes|no|on|off|null|~)$/i;
const NUMBER_LIKE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const SPECIAL_INF = /^[-+]?\.(inf|nan)$/i;
const LEADING_INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a plain string would be misread by a YAML parser if left bare.
 * Deliberately conservative: over-quoting is cosmetic, under-quoting corrupts.
 */
export function needsQuotes(s: string, flow: boolean): boolean {
  if (s === "") return true;
  if (s !== s.trim()) return true; // leading/trailing whitespace is not preserved bare
  if (RESERVED_WORD.test(s)) return true; // "no" must not become false
  if (NUMBER_LIKE.test(s)) return true; // "007" must not become 7
  if (SPECIAL_INF.test(s)) return true;
  if (LEADING_INDICATOR.test(s)) return true;
  if (/: /.test(s) || /\s#/.test(s)) return true; // would start a mapping / comment
  if (/[\n\r\t]/.test(s)) return true;
  if (s.endsWith(":")) return true;
  if (flow && /[,[\]{}]/.test(s)) return true; // would terminate the flow collection
  return false;
}

function formatScalar(value: string | number | boolean | null, flow: boolean): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return ".nan";
    if (value === Infinity) return ".inf";
    if (value === -Infinity) return "-.inf";
    return String(value);
  }
  // JSON's escapes (\n, \t, \", \\) are all valid inside a YAML double-quoted
  // scalar, so JSON.stringify is a correct quoter here.
  return needsQuotes(value, flow) ? JSON.stringify(value) : value;
}

function formatKey(key: string): string {
  return needsQuotes(key, false) ? JSON.stringify(key) : key;
}

function definedEntries(obj: Record<string, unknown>): [string, unknown][] {
  return Object.entries(obj).filter(([, v]) => v !== undefined);
}

/** Render a collection inline, or return null when it must go block style. */
function tryFlow(value: unknown): string | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (!value.every(isScalar)) return null;
    const rendered = `[${value.map((v) => formatScalar(v, true)).join(", ")}]`;
    return rendered.length <= FLOW_MAX_WIDTH ? rendered : null;
  }
  if (isPlainObject(value)) {
    const entries = definedEntries(value);
    if (entries.length === 0) return "{}";
    if (entries.length > FLOW_MAX_ENTRIES) return null;
    if (!entries.every(([, v]) => isScalar(v))) return null;
    const body = entries
      .map(([k, v]) => `${formatKey(k)}: ${formatScalar(v as never, true)}`)
      .join(", ");
    const rendered = `{ ${body} }`;
    return rendered.length <= FLOW_MAX_WIDTH ? rendered : null;
  }
  return null;
}

function dumpList(items: unknown[], indent: number): string {
  const pad = " ".repeat(indent + 2);
  let out = "";
  for (const item of items) {
    if (item === undefined) continue;
    if (isScalar(item)) {
      out += `${pad}- ${formatScalar(item, false)}\n`;
      continue;
    }
    const flow = tryFlow(item);
    if (flow !== null) {
      out += `${pad}- ${flow}\n`;
      continue;
    }
    // Render the nested block two levels deeper, then splice "- " over the
    // first line's indentation so continuation lines align under it.
    const nested = Array.isArray(item)
      ? dumpList(item, indent + 2)
      : dumpMap(item as Record<string, unknown>, indent + 4);
    out += `${pad}- ${nested.slice(indent + 4)}`;
  }
  return out;
}

function dumpMap(obj: Record<string, unknown>, indent: number): string {
  const pad = " ".repeat(indent);
  let out = "";
  for (const [key, value] of definedEntries(obj)) {
    const label = `${pad}${formatKey(key)}:`;
    if (isScalar(value)) {
      out += `${label} ${formatScalar(value, false)}\n`;
      continue;
    }
    const flow = tryFlow(value);
    if (flow !== null) {
      out += `${label} ${flow}\n`;
      continue;
    }
    out += Array.isArray(value)
      ? `${label}\n${dumpList(value, indent)}`
      : `${label}\n${dumpMap(value as Record<string, unknown>, indent + 2)}`;
  }
  return out;
}

/** Render a frontmatter object as block-style YAML (trailing newline included). */
export function dumpYaml(obj: Record<string, unknown>): string {
  return dumpMap(obj, 0);
}
