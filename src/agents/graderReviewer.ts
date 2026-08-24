import { z } from "zod";
import { extractJson, toOutputFormat } from "../core/rawAgent";
import type { ChatMessage, ChatProvider, ThinkLevel } from "../core/providers";
import type { Reviewer } from "../core/reviewer";
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

/** Build the rubric reviewer used by flows that opt into generate/grade/revise. */
export function createGraderReviewer(options: GraderReviewerOptions): Reviewer {
  const configuredPrompt = options.graderPrompt ?? graderPrompt;

  return {
    name: "Grader",
    async review({ output, messages, signal }): Promise<GradeResult> {
      const promptMessages = [...messages];
      const prompt =
        typeof configuredPrompt === "function"
          ? configuredPrompt({ output, messages: promptMessages })
          : configuredPrompt;
      const format = toOutputFormat("grade", gradeScoresSchema);
      const response = await options.client.chat([{ role: "system", content: prompt }], {
        model: options.model,
        tools: [],
        think: options.thinkOnStructured ? (options.think ?? true) : false,
        format,
        signal,
      });

      try {
        const scores = gradeScoresSchema.parse(JSON.parse(extractJson(response.content)));
        const averageScore =
          (scores.accuracy + scores.specificity + scores.constraintAdherence) / 3;
        return gradeSchema.parse({
          ...scores,
          averageScore,
          passed: averageScore > 7,
        });
      } catch (error) {
        throw new Error(
          `Grade output failed validation: ${error instanceof Error ? error.message : String(error)}\nModel output: ${response.content}`,
        );
      }
    },
  };
}
