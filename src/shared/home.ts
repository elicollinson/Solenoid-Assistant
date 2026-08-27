// The wire shape of GET /api/home.
//
// Pure types and nothing else: both halves of the repo compile against this
// file, and the browser half has no Bun types, so anything imported here would
// have to typecheck under DOM as well. src/db/queries/home.ts builds the
// payload; web/src/app/api.ts consumes it.

/** The four Bauhaus states plus the quiet fifth. Mirrors STATE in the schema. */
export type HomeState = "attention" | "running" | "done" | "failed" | "idle";
export type HomeStance = "affirm" | "neutral" | "quiet" | "danger" | "bare";
export type HomeSignal = "amber" | "green" | "rust" | "info";

export interface HomeAction {
  id: string;
  /** The agent's own words. Never "Submit", "Confirm", "OK". */
  label: string;
  stance: HomeStance;
  effectKind: string;
  effect: unknown;
}

export interface HomeToolCall {
  name: string;
  arg: string | null;
  duration: string | null;
}

export interface HomeFeedItem {
  id: string;
  state: HomeState;
  title: string;
  badge: string | null;
  time: string;
  framed: boolean;
  prominent: boolean;
  account: string | null;
  toolSummary: string | null;
  toolCalls: HomeToolCall[];
  progress: { value: number; total: number } | null;
  decisionId: string | null;
  actions: HomeAction[];
}

export interface HomeSection {
  label: string;
  items: HomeFeedItem[];
}

export interface HomeRailItem {
  label: string;
  count: number | null;
  dot: HomeSignal | null;
}

export interface HomePayload {
  header: { greeting: string; lede: string };
  rail: {
    groups: { label: string; items: HomeRailItem[] }[];
    agent: { line: string; running: number };
  };
  sections: HomeSection[];
  aside: {
    waiting: { id: string; title: string }[];
    nextUp: { time: string; what: string }[];
    worthALook: { id: string; body: string; actions: HomeAction[] } | null;
  };
}
