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
import type { Reviewer, ReviewResult } from "./reviewer";

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
//
// Returns "" when there is nothing at all to parse (empty or whitespace-only
// input). Callers must treat that as its own failure — "the model said
// nothing" — rather than handing it to JSON.parse, which reports a misleading
// "Unexpected EOF" as though the JSON were merely malformed.
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

// How many times a schema-constrained turn may come back with no content
// before the agent gives up. Tracked separately from `maxIterations`, which
// bounds completed tool or reviewer-revision rounds — a blank turn does no
// work, so it should not consume that budget.
export const MAX_BLANK_RETRIES = 2;

export interface AgentOptions {
  // A ChatProvider (OllamaProvider | OpenAIProvider | AnthropicProvider), or a
  // bare Ollama client which gets wrapped in OllamaProvider automatically.
  client: ChatProvider | Ollama;
  model: string;
  systemPrompt?: string;
  tools?: AgentTool[];
  reviewers?: Reviewer[];
  maxIterations?: number | undefined;
  think?: ThinkLevel;
  // Keep `think` on for schema-constrained calls too. Default off: on backends
  // that don't enforce `format` (Ollama Cloud), reasoning models route the
  // final JSON into the thinking channel and return empty content — with no
  // reasoning channel open, the answer has nowhere to go but content. Opt in
  // only for structured tasks that genuinely need extended reasoning.
  thinkOnStructured?: boolean;
  // Name shown on the AGENT root span; defaults to the (sub)class name.
  name?: string;
}

export class Agent {
  protected readonly client: ChatProvider;
  protected readonly model: string;
  protected readonly systemPrompt: string;
  protected readonly tools = new Map<string, AgentTool>();
  protected readonly reviewers = new Map<string, Reviewer>();
  protected readonly maxIterations: number | undefined;
  protected readonly think: ThinkLevel;
  protected readonly thinkOnStructured: boolean;
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
    if (
      opts.maxIterations !== undefined &&
      (!Number.isInteger(opts.maxIterations) || opts.maxIterations < 1)
    ) {
      throw new Error("maxIterations must be a positive integer when provided");
    }
    this.maxIterations = opts.maxIterations;
    this.think = opts.think ?? true;
    this.thinkOnStructured = opts.thinkOnStructured ?? false;
    for (const t of opts.tools ?? []) this.addTool(t);
    for (const reviewer of opts.reviewers ?? []) this.addReviewer(reviewer);
    // Bind once so `agent.run` stays passable as a bare callback (the previous
    // arrow-function-field behavior) despite `run` now being an overloaded
    // method with a generic signature.
    this.run = this.run.bind(this);
  }

  // Chainable registration. `this` return type lets you do agent.addTool(a).addTool(b).
  addTool(tool: AgentTool): this {
    const name = tool.definition.function.name.trim();
    if (!name) throw new Error("Agent tools must have a non-empty name");
    if (this.tools.has(name)) throw new Error(`Agent tool "${name}" is already registered`);
    this.tools.set(name, tool);
    return this;
  }

  // Reviewers are optional components. When present, every candidate must pass
  // before the loop returns it; failed feedback is supplied for one more turn.
  addReviewer(reviewer: Reviewer): this {
    const name = reviewer.name.trim();
    if (!name) throw new Error("Agent reviewers must have a non-empty name");
    if (this.reviewers.has(name)) {
      throw new Error(`Agent reviewer "${name}" is already registered`);
    }
    this.reviewers.set(name, reviewer);
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

    const format = toOutputFormat("agent_output", schema);
    const raw = await this.loop(messages, format);
    const json = extractJson(raw);
    // Distinct from a validation failure: there is no candidate JSON at all.
    // Reported separately so the symptom points at the cause (a turn that
    // produced no content) instead of at the parser.
    if (!json) {
      throw new Error(
        `Structured output missing: the model ended its turn without any content to parse ` +
          `after ${MAX_BLANK_RETRIES} retries. This usually means it spent the turn on reasoning ` +
          `instead of answering — check the message.reasoning attribute on the LLM span.`,
      );
    }
    try {
      return schema.parse(JSON.parse(json));
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

  // The think level actually sent for a call: schema-constrained calls drop to
  // `false` unless the agent opted in via `thinkOnStructured` (see AgentOptions).
  // Shared so subclasses that override `loop` (or call `chat` directly with a
  // format) apply the same rule instead of re-deriving it.
  protected effectiveThink(format?: OutputFormat): ThinkLevel {
    return format && !this.thinkOnStructured ? false : this.think;
  }

  protected async reviewCandidate(
    messages: ChatMessage[],
  ): Promise<Array<{ name: string; result: ReviewResult }>> {
    const output = messages.at(-1)?.content ?? "";
    const context = { output, messages: [...messages] };
    const reviews: Array<{ name: string; result: ReviewResult }> = [];

    for (const [name, reviewer] of this.reviewers) {
      const result = await this.withChildSpan(
        "EVALUATOR",
        name,
        { [SemanticConventions.INPUT_VALUE]: output },
        async (span) => {
          const review = await reviewer.review(context);
          span.setAttribute(SemanticConventions.OUTPUT_VALUE, safeJson(review));
          return review;
        },
      );
      reviews.push({ name, result });
    }

    return reviews;
  }

  protected async loop(messages: ChatMessage[], format?: OutputFormat): Promise<string> {
    const toolDefs = [...this.tools.values()].map((t) => t.definition);
    let i = 0;
    let blankRetries = 0;
    while(true) {
      const msg = await this.client.chat(messages, {
        model: this.model,
        tools: toolDefs,
        think: this.effectiveThink(format),
        format,
      });

      if (msg.thinking) log.info(`\n[thinking] ${msg.thinking.slice(0, 200)}...`);

      messages.push(msg); // keep the assistant turn (incl. its reasoning) in history

      if (!msg.toolCalls?.length) {
        // No tools requested => the model considers itself done. On a
        // schema-constrained call that only counts if it actually produced
        // content: backends that ignore `format` (Ollama Cloud) let a reasoning
        // model spend the whole post-tool-result turn on `thinking` and return
        // content: "". Re-prompt for the JSON rather than returning the empty
        // string as a valid answer.
        if (format && !msg.content.trim() && blankRetries < MAX_BLANK_RETRIES) {
          blankRetries++;
          log.warn(
            `[retry] empty structured response, re-prompting for ${format.name} (${blankRetries}/${MAX_BLANK_RETRIES})`,
          );
          // Positive-only phrasing: an earlier nudge listed what to avoid
          // ("no reasoning, no prose, no code fences") and models kept
          // reproducing the named failure modes. State only the target shape.
          messages.push({
            role: "user",
            content:
              "Reply now with the JSON object matching the schema. Your entire " +
              "reply is that raw JSON object, starting with { and ending with }.",
          });
          continue;
        }
        const failedReviews = (await this.reviewCandidate(messages)).filter(
          ({ result }) => !result.passed,
        );
        if (!failedReviews.length) return msg.content;

        messages.push({
          role: "system",
          content: failedReviews
            .map(({ name, result }) => `${name} Feedback: ${result.feedback}`)
            .join("\n"),
        });
      } else {
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
