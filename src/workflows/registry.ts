// What happens when you press Run.
//
// The catalog says a workflow exists; this says what executing it means. Same
// bargain as src/tasks/registry.ts: one Zod schema per workflow validates the
// arguments whichever way they arrive — a form in the browser, a JSON body from
// curl — and one `execute` is the seam both go through, so a run started from
// the UI exercises exactly the code path the HTTP endpoints already do.
//
// Each execute returns three things rather than one, because a run is read back
// on three different parts of the screen: the raw `output` (the Output pane),
// the `effects` (the "What changed" list), and the `prose` (the write-up). The
// workflow itself is the only thing that knows how to say what it did, so it
// says it here rather than leaving the runner to guess from a blob of JSON.
import { z } from "zod";
import { runTask } from "../tasks";
import { extractMessages } from "./messageExtraction";
import { classifySafety } from "./safetyClassification";
import {
  classifyRecentScreenshots,
  ingestRecentScreenshots,
} from "./screenshotIngestion";
import { WORKFLOW_CATALOG } from "./catalog";

export interface WorkflowOutcome {
  /** What the workflow returned, kept verbatim. */
  output: unknown;
  /** The `changed` list — one line per thing that actually happened. */
  effects: string[];
  /** The write-up, one entry per paragraph. */
  prose: string[];
}

/** What the runner tells a workflow about the run it is inside. */
export interface WorkflowContext {
  /** Raised when the run is stopped from the surface. A workflow that reaches
   *  something abortable should pass this to it; one that does not simply runs
   *  to the end and has its result dropped. */
  signal: AbortSignal;
}

export interface RunnableWorkflow<S extends z.ZodType = z.ZodType> {
  slug: string;
  schema: S;
  execute: (args: z.infer<S>, context: WorkflowContext) => Promise<WorkflowOutcome>;
}

function define<S extends z.ZodType>(workflow: RunnableWorkflow<S>): RunnableWorkflow<S> {
  return workflow as RunnableWorkflow<z.ZodType> as RunnableWorkflow<S>;
}

/** Thrown when arguments fail their schema — maps to HTTP 400. */
export class WorkflowArgsError extends Error {
  constructor(slug: string, issue: string) {
    super(`Invalid arguments for workflow "${slug}": ${issue}`);
    this.name = "WorkflowArgsError";
  }
}

/**
 * A form sends strings for everything and empty strings for what you left
 * blank. Both are the browser's problem to describe and this file's problem to
 * absorb: `""` means "not given", which is what an optional field's absence
 * means, and a number arrives as `"24"`.
 */
const blankIsAbsent = <T extends z.ZodType>(inner: T) =>
  z.preprocess((value) => (value === "" || value === null ? undefined : value), inner.optional());

const count = (fallback: number, max: number) =>
  z.preprocess(
    (value) => (value === "" || value === null || value === undefined ? fallback : value),
    z.coerce.number().int().min(1).max(max),
  );

/** "3 invoices" / "1 invoice", because a run's own account of itself should read. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "26 Aug 19:15", in the zone the person reading it is standing in. */
function when(at: Date): string {
  return at.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const WORKFLOWS: readonly RunnableWorkflow[] = [
  define({
    slug: "message-extraction",
    schema: z.object({
      start: blankIsAbsent(z.coerce.date()),
      end: blankIsAbsent(z.coerce.date()),
    }),
    execute: async ({ start, end }) => {
      // Resolved here rather than left to default inside the reader, so the
      // window is on the trace, in the write-up and in the result. A pass that
      // reads nothing is otherwise indistinguishable from a quiet day — which
      // is exactly how a missing Full Disk Access grant reads on this screen.
      const windowEnd = end ?? new Date();
      const windowStart = start ?? new Date(windowEnd.getTime() - 24 * 3600_000);

      const result = await extractMessages({ start: windowStart, end: windowEnd });
      const { processedConversations, quarantinedConversations, failedConversations } = result.screening;
      const kept = result.okfUpdate === "none" ? 0 : 1;
      const window = { start: windowStart.toISOString(), end: windowEnd.toISOString() };
      const said = `${when(windowStart)} to ${when(windowEnd)}`;

      return {
        output: { ...result, window },
        effects: processedConversations
          ? [
              `Read ${plural(processedConversations, "conversation")} from ${said} and pulled out ${plural(result.actionItems.length, "action item")}.`,
              `Wrote ${plural(result.conversationSummaries.length, "summary", "summaries")}.`,
              kept ? "Offered what was worth keeping to memory." : "Nothing here was worth keeping in memory.",
              ...(quarantinedConversations
                ? [`Quarantined ${plural(quarantinedConversations, "conversation")} for injected instructions.`]
                : []),
              ...(failedConversations ? [`${plural(failedConversations, "conversation")} failed to extract.`] : []),
            ]
          : [`Found no conversations at all between ${said}. Nothing was read and nothing was written.`],
        prose: processedConversations
          ? [
              `I read ${plural(processedConversations, "conversation")} from ${said}, screened each one on its own, and extracted from the ones that came back clean.`,
              result.actionItems.length
                ? `There are ${plural(result.actionItems.length, "action item")} in there: ${result.actionItems.slice(0, 3).join("; ")}${result.actionItems.length > 3 ? "; and more below." : "."}`
                : "Nothing in the window asked anything of you.",
              ...(quarantinedConversations
                ? [
                    `${plural(quarantinedConversations, "conversation")} tried to give me instructions. I stopped reading those and did not act on anything in them.`,
                  ]
                : []),
            ]
          : [
              `There was nothing to read between ${said} — not one message from a known contact fell in that window, so no model saw anything and nothing changed.`,
              "Leaving both fields blank reads the last 24 hours. If you were expecting something here, widen the window rather than running it again on the same one.",
            ],
      };
    },
  }),

  define({
    slug: "screenshot-classification",
    schema: z.object({
      hoursBack: count(24, 24 * 30),
      limit: count(10, 500),
    }),
    execute: async ({ hoursBack, limit }) => {
      const result = await classifyRecentScreenshots({ hoursBack, limit });
      const named = result.screenshots.filter(
        (shot) => shot.classification && shot.classification.classification !== "Rejected",
      );
      return {
        output: result,
        effects: [
          `Looked at ${plural(result.returned, "screenshot")} out of ${result.totalInWindow} in the window.`,
          `Recognised ${plural(named.length, "thing")}; the rest were rejected as nothing in particular.`,
          ...(result.quarantined ? [`Quarantined ${plural(result.quarantined, "screenshot")}.`] : []),
          ...(result.failed ? [`${plural(result.failed, "screenshot")} failed to classify.`] : []),
        ],
        prose: [
          `I described ${plural(result.returned, "screenshot")} taken since ${result.windowStart} and classified each description.`,
          named.length
            ? `The ones I recognised: ${named
                .map((shot) => `${shot.classification?.name} (${shot.classification?.classification})`)
                .join(", ")}.`
            : "None of them were a book, a film, a show, a game or an album, so there is nothing to carry forward.",
          "Nothing was written anywhere — this pass only looks.",
        ],
      };
    },
  }),

  define({
    slug: "screenshot-ingestion",
    schema: z.object({
      hoursBack: count(24, 24 * 30),
      limit: count(5, 500),
    }),
    execute: async ({ hoursBack, limit }) => {
      const result = await ingestRecentScreenshots({ hoursBack, limit });
      const ingested = result.screenshots.filter((shot) => shot.status === "ingested");
      const created = ingested.filter((shot) => shot.ingestion?.status === "created");
      const updated = ingested.filter((shot) => shot.ingestion?.status === "updated");
      return {
        output: result,
        effects: [
          `Looked at ${plural(result.returned, "screenshot")} out of ${result.totalInWindow} in the window.`,
          `Created ${plural(created.length, "Notion entry", "Notion entries")} and updated ${updated.length}.`,
          ...(result.quarantined ? [`Quarantined ${plural(result.quarantined, "screenshot")}.`] : []),
          ...(result.failed ? [`${plural(result.failed, "screenshot")} failed on the way through.`] : []),
        ],
        prose: [
          `I classified ${plural(result.returned, "screenshot")} from since ${result.windowStart}, sourced a content card for everything I recognised, and wrote each one into the gallery.`,
          ingested.length
            ? `Into Notion: ${ingested.map((shot) => shot.contentCard?.name ?? shot.classification?.name).join(", ")}.`
            : "Nothing reached Notion — either nothing was recognisable, or everything I recognised was already there.",
        ],
      };
    },
  }),

  define({
    slug: "safety-classification",
    schema: z.object({
      input: z.string().min(1, "give me something to screen"),
      maxLength: count(40, 500),
    }),
    execute: async ({ input, maxLength }) => {
      const result = await classifySafety(input, maxLength);
      const score = result.score.toFixed(2);
      return {
        output: result,
        effects: [
          result.flagged
            ? `Flagged, at ${score} on the most concerning chunk.`
            : `Clean, with nothing above ${score}.`,
        ],
        prose: [
          `I split ${plural(input.split(/\s+/).filter(Boolean).length, "word")} into chunks of at most ${maxLength} and scored each one on its own.`,
          `${result.flagged ? "The worst chunk scored" : "The worst chunk only scored"} ${score}. ${result.concern}`,
        ],
      };
    },
  }),

  define({
    slug: "weather-briefing",
    schema: z.object({ city: z.string().min(1, "name a city") }),
    execute: async ({ city }) => {
      // Through the task registry rather than around it, so a run from here and
      // the 07:00 cron firing are demonstrably the same execution path.
      const result = await runTask("weather", { city });
      const answer = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
      return {
        output: result.output,
        effects: [`Looked up the weather in ${city}.`],
        prose: [answer],
      };
    },
  }),
];

const BY_SLUG = new Map(WORKFLOWS.map((workflow) => [workflow.slug, workflow]));

/** The code behind a slug, or undefined where there is none. */
export function runnableWorkflow(slug: string): RunnableWorkflow | undefined {
  return BY_SLUG.get(slug);
}

/**
 * Arguments as the workflow wants them, or a WorkflowArgsError saying which
 * field is wrong and why.
 */
export function parseWorkflowArgs(
  slug: string,
  raw: unknown,
  workflow: RunnableWorkflow | undefined = runnableWorkflow(slug),
): unknown {
  if (!workflow) throw new Error(`No code behind workflow "${slug}"`);
  const parsed = workflow.schema.safeParse(raw ?? {});
  if (!parsed.success) throw new WorkflowArgsError(slug, z.prettifyError(parsed.error));
  return parsed.data;
}

// The two halves have to name the same set, or the table offers a Run button
// for something that cannot run — or hides one for something that can.
const missing = WORKFLOW_CATALOG.filter((entry) => !BY_SLUG.has(entry.slug)).map((entry) => entry.slug);
if (missing.length > 0) {
  throw new Error(`Catalogued workflows with no implementation: ${missing.join(", ")}`);
}
