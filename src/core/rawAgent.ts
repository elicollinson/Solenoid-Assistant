// A no-framework Agent class, generic over providers (Ollama by default;
// OpenAI and Anthropic via the adapters in ./providers).
import { Ollama } from "ollama";
import { z } from "zod";
import { type AgentTool } from "./tools";
import {
  OllamaProvider,
  type ChatMessage,
  type ChatProvider,
  type OutputFormat,
  type ThinkLevel,
} from "./providers";
import { type PromptTemplate, defaultSystemPrompt } from "../prompts";
import {
  SemanticConventions,
  SpanStatusCode,
  safeJson,
  traceProvider,
  withSpanKind,
  type Attributes,
  type Span,
  type SpanKind,
} from "./tracing";
import { log } from "./logger";

// Zod is the single source of truth for output structures, mirroring tools.ts:
// the same schema drives the provider-side constraint AND client-side validation.
export function toOutputFormat(name: string, schema: z.ZodType): OutputFormat {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema; // backends don't want the meta-schema pointer
  return { name, schema: json };
}

// Lenient JSON recovery for backends that don't enforce the schema server-side
// (e.g. Ollama Cloud): peel off code fences or surrounding prose before
// parsing. Validation still happens via zod, so bad output fails loudly.
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export interface AgentOptions {
  // A ChatProvider (OllamaProvider | OpenAIProvider | AnthropicProvider), or a
  // bare Ollama client which gets wrapped in OllamaProvider automatically.
  client: ChatProvider | Ollama;
  model: string;
  systemPrompt?: string;
  tools?: AgentTool[];
  maxIterations?: number | undefined;
  think?: ThinkLevel;
  // Name shown on the AGENT root span; defaults to the (sub)class name.
  name?: string;
}

export class Agent {
  protected readonly client: ChatProvider;
  protected readonly model: string;
  protected readonly systemPrompt: string;
  protected readonly tools = new Map<string, AgentTool>();
  protected readonly maxIterations: number | undefined;
  protected readonly think: ThinkLevel;
  protected readonly name: string;

  constructor(opts: AgentOptions) {
    // Built-in providers extend BaseChatProvider and trace their own chat
    // calls; traceProvider() is a no-op for them and only wraps custom
    // ChatProvider implementations so their LLM calls are traced too.
    this.client = traceProvider(
      opts.client instanceof Ollama ? new OllamaProvider(opts.client) : opts.client,
    );
    this.name = opts.name ?? this.constructor.name;
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
  // vars — with an optional Zod schema as the last argument. Without a schema
  // the final answer is returned as a string; with one, the provider is
  // constrained to the schema and the answer comes back validated and typed.
  run(prompt: string): Promise<string>;
  run<S extends z.ZodType>(prompt: string, schema: S): Promise<z.infer<S>>;
  run<V>(template: PromptTemplate<V>, vars: V): Promise<string>;
  run<V, S extends z.ZodType>(template: PromptTemplate<V>, vars: V, schema: S): Promise<z.infer<S>>;
  async run(
    promptOrTemplate: string | PromptTemplate<any>,
    varsOrSchema?: unknown,
    maybeSchema?: z.ZodType,
  ): Promise<unknown> {
    const schema =
      maybeSchema ?? (varsOrSchema instanceof z.ZodType ? varsOrSchema : undefined);
    const vars = varsOrSchema instanceof z.ZodType ? undefined : varsOrSchema;
    const prompt =
      typeof promptOrTemplate === "function"
        ? (promptOrTemplate as PromptTemplate<any>)(vars)
        : promptOrTemplate;

    // Traced entry: one AGENT root span per invocation. Subclasses customize
    // behavior by overriding runInner/loop — never run — so the span (and the
    // constructor's run binding) always stays intact.
    return withSpanKind(
      "AGENT",
      this.name,
      {
        [SemanticConventions.INPUT_VALUE]: prompt,
        [SemanticConventions.INPUT_MIME_TYPE]: "text/plain",
        ...this.getTraceAttributes(),
      },
      async (span) => {
        const result = await this.runInner(prompt, schema);
        span.setAttribute(
          SemanticConventions.OUTPUT_VALUE,
          typeof result === "string" ? result : safeJson(result),
        );
        return result;
      },
    );
  }

  protected async runInner(prompt: string, schema?: z.ZodType): Promise<unknown> {
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: prompt },
    ];
    if (!schema) return this.loop(messages);

    const raw = await this.loop(messages, toOutputFormat("agent_output", schema));
    try {
      return schema.parse(JSON.parse(extractJson(raw)));
    } catch (err) {
      throw new Error(
        `Structured output failed validation: ${err instanceof Error ? err.message : String(err)}\nModel output: ${raw}`,
      );
    }
  }

  // --- Tracing extension surface ------------------------------------------
  // Subclasses can add attributes to their AGENT root span (session.id,
  // user.id, metadata, ...) without touching any tracing plumbing.
  protected getTraceAttributes(): Attributes {
    return {};
  }

  // Open a custom child span of any OpenInference kind (RETRIEVER, EVALUATOR,
  // GUARDRAIL, ...) from a subclass without importing OpenTelemetry.
  protected withChildSpan<T>(
    kind: SpanKind,
    name: string,
    attributes: Attributes,
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    return withSpanKind(kind, name, attributes, fn);
  }

  protected async loop(messages: ChatMessage[], format?: OutputFormat): Promise<string> {
    const toolDefs = [...this.tools.values()].map((t) => t.definition);
    let i = 0;
    while(true) {
      const msg = await this.client.chat(messages, {
        model: this.model,
        tools: toolDefs,
        think: this.think,
        format,
      });

      if (msg.thinking) log.info(`\n[thinking] ${msg.thinking.slice(0, 200)}...`);

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
    return withSpanKind(
      "TOOL",
      name,
      {
        [SemanticConventions.TOOL_NAME]: name,
        [SemanticConventions.TOOL_DESCRIPTION]: tool.definition.function.description ?? "",
        [SemanticConventions.TOOL_PARAMETERS]: safeJson(tool.definition.function.parameters),
      },
      async (span) => {
        // try/catch stays INSIDE the span callback: errors mark the span but
        // are still returned to the model so it can self-correct, not thrown.
        try {
          const args = tool.schema.parse(rawArgs); // validate at the boundary
          span.setAttribute(SemanticConventions.INPUT_VALUE, safeJson(args));
          log.info(`[tool] ${name}(${JSON.stringify(args)})`);
          const result = await tool.execute(args);
          const output = typeof result === "string" ? result : JSON.stringify(result);
          span.setAttributes({
            [SemanticConventions.OUTPUT_VALUE]: output,
            [SemanticConventions.OUTPUT_MIME_TYPE]:
              typeof result === "string" ? "text/plain" : "application/json",
          });
          return output;
        } catch (err) {
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR });
          // Feed errors back to the model so it can self-correct rather than crashing.
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    );
  }
}
