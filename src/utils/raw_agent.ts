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

interface AgentOptions {
  // A ChatProvider (OllamaProvider | OpenAIProvider | AnthropicProvider), or a
  // bare Ollama client which gets wrapped in OllamaProvider automatically.
  client: ChatProvider | Ollama;
  model: string;
  systemPrompt?: string;
  tools?: AgentTool[];
  maxIterations?: number;
  think?: ThinkLevel;
}

export class Agent {
  private readonly client: ChatProvider;
  private readonly model: string;
  private readonly systemPrompt: string;
  private readonly tools = new Map<string, AgentTool>();
  private readonly maxIterations: number;
  private readonly think: ThinkLevel;

  constructor(opts: AgentOptions) {
    this.client = opts.client instanceof Ollama ? new OllamaProvider(opts.client) : opts.client;
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt ?? "You are a helpful assistant. Use tools when needed.";
    this.maxIterations = opts.maxIterations ?? 10;
    this.think = opts.think ?? true;
    for (const t of opts.tools ?? []) this.addTool(t);
  }

  // Chainable registration. `this` return type lets you do agent.addTool(a).addTool(b).
  addTool(tool: AgentTool): this {
    this.tools.set(tool.definition.function.name ?? "", tool);
    return this;
  }

  // Arrow-function field, not a method: it captures `this` permanently, so you
  // can safely pass `agent.run` as a bare callback without it losing `this`.
  run = async (prompt: string): Promise<string> => {
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: prompt },
    ];
    return this.loop(messages);
  };

  private async loop(messages: ChatMessage[]): Promise<string> {
    const toolDefs = [...this.tools.values()].map((t) => t.definition);

    for (let i = 0; i < this.maxIterations; i++) {
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
    }
    return "Stopped: hit max iterations.";
  }

  private async invokeTool(name: string, rawArgs: unknown): Promise<string> {
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
