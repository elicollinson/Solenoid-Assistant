// Pulling discrete facts out of a markdown memory.
//
// The design's OKF objects are records: every one arrives as a list of
// label/value fields, and its detail page is mostly that table. Real memories
// are not shaped that way. 82 of the 314 in this bundle state facts as bolded
// list items — `- **Primary phone:** +1908…` — and the other 232 are prose.
//
// So this extracts what is genuinely field-shaped and claims nothing about the
// rest. A memory with no bolded assertions gets an empty field list, and the
// detail page renders its prose instead of an empty table. Inventing fields by
// asking a model to split the prose would put sentences in a column headed
// "Value" and give them a precision they do not have.
//
// Offsets are recorded because `okf_fields` carries `bodyStart`/`bodyEnd` so a
// future write can patch a value in place rather than rewriting the file.

export interface ExtractedField {
  label: string;
  value: string;
  /** The `## Heading` it sat under, or "" at the top of the body. */
  section: string;
  /** Character offsets of the whole line within the body. */
  start: number;
  end: number;
}

/**
 * The four ways this bundle writes an assertion. All four are anchored to the
 * start of a line: a bolded run mid-sentence is emphasis, not a field.
 */
const PATTERNS: readonly RegExp[] = [
  /^-\s+\*\*([^*]+?):\*\*\s*(.+)$/,           // - **Label:** value
  /^-\s+\*\*([^*]+?)\*\*:\s*(.+)$/,           // - **Label**: value
  /^-\s+\*\*([^*]+?)\*\*\s+[—–]\s*(.+)$/,     // - **Label** — value
  /^\*\*([^*]+?):\*\*\s*(.+)$/,               // **Label:** value
];

const HEADING = /^#{1,6}\s+(.+?)\s*$/;
/** Links to other memories are relationships, handled by the link extractor. */
const RELATED = /^(related|see also|links?)$/i;

/** Markdown to something that can sit in a table cell. */
export function plain(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractFields(body: string): ExtractedField[] {
  const out: ExtractedField[] = [];
  let section = "";
  let skipping = false;
  let offset = 0;

  for (const raw of body.split("\n")) {
    const start = offset;
    offset += raw.length + 1;
    const line = raw.trim();

    const heading = HEADING.exec(line);
    if (heading) {
      section = heading[1] ?? "";
      skipping = RELATED.test(section);
      continue;
    }
    if (skipping || line === "") continue;

    for (const pattern of PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      const label = plain(match[1] ?? "");
      const value = plain(match[2] ?? "");
      // A label with no value, or a whole sentence as a label, is a bolded
      // phrase rather than a field.
      if (!label || !value || label.length > 48) break;
      out.push({ label, value, section, start, end: start + raw.length });
      break;
    }
  }

  return out;
}

/**
 * Two fields sharing a label but not a value.
 *
 * The design's one conflict is the whole reason `conflictGroupId` exists: the
 * agent held two billing addresses and refused to pick. Here the same shape
 * falls out of the file — a memory that says "Status" twice with different
 * answers is holding two answers, whether or not anyone noticed.
 *
 * Returns the group key per field index, or null where the field is alone.
 */
export function conflictGroups(fields: readonly ExtractedField[]): (string | null)[] {
  const byLabel = new Map<string, number[]>();
  fields.forEach((field, index) => {
    const key = field.label.toLowerCase();
    const list = byLabel.get(key);
    if (list) list.push(index);
    else byLabel.set(key, [index]);
  });

  const groups: (string | null)[] = fields.map(() => null);
  for (const [key, indexes] of byLabel) {
    if (indexes.length < 2) continue;
    const values = new Set(indexes.map((i) => fields[i]?.value));
    if (values.size < 2) continue; // said twice, agreeing — a repeat, not a conflict
    for (const i of indexes) groups[i] = key;
  }
  return groups;
}

/**
 * The body split into its headed sections, for the pages that have no fields.
 * The `## Related` block is dropped: it is the link graph, drawn separately.
 */
export interface BodySection {
  heading: string;
  paragraphs: string[];
}

export function readableSections(body: string): BodySection[] {
  const sections: BodySection[] = [];
  let current: BodySection = { heading: "", paragraphs: [] };
  let buffer: string[] = [];

  const flush = () => {
    const text = plain(buffer.join(" "));
    buffer = [];
    if (text) current.paragraphs.push(text);
  };
  const close = () => {
    flush();
    if (current.paragraphs.length && !RELATED.test(current.heading)) sections.push(current);
  };

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      current = { heading: heading[1] ?? "", paragraphs: [] };
      continue;
    }
    if (line === "") { flush(); continue; }
    // A bullet is its own paragraph; running them together loses the list.
    if (/^[-*]\s+/.test(line)) {
      flush();
      const text = plain(line.replace(/^[-*]\s+/, ""));
      if (text) current.paragraphs.push(text);
      continue;
    }
    buffer.push(line);
  }
  close();
  return sections;
}
