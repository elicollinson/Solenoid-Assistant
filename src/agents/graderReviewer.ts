import {
  Agent,
  type ChatMessage,
  type ChatProvider,
  type Reviewer,
  type ThinkLevel,
} from "@elicollinson/solenoid-engine";
import { z } from "zod";
import { createEngineLogger } from "../core/engine";
import { graderPrompt, type PromptTemplate } from "../prompts";

export interface GraderReviewerOptions {
  client: ChatProvider;
  model: string;
  graderPrompt?: string | PromptTemplate<{ output: string; messages: ChatMessage[] }>;
  think?: ThinkLevel;
  thinkOnStructured?: boolean;
}

const gradeScoresSchema = z.object({
  accuracy: z.number().describe("Model accuracy score, 1-10"),
  specificity: z.number().describe("Response specificity score, 1-10"),
  constraintAdherence: z.number().describe("Adherence to given constraints score, 1-10"),
  feedback: z.string().describe("Brief explanation of the scores and how to improve"),
});

export const gradeSchema = gradeScoresSchema.extend({
  averageScore: z.number().describe("Average of the three criterion scores"),
  passed: z.boolean().describe("true if the average score is above 7"),
});
export type GradeResult = z.infer<typeof gradeSchema>;

/**
 * Build the rubric reviewer used by flows that opt into generate/grade/revise.
 * Runs structured grading via `@elicollinson/solenoid-engine`'s `runStructured`
 * (`submit_result` tool with automatic Zod repair feedback).
 */
export function createGraderReviewer(options: GraderReviewerOptions): Reviewer {
  const configuredPrompt = options.graderPrompt ?? graderPrompt;

  return {
    name: "Grader",
    async review({
      output,
      messages,
      signal,
      client = options.client,
      model = options.model,
    }): Promise<GradeResult> {
      const promptMessages = [...messages];
      const prompt =
        typeof configuredPrompt === "function"
          ? configuredPrompt({ output, messages: promptMessages })
          : configuredPrompt;

      const grader = new Agent({
        name: "grader-reviewer",
        routes: [{ client, model }],
        think: options.thinkOnStructured ? (options.think ?? true) : false,
        logger: createEngineLogger("grader"),
      });

      const scores = await grader.runStructured(
        prompt,
        gradeScoresSchema,
        signal ? { signal } : {},
      );
      const averageScore =
        (scores.accuracy + scores.specificity + scores.constraintAdherence) / 3;
      return gradeSchema.parse({
        ...scores,
        averageScore,
        passed: averageScore > 7,
      });
    },
  };
}
