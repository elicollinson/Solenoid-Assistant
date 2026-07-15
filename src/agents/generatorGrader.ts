import { Agent, type AgentOptions } from "../core/rawAgent";
import { type ChatMessage } from "../core/providers";
import { graderPrompt } from "../prompts";


// Extends AgentOptions with a second system prompt for the grader stage.
export interface GeneratorGraderOptions extends AgentOptions {
  graderPrompt: string;
}

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



  protected async grade(messages: ChatMessage[]): Promise<string> {

    graderPrompt({ output: messages[messages.length - 1]?.content ?? "", messages: messages });

    const msg = await this.client.chat(messages, {
      model: this.model,
      tools: [],
      think: this.think,
    });

    return msg.content;
  }

  protected override async loop(messages: ChatMessage[]): Promise<string> {
    const toolDefs = [...this.tools.values()].map((t) => t.definition);



    let i = 0;
    while(true) {
      const msg = await this.client.chat(messages, {
        model: this.model,
        tools: toolDefs,
        think: this.think,
      });

      if (msg.thinking) console.log(`\n[thinking] ${msg.thinking.slice(0, 200)}...`);

      messages.push(msg); // keep the assistant turn (incl. its reasoning) in history

      if (!msg.toolCalls?.length) return msg.content; // no tools requested => done

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
