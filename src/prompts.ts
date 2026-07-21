// Reusable, typed prompt templates. Each builder is a `PromptTemplate<V>` — a
// function from a vars object to a finished string — so call sites stay free
// of hand-rolled string interpolation. Feed one (plus its vars) to
// `Agent.run(template, vars)` instead of a literal string.
import { z } from "zod";
import dedent from "dedent";
import { type ChatMessage } from "./core/providers";

/**
 * A prompt template: a pure function from a typed `vars` object to a prompt
 * string. `Agent.run` is overloaded to accept either a plain string or one of
 * these plus its vars.
 */
export type PromptTemplate<V> = (vars: V) => string;

/**
 * Default system prompt used when no `systemPrompt` is supplied to an Agent.
 * Single-line, but routed through `dedent` for consistency with the other
 * builders.
 */
export const defaultSystemPrompt: PromptTemplate<void> = () => dedent`
  You are a helpful assistant. Use tools when needed.
`;

// Structured output shape the `imessageIntakePrompt` asks the agent to
// produce: three arrays mirroring the prompt's closing instruction — action
// items, per-conversation summaries, and memory context. Passed as the
// schema arg to `imessageIntakeAgent.run` so the provider is constrained to
// this shape and the result comes back validated and typed.
export const imessageIntakeSchema = z.object({
  actionItems: z
    .array(z.string())
    .describe(
      "Actionable items extracted from the messages that need a response or follow-up",
    ),
  conversationSummaries: z
    .array(z.string())
    .describe("A short summary per conversation, capturing its gist"),
  memoryContext: z
    .array(z.string())
    .describe("Important context worth remembering for future interactions"),
});

export type ImessageIntakeResult = z.infer<typeof imessageIntakeSchema>;

export const imessageIntakePrompt: PromptTemplate<void> = () => dedent`
  # Task
  You are a message intake agent. Your goal is to examine recent iMessages and identify important context and action items.

  # Instructions
  You are to invoke the readImessagesTool for the last 24 hours and examine each message.

  Consider each message as a standalone, as well as in the broader context of its conversation and other similar messages in the same extraction.
  If you need an earlier context, you may invoke the tool again for a different time period.

  Once the full context is established, collate the messages into an array of action items, an array of summaries per conversation, and an array of important context for memory.

  # Deliverable Details

  ## Action Items
  The only things that should be surfaced as action items are things beyond the current day. For example, time sensitive information like a Doordash Order delivery or someone being on their way, are narrow timebound items that would not qualify as action items, as I can't really action them after the fact.

  By contrast, an item like ordering ingredients for a food item for tomorrow, or an event later in the week, or a deadline to submit a draft of something would all be action items, as they both require my action, and their is time between today and their "date" to action them.

  Action items also are for items that are more than notes, they are reminders. For instance, a conversation about something someone else did, bought, or saw, should not have an action item.

  In contrast, something discussed with someone to happen in the future, that I or they expressed interest in could be an action item. Examples could be but are not limited to, visiting a restaurant, watching a show, running an errand, making a call to catchup.

  # Summaries
  These are just per conversation summaries, keep them concise (ie should be shorter than the conversation itself), and descriptive of statements made and what was discussed.

  # Memory Context
  These are things that are facts about people / places / and things that are mentioned in the conversations. They should be concise notes of exactly what should be remembered.

  Sometimes the facts will be about someones opinion ie person x thinks that thing y is better than thing z, but they should not directly encode those opinions ie no "thing y is better than thing z" directly.
  `;

/**
 * Asks the agent for the current weather in a given city. Consumed by the demo
 * `/agent` endpoint via `demoAgent.run(weatherPrompt, { city })`.
 */
export const weatherPrompt: PromptTemplate<{ city: string }> = ({
  city,
}) => dedent`
  What's the weather in ${city}?
`;

/**
 * Renders a conversation as a readable transcript, one line per turn: role,
 * message content, tool calls with their arguments, and tool results with the
 * tool's name. Use this whenever messages need to go INTO a prompt — plain
 * interpolation of ChatMessage[] produces "[object Object],...".
 */
export function formatTranscript(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === "tool") {
        return `[tool result: ${m.toolName ?? "unknown"}] ${m.content}`;
      }
      if (m.role === "assistant") {
        const parts: string[] = [];
        if (m.content) parts.push(`[assistant] ${m.content}`);
        for (const c of m.toolCalls ?? []) {
          parts.push(
            `[assistant tool call] ${c.name}(${JSON.stringify(c.arguments)})`,
          );
        }
        return parts.length ? parts.join("\n") : "[assistant] (empty)";
      }
      return `[${m.role}] ${m.content}`;
    })
    .join("\n");
}

export const graderPrompt: PromptTemplate<{
  output: string;
  messages: ChatMessage[];
}> = ({ output, messages }) => dedent`
  You are a strict grader evaluating a model's output. Grade the following output on three criteria from 1 to 10:

  1. Model accuracy: Is the output factually correct and accurate?
  2. Response specificity: Is the output specific and detailed rather than vague?
  3. Adherence to given constraints: Does the output follow all provided constraints are requirements mentioned in the prompt?

  Output: ${output}

  Conversation:
  ${formatTranscript(messages)}

  Use the calculate tool to calculate the average of the three scores. If the average is above 7, pass the output. Otherwise, fail it.
`;

export const memoryGraderSchema = z.object({
  memoryRelevance: z.string().describe("The point score for memory relevance from 0 - 10"),
  memoryActionability: z.string().describe("The point score for memory actionability from 0 - 10"),
  pass: z.boolean().describe("Does the memory pass the average score requirement"),
});

export type memoryGraderResult = z.infer<typeof memoryGraderSchema>;

export const memoryGraderPrompt: PromptTemplate<{
  output: string;
}> = ({ output }) => dedent`
  You are a strict grader evaluating a set of extracted memories. Grade the following output on three criteria from 1 to 10:

  1. Memory Relevance: Is the memory something that could be useful to know?
  2. Memory Actionability: Is there something in the memory that could impact future model outputs or decisions?

  Proposed Memory: ${output}

  Use the calculate tool to calculate the average of the two scores. If the average is above 7, pass the output. Otherwise, fail it.
`;
