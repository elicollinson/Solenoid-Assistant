import { z } from "zod";
import { Agent, toOutputFormat, type AgentOptions } from "../core/rawAgent";
import { type ChatMessage, type OutputFormat } from "../core/providers";
import { graderPrompt } from "../prompts";


// Extends AgentOptions with a second system prompt for the grader stage.
export interface GeneratorGraderOptions extends AgentOptions {
  graderPrompt: string;
}

// Structured verdict returned by the grader stage — one score per criterion in
// the grader prompt. Ranges live in .describe() rather than .min/.max because
// some backends (Anthropic structured outputs) reject numeric constraints.
export const gradeSchema = z.object({
  accuracy: z.number().describe("Model accuracy score, 1-10"),
  specificity: z.number().describe("Response specificity score, 1-10"),
  constraintAdherence: z.number().describe("Adherence to given constraints score, 1-10"),
  averageScore: z.number().describe("Average of the three criterion scores"),
  passed: z.boolean().describe("true if the average score is above 7"),
  feedback: z.string().describe("Brief explanation of the scores and how to improve"),
});
export type GradeResult = z.infer<typeof gradeSchema>;

/**
 * A two-stage agent: a generator that produces a draft, followed by a grader
 * that critiques it. For now this is a sample child class demonstrating how to
 * extend `Agent` — it adds a `graderPrompt` constructor field and overrides
 * `loop` (adding a console log) without touching the parent's behavior.
 */
export class GeneratorGrader extends Agent {
  private readonly graderPrompt: string;

  constructor(opts: GeneratorGraderOptions) {
    super(opts);
    this.graderPrompt = opts.graderPrompt;
  }



  protected async grade(messages: ChatMessage[]): Promise<GradeResult> {

    let gPrompt = graderPrompt({ output: messages[messages.length - 1]?.content ?? "", messages: messages });

    const msg = await this.client.chat([{ role: "system", content: gPrompt },], {
      model: this.model,
      tools: [],
      think: this.think,
      format: toOutputFormat("grade", gradeSchema),
    });

    try {
      return gradeSchema.parse(JSON.parse(msg.content));
    } catch (err) {
      throw new Error(
        `Grade output failed validation: ${err instanceof Error ? err.message : String(err)}\nModel output: ${msg.content}`,
      );
    }
  }

  protected override async loop(messages: ChatMessage[], format?: OutputFormat): Promise<string> {
    const toolDefs = [...this.tools.values()].map((t) => t.definition);



    let i = 0;
    while(true) {
      const msg = await this.client.chat(messages, {
        model: this.model,
        tools: toolDefs,
        think: this.think,
        format,
      });

      if (msg.thinking) console.log(`\n[thinking] ${msg.thinking.slice(0, 200)}...`);

      messages.push(msg); // keep the assistant turn (incl. its reasoning) in history

      if (!msg.toolCalls?.length) {
        const grade = await this.grade(messages);
        if (grade.passed) {
          return msg.content;
        } else {
          messages.push({role: "system", content: `Grader Feedback: ${grade.feedback}`})
        }
      } // no tools requested => done

      for (const call of msg.toolCalls) {
        const output = await this.invokeTool(call.name, call.arguments);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: output,
        });
      }
      i++;
      if (this.maxIterations && i >= this.maxIterations) return "Stopped: hit max iterations.";
    }
  }
}
