// Reusable, typed prompt templates. Each builder is a `PromptTemplate<V>` — a
// function from a vars object to a finished string — so call sites stay free
// of hand-rolled string interpolation. Feed one (plus its vars) to
// `Agent.run(template, vars)` instead of a literal string.
import dedent from "dedent";
import { type ChatMessage} from "./core/providers"

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

/**
 * Asks the agent for the current weather in a given city. Consumed by the demo
 * `/agent` endpoint via `demoAgent.run(weatherPrompt, { city })`.
 */
export const weatherPrompt: PromptTemplate<{ city: string }> = ({ city }) => dedent`
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
          parts.push(`[assistant tool call] ${c.name}(${JSON.stringify(c.arguments)})`);
        }
        return parts.length ? parts.join("\n") : "[assistant] (empty)";
      }
      return `[${m.role}] ${m.content}`;
    })
    .join("\n");
}

export const graderPrompt: PromptTemplate<{ output: string; messages: ChatMessage[]; }> = ({ output, messages }) => dedent`
  You are a strict grader evaluating a model's output. Grade the following output on three criteria from 1 to 10:

  1. Model accuracy: Is the output factually correct and accurate?
  2. Response specificity: Is the output specific and detailed rather than vague?
  3. Adherence to given constraints: Does the output follow all provided constraints are requirements mentioned in the prompt?

  Output: ${output}

  Conversation:
  ${formatTranscript(messages)}

  Use the calculate tool to calculate the average of the three scores. If the average is above 7, pass the output. Otherwise, fail it.
`;