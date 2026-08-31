// Agent-facing tools for the Recommendations surface, and the group that hands
// them over.
//
// What a recommendation IS, and the list of what these tools deliberately
// cannot do, are in `purpose` at the foot of this file rather than up here. That
// prose is worth more to the model than to us, and the briefing is the only
// place the model ever reads it; a second copy in a comment would be a second
// copy to drift.
//
// A factory rather than module-level singletons, for the same reason ./okf.ts
// is one: the database handle is bound at construction. Nothing the model says
// can redirect these at another database.
//
// The read tools are safe to hand to any agent. The write tools should NOT sit
// in the same loop as untrusted input — an agent reading email while holding
// `recommendations_propose` is a path for a stranger to author the buttons you
// are shown. That filtering does not happen here: the factory and the group
// both return EVERY tool, and `readOnly` in ../core/toolGroups.ts drops the
// writes once, for every group, so no group can get its own filter wrong.
import { z } from "zod";
import { defineTool, type AgentTool } from "../core/tools";
import {
  defineToolGroup,
  type DerivedField,
  type FieldDoc,
  type ToolGroup,
} from "../core/toolGroups";
import type { Db } from "../db";
import * as s from "../db/schema";
import { describeTable } from "../db/schemaDoc";
import type { ToolGroupContext } from "./groups";
import { loadRecommendation, loadRecommendations } from "../db/queries/recommendations";
import { instant, limit, pairs, toPairs } from "./_shared";
import {
  answerRecommendation,
  citeForRecommendation,
  forgetRecommendation,
  proposeRecommendation,
  reviseRecommendation,
  supersedeRecommendation,
  withdrawRecommendation,
} from "../db/mutations/recommendations";

const idSchema = z
  .string()
  .min(1)
  .describe("The suggestion's id, as returned by recommendations_list or recommendations_propose.");

const confidenceSchema = z
  .enum(["strong", "worth_a_look", "weak"])
  .describe(
    "How sure you are, while it is still being asked. 'strong' means the pattern is unambiguous and you " +
      "would act on it if you were allowed to; 'worth_a_look' is the default and means you think it is " +
      "probably right; 'weak' means you are raising it for completeness. Once it is answered this stops " +
      "being shown — the honest word then is the answer, not what you thought of it beforehand.",
  );

const effectSchema = pairs("Questions I'd stop asking", "roughly 12 a quarter")
  .describe(
    "The 'What changes if you say yes' table, in the order it should read. These are claims about work " +
      "that has not happened yet, so they are written rather than counted — say what you actually expect, " +
      "and say what you would still bring to them ('anything Ferris, at any amount') as one of the lines.",
  );

const draftShape = {
  blurb: z
    .string()
    .optional()
    .describe(
      "The one line under the title in the list, and the sentence the Activity aside's card shows. Say what " +
        "you noticed and where you stopped, in two sentences at most: 'I asked you about fourteen of these " +
        "last quarter and you approved every one. I stopped short of a rule because you never gave me one.'",
    ),
  confidence: confidenceSchema.optional(),
  prose: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "'What I noticed', one string per paragraph, in your own voice. Two paragraphs is usually right: what " +
        "the pattern was, then why you did not simply act on it. Do not restate the title.",
    ),
  restraint: z
    .string()
    .optional()
    .describe(
      "Where you stopped short — this is the permission you are actually asking for, and the detail pane " +
        "puts it in a panel above the two buttons. Say what is sitting undone because you waited: 'I did not " +
        "apply this while waiting. The four differences from this morning's run are still unresolved.'",
    ),
  basisLabel: z
    .string()
    .optional()
    .describe(
      "What it rests on, counted in your own unit: '14 approvals · 0 rejections', '7 runs missed the notes', " +
        "'5 drafts, 5 rewritten'. Do NOT put a date or a status in here — once it is answered the surface " +
        "prefixes this with 'adopted aug 12' itself, and a date written here would appear twice.",
    ),
  basisCount: z.number().int().nonnegative().optional().describe("The same count as a number, when there is one."),
  basisRunCount: z.number().int().nonnegative().optional().describe("How many workflow runs it was drawn from."),
  scopeLabel: z
    .string()
    .optional()
    .describe("What it reaches, in words: 'Vendor reconciliation', 'One contact', 'Scheduled workflow'."),
  scopeOkfUri: z
    .string()
    .optional()
    .describe("The rule it would become, as a uri: 'okf:policy/spend-floor', 'okf:task/inbox-triage'."),
  scopeWorkflowId: z
    .string()
    .optional()
    .describe("The id of the workflow it would change, when it would change one."),
  from: z
    .string()
    .optional()
    .describe(
      "The 'From' pair under 'This suggestion', in your own unit: '6 runs', '5 drafts'. Five drafts is not " +
        "five runs, so do not round it to runs. Everything else in that block is derived — do not try to " +
        "write a 'Formed', 'Confidence' or 'Scope' pair, they are read off the columns.",
    ),
  effect: effectSchema.optional(),
  affirm: z
    .string()
    .optional()
    .describe(
      "The button that adopts it, carrying the specific thing being agreed to: 'Set the floor at £50', " +
        "'Shift Tuesdays to 05:30'. Never 'Yes', 'OK' or 'Confirm'. Must be given together with `quiet`.",
    ),
  quiet: z
    .string()
    .optional()
    .describe(
      "The button that declines it, saying what you would do instead: 'Keep asking me', 'Leave the " +
        "schedule', 'Keep drafting'. Must be given together with `affirm`.",
    ),
  reRaiseCondition: z
    .string()
    .optional()
    .describe(
      "What would have to change before you raise this again after a no: 'I won't raise this again unless " +
        "the finance source starts failing weekly.'",
    ),
} as const;

export interface RecommendationTools {
  list: AgentTool;
  read: AgentTool;
  propose: AgentTool;
  revise: AgentTool;
  cite: AgentTool;
  answer: AgentTool;
  withdraw: AgentTool;
  supersede: AgentTool;
  forget: AgentTool;
  /** Everything. Only for an agent reading nothing a stranger wrote. */
  all: AgentTool[];
}

export function createRecommendationTools(db: Db): RecommendationTools {
  /** The stored status, which the list payload does not carry — it carries the
   *  shelf, which is three buckets for five statuses. */
  const statuses = (): Map<string, string> =>
    new Map(
      db
        .select({ id: s.recommendations.id, status: s.recommendations.status })
        .from(s.recommendations)
        .all()
        .map((r) => [r.id, r.status]),
    );

  const list = defineTool({
    name: "recommendations_list",
    kind: "read",
    description:
      "List the standing suggestions you have formed, newest movement first. Always the first step before " +
      "proposing anything: one they already declined should not be made again, and one still waiting on " +
      "them should be revised rather than duplicated. Each row carries its id, title, blurb, status, shelf, " +
      "what it rests on and when it last moved.",
    schema: z.object({
      status: z
        .enum(["proposed", "adopted", "declined", "withdrawn", "superseded"])
        .optional()
        .describe("Return only suggestions with this exact status. Omit for all of them."),
      group: z
        .enum(["Waiting on you", "Standing", "Set aside"])
        .optional()
        .describe("Return only the suggestions on this shelf. Broader than `status`; use one or the other."),
      limit: limit({ keeps: "the ones the list draws first" }),
    }),
    execute: ({ status, group, limit }) => {
      const status_ = statuses();
      const payload = loadRecommendations(db);
      const rows = payload.rows
        .filter((r) => (group ? r.group === group : true))
        .filter((r) => (status ? status_.get(r.id) === status : true))
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          title: r.title,
          blurb: r.blurb,
          status: status_.get(r.id) ?? "proposed",
          group: r.group,
          basis: r.basis,
          when: r.when,
          scope: r.scope,
          words: r.actions.map((a) => a.label),
        }));
      return { lede: payload.lede, count: rows.length, rows };
    },
  });

  const read = defineTool({
    name: "recommendations_read",
    kind: "read",
    description:
      "Read one suggestion in full: the account you wrote of what you noticed, where you stopped short, " +
      "what would change if they said yes, its pairs and its evidence. Use it before revising one, so you " +
      "are sharpening what is there rather than overwriting it with a fresh draft.",
    schema: z.object({ id: idSchema }),
    execute: ({ id }) => loadRecommendation(db, id) ?? { error: `No recommendation with id ${id}` },
  });

  const propose = defineTool({
    name: "recommendations_propose",
    kind: "write",
    description:
      "Form a new suggestion and put it in front of them; answers with the id it minted. It lands on " +
      "'Waiting on you', is counted in the sidebar, and the newest one is the card the Activity screen " +
      "draws — a real interruption, not a note to self. Propose one only when you have watched something " +
      "happen enough times to say how many, and could have acted and chose not to: `basisLabel` and " +
      "`restraint` are where you say both, and without them it reads as a guess.",
    schema: z.object({
      title: z
        .string()
        .min(1)
        .describe(
          "The suggestion itself, phrased as the thing you would do: 'Let me settle vendor differences " +
            "under £50 myself', 'Move inbox triage to 05:30 on Tuesdays'. Not a question, not a topic.",
        ),
      ...draftShape,
      formedAt: instant
        .optional()
        .describe("ISO 8601 timestamp, when this is being formed from a run that finished earlier. Defaults to now."),
    }),
    execute: (args) => {
      const { formedAt, effect, ...rest } = args;
      const id = proposeRecommendation(db, {
        ...rest,
        ...(effect ? { effect: toPairs(effect) } : {}),
        ...(formedAt ? { formedAt: new Date(formedAt) } : {}),
      });
      return { id, status: "proposed" };
    },
  });

  const revise = defineTool({
    name: "recommendations_revise",
    kind: "write",
    description:
      "Sharpen a suggestion nobody has answered yet — a better count arrived, the scope turned out narrower, " +
      "the wording was doing them no favours. Use it when it is the same ask said better; when the ask " +
      "itself has changed, propose a new one and supersede this. " +
      "Fields you omit are left alone. `prose`, `effect` and the affirm/quiet pair are lists, so each one " +
      "you give REPLACES what was there rather than adding to it — read it first.",
    schema: z.object({
      id: idSchema,
      title: z.string().min(1).optional().describe("A better phrasing of the same suggestion."),
      ...draftShape,
    }),
    execute: ({ id, effect, ...patch }) => {
      reviseRecommendation(db, id, {
        ...patch,
        ...(effect ? { effect: toPairs(effect) } : {}),
      });
      return { id, revised: true };
    },
  });

  const cite = defineTool({
    name: "recommendations_cite",
    kind: "write",
    description:
      "Point a suggestion at what you read before you formed it — the messages, screenshots and pages that " +
      "are the actual basis for the count in `basisLabel`. It fills 'What I formed it from', which is where " +
      "somebody goes to check you rather than take your word for it; a suggestion claiming fourteen " +
      "approvals with nothing behind it is asking to be trusted. Adds to what is cited unless you pass " +
      "replace, and citing the same source twice does nothing.",
    schema: z.object({
      id: idSchema,
      citations: z
        .array(
          z.object({
            sourceId: z
              .string()
              .min(1)
              .describe("Id of the conversation, screenshot or page being cited. It must already exist."),
            title: z
              .string()
              .optional()
              .describe(
                "What this citation calls the source — the part of it that mattered, which is often not " +
                  "its own title: 'The fourteenth approval', 'Draft five, before and after'. Omit to use " +
                  "the source's own name.",
              ),
            why: z
              .string()
              .optional()
              .describe(
                "Why you kept it, in one sentence: 'It's the clearest statement that the amount, not the " +
                  "vendor, is what you're deciding on.' Say what it shows, not what it is.",
              ),
            quote: z
              .string()
              .optional()
              .describe("The clause that mattered, quoted exactly, so it can be found again if the source moves."),
          }),
        )
        .min(1),
      replace: z
        .boolean()
        .default(false)
        .describe("Drop everything already cited and use only these. Leave false to add to the list."),
    }),
    execute: ({ id, citations, replace }) => ({ id, cited: citeForRecommendation(db, id, citations, { replace }) }),
  });

  const answer = defineTool({
    name: "recommendations_answer",
    kind: "write",
    description:
      "Write down an answer a person actually gave, in conversation or through the screen: they adopted the " +
      "suggestion or they declined it. It moves off 'Waiting on you' onto 'Standing' or 'Set aside', stops " +
      "the sidebar counting it, and closes the question behind it everywhere it is being asked. " +
      "After adopting one, actually apply it, and say so in `outcome`.",
    schema: z.object({
      id: idSchema,
      stance: z
        .enum(["adopted", "declined"])
        .describe("'adopted' — they said yes and it is now in force. 'declined' — they said no."),
      answeredBy: z
        .enum(["user", "agent"])
        .default("user")
        .describe(
          "Who gave the answer. 'user' means a person actually said it and you are writing it down. 'agent' " +
            "means a policy of yours settled it, which needs a reason in `outcome`.",
        ),
      basisLabel: z
        .string()
        .optional()
        .describe(
          "What it rests on now that it is settled — '6 runs since'. The surface prefixes it with the " +
            "answer and its date ('adopted aug 12 · 6 runs since'), so give only the part after that.",
        ),
      outcome: z
        .string()
        .optional()
        .describe("What followed, in your voice: 'Six runs have used it. The run now asks four questions instead of nineteen.'"),
      appliedPermissionId: z
        .string()
        .optional()
        .describe("For an adopted one: the id of the workflow permission it actually became."),
      appliedInstructionId: z
        .string()
        .optional()
        .describe("For an adopted one: the id of the standing instruction it actually became."),
    }),
    execute: ({ id, stance, answeredBy, ...rest }) => {
      answerRecommendation(db, id, stance, { by: answeredBy, ...rest });
      return { id, status: stance };
    },
  });

  const withdraw = defineTool({
    name: "recommendations_withdraw",
    kind: "write",
    description:
      "Take a suggestion back, because what you thought you had noticed stopped being true — the pattern " +
      "broke, the count was wrong, the thing it was about went away. It moves to 'Set aside' marked as " +
      "dropped rather than declined, so it is not mistaken for something they turned down: nobody answered " +
      "it, and the surface says so.",
    schema: z.object({
      id: idSchema,
      because: z
        .string()
        .optional()
        .describe("Why you are taking it back, in your voice. Shown as what became of it."),
    }),
    execute: ({ id, because }) => {
      withdrawRecommendation(db, id, because);
      return { id, status: "withdrawn" };
    },
  });

  const supersede = defineTool({
    name: "recommendations_supersede",
    kind: "write",
    description:
      "Replace a suggestion with a newer one that asks for something materially different — for the same " +
      "ask said better, revise instead. The old one moves to 'Set aside' reading 'Superseded' and an edge " +
      "is written from the new one to it, so the newer suggestion can show what it grew out of rather than " +
      "appearing from nowhere. Propose the replacement first; this tool takes both ids.",
    schema: z.object({
      id: idSchema.describe("The suggestion being replaced. Must still be 'proposed'."),
      supersededBy: idSchema.describe("The newer suggestion, from a previous recommendations_propose call."),
      because: z.string().optional().describe("Why the newer one replaces it, in your voice."),
    }),
    execute: ({ id, supersededBy, because }) => {
      supersedeRecommendation(db, id, supersededBy, because);
      return { id, status: "superseded", supersededBy };
    },
  });

  const forget = defineTool({
    name: "recommendations_forget",
    kind: "write",
    description:
      "Delete a suggestion outright, with its account, its pairs, its buttons and the question behind it. " +
      "The only one of these tools that loses information: it is for a row that should never have existed " +
      "— a duplicate, or one formed from a misreading — where leaving it on 'Set aside' would be filing a " +
      "mistake rather than fixing it.",
    schema: z.object({
      id: idSchema,
      confirm: z
        .literal(true)
        .describe("Must be true. Present so this cannot be reached by a malformed call to another tool."),
    }),
    execute: ({ id }) => {
      forgetRecommendation(db, id);
      return { id, forgotten: true };
    },
  });

  return {
    list,
    read,
    propose,
    revise,
    cite,
    answer,
    withdraw,
    supersede,
    forget,
    all: [list, read, propose, revise, cite, answer, withdraw, supersede, forget] as AgentTool[],
  };
}

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

/**
 * What one suggestion IS, as the agent is told about it.
 *
 * Split three ways because the record is: the columns of `recommendations`, the
 * evidence links hanging off it, and the writing — which lives one row per
 * paragraph in `narratives`, one row per pair in `attributes` and one row per
 * word in `actions`. The tools take that writing as plain fields and assemble
 * it underneath, so `derived` is where the agent finds out those fields exist
 * at all: nothing in the schema would ever mention them.
 */
const SPINE: FieldDoc[] = describeTable(s.recommendations, {
  id: "Minted when you propose. Every other tool here takes it back.",
  title: "The suggestion itself, phrased as the thing you would do. Not a question and not a topic.",
  status:
    "Where it stands, and the only thing the three shelves are read from: proposed is 'Waiting on you', " +
    "adopted is 'Standing', and declined, withdrawn and superseded all sit on 'Set aside'. You never write " +
    "it directly — each write tool moves it.",
  confidence:
    "How sure you were while it was still being asked. Shown until it is answered and not after: the honest " +
    "word then is their answer.",
  formedAt: "When you formed it — the run it came out of, not when you got round to writing it down.",
  basisLabel:
    "What it rests on, in your own unit: '14 approvals · 0 rejections'. Never a date or a status — the " +
    "surface prefixes both itself.",
  basisCount: "The same count as a number, when there is one.",
  basisRunCount: "How many workflow runs it was drawn from.",
  scopeLabel: "What it reaches: 'Vendor reconciliation', 'One contact'.",
  scopeOkfUri: "The rule it would become: 'okf:policy/spend-floor'.",
  scopeWorkflowId: "The workflow it would change, when it would change one.",
  reRaiseCondition: "What would have to change before you raise this again after a no.",
  appliedPermissionId:
    "Once adopted, the workflow permission it actually became — what later lets you say 'six runs have " +
    "used it' rather than 'you agreed to it'.",
  appliedInstructionId: "Once adopted, the standing instruction it actually became.",
  // Bookkeeping the writes fill in for themselves. An agent that knew these
  // existed would only be tempted to set them, and none of the tools can.
  decidedAt: null,
  decidedBy: null,
  decisionId: null,
  reRaiseAfter: null,
});

/**
 * The citation as `recommendations_cite` takes it, not as `evidence_links`
 * stores it.
 *
 * Written by hand rather than through describeTable for one reason: the tool's
 * `quote` is stored as a pin (`pinKind` plus `pinQuote`), so a rendering of the
 * columns would name two fields the agent cannot set and miss the one it can.
 */
const EVIDENCE: FieldDoc[] = [
  {
    name: "sourceId",
    type: "text",
    required: true,
    references: "entities.id",
    note:
      "The conversation, screenshot or page you read, by its id here. It must already exist: a citation " +
      "points at something rather than describing it, so this is never a url.",
  },
  {
    name: "title",
    type: "text",
    required: false,
    note: "The part of the source that mattered, which is often not what the source itself is called.",
  },
  {
    name: "why",
    type: "text",
    required: false,
    note: "Why you kept it. Say what it shows, not what it is.",
  },
  {
    name: "quote",
    type: "text",
    required: false,
    note: "The clause that mattered, quoted exactly, so it survives the source moving.",
  },
];

const DERIVED: DerivedField[] = [
  {
    name: "blurb",
    type: "string",
    note: "The one line under the title in the list, and the sentence the Activity card shows.",
  },
  {
    name: "prose",
    type: "string[]",
    note:
      "'What I noticed', one string per paragraph, in your own voice. Replaced whole: what you pass is all " +
      "the paragraphs, not one more.",
  },
  {
    name: "restraint",
    type: "string",
    note:
      "Where you stopped short: the permission you are actually asking for, and the panel above the two " +
      "buttons.",
  },
  {
    name: "from",
    type: "string",
    note:
      "The 'From' pair, in your own unit: '6 runs', '5 drafts'. The only stored pair — 'Formed', " +
      "'Confidence' and 'Scope' are read off the columns above.",
  },
  {
    name: "effect",
    type: "label/value pairs",
    note: "'What changes if you say yes', in the order it should read. Replaced whole, like prose.",
  },
  {
    name: "affirm / quiet",
    type: "string pair",
    note:
      "The two words the row is settled with: the affirm carries the thing being agreed to ('Set the floor " +
      "at £50'), the quiet one what you would do instead ('Keep asking me'). Both or neither — a row " +
      "offering an affirm and no way out is a question somebody is held to.",
  },
];

/**
 * Everything a suggestion goes through, said once.
 *
 * It used to be said five times, in the descriptions of revise, answer,
 * withdraw, supersede and forget, because each of them needed the same two
 * sentences about `proposed` for its own refusal to make sense. Saying it here
 * is what lets those five describe only what they do.
 */
const GUIDANCE = `
One status machine sits under all of this. A suggestion is born proposed, and
proposed is the only status anything may be revised, withdrawn or superseded
from. Those three refuse a settled one, and are right to: what a suggestion said
is part of why it was answered the way it was, so rewriting it afterwards leaves
their answer attached to a different question.

Answering is the one-way door, and it is THEIR answer rather than yours — write
down only what a person actually said, in conversation or through the screen.
Never adopt your own suggestion on their behalf because it looks obviously
right, or because nobody replied; if you have changed your mind about one,
withdraw it.

Forgetting one outright is the last resort and the only thing here that loses
anything: for a row that should never have existed, never for one you simply no
longer stand behind, and never for one a person answered.
`;

const PURPOSE = `
A recommendation is a standing change you would like to make to how you work,
drawn from what you have watched happen. It is not a task and not a reminder: it
is you noticing a pattern in your own work, stopping short of acting on it, and
asking for the rule in one place rather than asking the same question fourteen
more times.

Three things these tools deliberately cannot do, so do not look for them: set a
shelf, a mark, a "when" or the header's count, all four of which are read off
the status and the date it was answered; write only one of the two words that
settle a suggestion; answer one twice, or rewrite one after it has been
answered.
`;

/**
 * The Recommendations group.
 *
 * Every tool, always: an agent that may not write gets the group through
 * `readOnly`, which is the one place that filtering happens.
 */
export function recommendationsGroup(context: ToolGroupContext): ToolGroup {
  const tools = createRecommendationTools(context.db);
  return defineToolGroup({
    name: "recommendations",
    title: "Recommendations",
    summary:
      "The standing suggestions you have formed about how you work — a pattern you noticed, the rule you " +
      "would like to be given for it, and what became of asking.",
    purpose: PURPOSE,
    guidance: GUIDANCE,
    shape: {
      singular: "recommendation",
      spine: SPINE,
      related: [{ label: "Cited evidence — one row per source, in the order you cited them", fields: EVIDENCE }],
      derived: DERIVED,
    },
    tools: tools.all,
  });
}
