// The wire shape of GET /api/reminders and GET /api/reminders/:id.
//
// Pure types and nothing else, for the same reason src/shared/home.ts is: the
// browser half compiles against this file and has no Bun types.
import type { HomeAction, HomeState } from "./home";

/**
 * Overdue, then today, then the week, then the undated, then what is closed.
 *
 * Every one of these is derived from `dueAt` against the clock — a stored
 * "Today" is wrong by morning. "Later" is the sibling "This week" needs the
 * first time something is set more than a week out; nothing in the design is.
 */
export type ReminderGroup = "Overdue" | "Today" | "This week" | "Later" | "Someday" | "Closed";

export interface ReminderRow {
  id: string;
  title: string;
  /** The agent's one line about why this is here. */
  note: string;
  state: HomeState;
  group: ReminderGroup;
  /** "Yesterday 17:00", "Today 16:30", "Thu 09:00", "No date". */
  when: string;
  /** "from okf:vendor/ferris-terms" */
  source: string;
  /** Whether a decision is genuinely open on it, as opposed to the agent
   *  merely waiting. A gate has buttons; a nag has affordances. */
  gated: boolean;
}

export interface RemindersPayload {
  /** The agent's own line, plus what is true of the list right now. */
  lede: string;
  rows: ReminderRow[];
}

export interface ReminderMeta {
  label: string;
  value: string;
}

/** One line of "What I've done about it". */
export interface ReminderHistoryLine {
  /** "Aug 14, 09:20", "Today 06:14" */
  t: string;
  text: string;
}

export interface ReminderGate {
  id: string;
  title: string;
  body: string | null;
  actions: HomeAction[];
}

export type ReminderEvidenceKind = "thread" | "email" | "chat" | "screenshot" | "article";

export interface ReminderEvidenceTurn {
  /** "you" renders your side of the conversation a step darker. */
  from: string;
  name: string;
  /** "09:16" */
  t: string;
  text: string;
  pinned: boolean;
}

export interface ReminderEvidenceEmail {
  from: string;
  to: string;
  date: string;
  subject: string;
  body: string[];
  quoted?: string[];
  attachments?: string[];
  /** Index into `body` of the paragraph the agent acted on. */
  pinned?: number;
}

export interface ReminderEvidenceShot {
  file: string;
  /** "1440 × 900" */
  dims: string;
  regions: { label: string; note: string }[];
  text?: string;
}

export interface ReminderEvidenceArticle {
  url: string;
  retrieved: string;
  words: number;
  headline: string;
  byline?: string;
  body: string[];
  pinned?: number;
}

/** One artifact the agent read, and why it kept it. */
export interface ReminderEvidence {
  id: string;
  kind: ReminderEvidenceKind;
  title: string;
  /** "Fenwick Heating · +44 7700 900412", "captured by me while filing". */
  who: string;
  when: string;
  /** "3 messages · 1 pinned" — the mono line under the title. */
  support?: string;
  /** "thread/9a44", "run 14", "web". */
  ref?: string;
  /** Why this one was kept. Written on the link, not the source. */
  why?: string;
  messages?: ReminderEvidenceTurn[];
  email?: ReminderEvidenceEmail;
  shot?: ReminderEvidenceShot;
  article?: ReminderEvidenceArticle;
}

export interface ReminderDetailPayload extends ReminderRow {
  /** "Why I set this", in the agent's voice. */
  prose: string[];
  meta: ReminderMeta[];
  history: ReminderHistoryLine[];
  /** The standing rule this is an instance of. */
  instruction: string | null;
  /** The open decision, when there is one. */
  gate: ReminderGate | null;
  /** Buttons that commit to nothing — offered, not asked. */
  actions: HomeAction[];
  evidence: ReminderEvidence[];
}
