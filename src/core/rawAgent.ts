// A no-framework Agent class, generic over providers (Ollama by default;
// OpenAI and Anthropic via the adapters in ./providers).
import { Ollama } from "ollama";
import { type AgentTool } from "./tools";
import {
  OllamaProvider,
  type ChatMessage,
  type ChatProvider,
  type ThinkLevel,
} from "./providers";
import { type PromptTemplate, defaultSystemPrompt } from "../prompts";

export interface AgentOptions {
  // A ChatProvider (OllamaProvider | OpenAIProvider | AnthropicProvider), or a
  // bare Ollama client which gets wrapped in OllamaProvider automatically.
  client: ChatProvider | Ollama;
  model: string;
  systemPrompt?: string;
  tools?: AgentTool[];
  maxIterations?: number | undefined;
  think?: ThinkLevel;
}

export class Agent {
  protected readonly client: ChatProvider;
  protected readonly model: string;
  protected readonly systemPrompt: string;
  protected readonly tools = new Map<string, AgentTool>();
  protected readonly maxIterations: number | undefined;
  protected readonly think: ThinkLevel;

  constructor(opts: AgentOptions) {
    this.client = opts.client instanceof Ollama ? new OllamaProvider(opts.client) : opts.client;
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt ?? defaultSystemPrompt();
    this.maxIterations = opts.maxIterations;
    this.think = opts.think ?? true;
    for (const t of opts.tools ?? []) this.addTool(t);
    // Bind once so `agent.run` stays passable as a bare callback (the previous
    // arrow-function-field behavior) despite `run` now being an overloaded
    // method with a generic signature.
    this.run = this.run.bind(this);
  }

  // Chainable registration. `this` return type lets you do agent.addTool(a).addTool(b).
  addTool(tool: AgentTool): this {
    this.tools.set(tool.definition.function.name ?? "", tool);
    return this;
  }

  // Overloaded entry point: a plain string, or a `PromptTemplate<V>` plus its
  // vars. Either way the prompt is resolved to a string here, before entering
  // the loop — the loop itself is unchanged.
  run(prompt: string): Promise<string>;
  run<V>(template: PromptTemplate<V>, vars: V): Promise<string>;
  run(promptOrTemplate: string | PromptTemplate<any>, vars?: unknown): Promise<string> {
    const prompt =
      typeof promptOrTemplate === "function"
        ? (promptOrTemplate as PromptTemplate<any>)(vars)
        : promptOrTemplate;
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: prompt },
    ];
    return this.loop(messages);
  }

  protected async loop(messages: ChatMessage[]): Promise<string> {
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

  protected async invokeTool(name: string, rawArgs: unknown): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `Error: unknown tool "${name}"`;
    try {
      const args = tool.schema.parse(rawArgs); // validate at the boundary
      console.log(`[tool] ${name}(${JSON.stringify(args)})`);
      const result = await tool.execute(args);
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (err) {
      // Feed errors back to the model so it can self-correct rather than crashing.
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
