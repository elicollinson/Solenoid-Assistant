// The wire shape of GET /api/knowledge and GET /api/knowledge/:id.
//
// Pure types and nothing else, for the same reason src/shared/home.ts is: the
// browser half compiles against this file and has no Bun types.
import type { HomeState } from "./home";

export interface KnowledgeRow {
  id: string;
  /** "okf:memories/the-orchard-gathering" — the mono cell, and what a citation
   *  from anywhere else in the product would name. */
  uri: string;
  name: string;
  /** person | health | work | travel | home | plan | interest | note */
  kind: string;
  group: string;
  state: HomeState;
  /** How many discrete facts I could pull out. Often zero: most memories state
   *  what they know in prose, and this counts only what is field-shaped. */
  facts: number;
  /** "Aug 21", "Today" — when the memory was last written. */
  when: string;
  blurb: string;
  /** Past its `stale_after`. Derived against the clock, never stored. */
  stale: boolean;
}

export interface KnowledgeFilter {
  label: string;
  /** The group this chip selects, or null for "All". */
  group: string | null;
  count: number;
}

export interface KnowledgePayload {
  /** The agent's line, plus what is true of the store right now. */
  lede: string;
  /** What I have not done to the store and why, under the list. Null when
   *  nothing is written for this surface. */
  restraint: string | null;
  /** Section order. Only groups that have rows appear. */
  groups: string[];
  filters: KnowledgeFilter[];
  rows: KnowledgeRow[];
}

export interface KnowledgeField {
  id: string;
  label: string;
  value: string;
  /** "Jul 27" — when the file asserting it was written. */
  when: string;
  /** "you", "the letting agent", "user conversation". */
  source: string;
  /** Whose claim this is, in the agent's words. */
  provenance: string;
  /** Another field on this object shares the label and disagrees. */
  conflict: boolean;
  /** The `## Heading` it sat under. */
  section: string | null;
}

/** A headed run of prose from the memory itself. */
export interface KnowledgeSection {
  heading: string;
  paragraphs: string[];
}

/** One line of the bundle's log, as it names this memory. */
export interface KnowledgeTrailLine {
  /** "Jul 27, 2026" — log.md keeps a date and no clock. */
  t: string;
  kind: string;
  text: string;
}

/** Another memory that names this one. */
export interface KnowledgeRef {
  id: string;
  label: string;
  when: string;
}

/** A `sources:` entry. A descriptor of where the memory came from, not an
 *  artifact I still hold — so it is listed rather than opened. */
export interface KnowledgeSource {
  title: string;
  who: string;
}

export interface KnowledgeMeta {
  label: string;
  value: string;
}

export interface KnowledgeDetailPayload extends KnowledgeRow {
  /** "How I came to know this", derived from the file's own provenance. */
  account: string[];
  /** Set when two fields share a label and disagree. */
  conflict: string | null;
  fields: KnowledgeField[];
  /** The memory as written, for the many that hold no discrete fields. */
  sections: KnowledgeSection[];
  meta: KnowledgeMeta[];
  trail: KnowledgeTrailLine[];
  /** What links here. */
  refs: KnowledgeRef[];
  sources: KnowledgeSource[];
  tags: string[];
  /** "okf/memories/the-orchard-gathering.md" */
  path: string;
  rev: number;
}
