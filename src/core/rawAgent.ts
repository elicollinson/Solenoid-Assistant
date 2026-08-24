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
  safeMessagesJson,
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

export const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60_000;
const SUBMIT_RESULT_TOOL_NAME = "submit_result";

export class AgentTimeoutError extends Error {
  readonly code = "AGENT_TIMEOUT";

  constructor(readonly timeoutMs: number) {
    super(`Agent run timed out after ${timeoutMs}ms`);
    this.name = "AgentTimeoutError";
  }
}

export class AgentRunError extends Error {
  readonly code = "AGENT_RUN_FAILED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRunError";
  }
}

export interface ModelRoute {
  client: ChatProvider;
  model: string;
}

/** Ordered route chain with its non-empty invariant represented in the type. */
export type ModelRouteChain = readonly [ModelRoute, ...ModelRoute[]];

export interface ModelRouteInput extends Omit<ModelRoute, "client"> {
  client: ChatProvider | Ollama;
}

export type ModelRouteInputChain = readonly [ModelRouteInput, ...ModelRouteInput[]];

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new AgentRunError("Agent run was aborted");
}

interface LoopOptions {
  signal: AbortSignal;
  think: ThinkLevel;
  phase: "work" | "serialize";
  format?: OutputFormat;
  schema?: z.ZodType;
  submitResult?: boolean;
  toolsEnabled?: boolean;
}

export interface AgentOptions {
  /** Ordered, non-empty provider/model chain. Failed tasks advance one route. */
  routes: ModelRouteInputChain;
  systemPrompt?: string;
  tools?: AgentTool[];
  reviewers?: Reviewer[];
  think?: ThinkLevel;
  // Native structured-output backends reason and submit a schema-validated
  // result in the same run by default. Set false for models that need a terse
  // non-reasoning structured pass. Two-stage backends always reason during the
  // work phase and disable reasoning only for serialization.
  thinkOnStructured?: boolean;
  /** Whole-run deadline, including model continuations and tool calls. */
  timeoutMs?: number;
  // Name shown on the AGENT root span; defaults to the (sub)class name.
  name?: string;
}

export class Agent {
  protected readonly routes: readonly [
    { client: ChatProvider; model: string },
    ...Array<{ client: ChatProvider; model: string }>,
  ];
  protected readonly systemPrompt: string;
  protected readonly tools = new Map<string, AgentTool>();
  protected readonly reviewers = new Map<string, Reviewer>();
  protected readonly think: ThinkLevel;
  protected readonly thinkOnStructured: boolean;
  protected readonly timeoutMs: number;
  protected readonly name: string;

  constructor(opts: AgentOptions) {
    if (!opts.routes.length) {
      throw new Error("At least one model route must be configured");
    }
    // Built-in providers trace their own calls; traceProvider() only wraps
    // custom providers. Normalize every route once at construction.
    this.routes = opts.routes.map((route) => {
      if (!route.model.trim()) throw new Error("Model route names cannot be empty");
      return {
        client: traceProvider(
          route.client instanceof Ollama
            ? new OllamaProvider(route.client)
            : route.client,
        ),
        model: route.model,
      };
    }) as unknown as typeof this.routes;
    this.name = opts.name ?? this.constructor.name;
    this.systemPrompt = opts.systemPrompt ?? defaultSystemPrompt();
    this.think = opts.think ?? true;
    this.thinkOnStructured = opts.thinkOnStructured ?? true;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive finite number");
    }
    for (const t of opts.tools ?? []) this.addTool(t);
    for (const reviewer of opts.reviewers ?? []) this.addReviewer(reviewer);
    // Bind once so `agent.run` stays passable as a bare callback (the previous
    // arrow-function-field behavior) despite `run` now being an overloaded
    // method with a generic signature.
    this.run = this.run.bind(this);
    this.runMessages = this.runMessages.bind(this);
  }

  // Chainable registration. `this` return type lets you do agent.addTool(a).addTool(b).
  addTool(tool: AgentTool): this {
    const name = tool.definition.function.name.trim();
    if (!name) throw new Error("Agent tools must have a non-empty name");
    if (name === SUBMIT_RESULT_TOOL_NAME) {
      throw new Error(`Agent tool name "${SUBMIT_RESULT_TOOL_NAME}" is reserved`);
    }
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

    return this.runTraced(
      [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: prompt },
      ],
      schema,
      prompt,
      "text/plain",
    );
  }

  /** Run a provider-normalized multimodal transcript through the same loop. */
  runMessages(messages: ChatMessage[]): Promise<string>;
  runMessages<S extends z.ZodType>(
    messages: ChatMessage[],
    schema: S,
  ): Promise<z.infer<S>>;
  async runMessages(
    messages: ChatMessage[],
    schema?: z.ZodType,
  ): Promise<unknown> {
    const normalized = messages.some((message) => message.role === "system")
      ? [...messages]
      : [{ role: "system" as const, content: this.systemPrompt }, ...messages];
    return this.runTraced(
      normalized,
      schema,
      safeMessagesJson(normalized),
      "application/json",
    );
  }

  private runTraced(
    messages: ChatMessage[],
    schema: z.ZodType | undefined,
    inputValue: string,
    inputMimeType: "text/plain" | "application/json",
  ): Promise<unknown> {
    // Traced entry: one AGENT root span per invocation. Subclasses customize
    // behavior by overriding runInner/loop — never run or runMessages — so the
    // span and deadline always stay intact.
    return withSpanKind(
      "AGENT",
      this.name,
      {
        [SemanticConventions.INPUT_VALUE]: inputValue,
        [SemanticConventions.INPUT_MIME_TYPE]: inputMimeType,
        "agent.timeout_ms": this.timeoutMs,
        "agent.route_count": this.routes.length,
        ...Object.fromEntries(this.routes.flatMap((route, index) => [
          [`agent.routes.${index}.provider`, route.client.providerName ?? "unknown"],
          [`agent.routes.${index}.model`, route.model],
        ])),
        ...this.getTraceAttributes(),
      },
      async (span) => {
        for (let index = 0; index < this.routes.length; index++) {
          const route = this.routes[index]!;
          try {
            const result = await this.runAttempt(
              route.client,
              route.model,
              messages,
              schema,
            );
            span.setAttribute("agent.completed_route_index", index);
            span.setAttribute(
              SemanticConventions.OUTPUT_VALUE,
              typeof result === "string" ? result : safeJson(result),
            );
            return result;
          } catch (error) {
            const nextRoute = this.routes[index + 1];
            if (!nextRoute) throw error;
            span.addEvent("agent.route_advanced", {
              "route.failed_index": index,
              "route.failed_provider": route.client.providerName ?? "unknown",
              "route.failed_model": route.model,
              "route.next_provider": nextRoute.client.providerName ?? "unknown",
              "route.next_model": nextRoute.model,
              "route.error": error instanceof Error ? error.message : String(error),
            });
            log.warn("[route] task failed; requeueing on the next model route", {
              failedRouteIndex: index,
              failedProvider: route.client.providerName ?? "unknown",
              failedModel: route.model,
              nextRouteIndex: index + 1,
              nextProvider: nextRoute.client.providerName ?? "unknown",
              nextModel: nextRoute.model,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        throw new AgentRunError("Model route chain was unexpectedly empty");
      },
    );
  }

  private async runAttempt(
    client: ChatProvider,
    model: string,
    originalMessages: ChatMessage[],
    schema: z.ZodType | undefined,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new AgentTimeoutError(this.timeoutMs)),
      this.timeoutMs,
    );
    try {
      // The loop mutates its transcript. Each provider attempt starts from the
      // same original task rather than inheriting a failed model trajectory.
      const messages = originalMessages.map((message) => ({
        ...message,
        ...(message.images ? { images: [...message.images] } : {}),
        ...(message.toolCalls ? { toolCalls: [...message.toolCalls] } : {}),
      }));
      return await this.runInner(messages, schema, controller.signal, client, model);
    } catch (error) {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  protected async runInner(
    messages: ChatMessage[],
    schema: z.ZodType | undefined,
    signal: AbortSignal,
    client: ChatProvider = this.routes[0].client,
    model: string = this.routes[0].model,
  ): Promise<unknown> {
    if (!schema) {
      return this.loop(messages, {
        signal,
        think: this.think,
        phase: "work",
      }, client, model);
    }
    const format = toOutputFormat("agent_output", schema);
    const strategy = client.structuredOutputStrategy ?? "native";
    let raw: string;

    if (strategy === "two-stage") {
      const draft = await this.loop(messages, {
        signal,
        think: this.think,
        phase: "work",
      }, client, model);
      raw = await this.loop(
        [
          {
            role: "system",
            content:
              "Convert the supplied completed answer into the requested JSON schema. " +
              "Preserve its facts and do not perform new research.",
          },
          { role: "user", content: draft },
        ],
        {
          signal,
          think: false,
          phase: "serialize",
          format,
          schema,
          toolsEnabled: false,
        },
        client,
        model,
      );
    } else {
      raw = await this.loop(
        [
          ...messages,
          {
            role: "system",
            content:
              `When the task is complete, call ${SUBMIT_RESULT_TOOL_NAME} with the final result.`,
          },
        ],
        {
          signal,
          think: this.thinkOnStructured ? this.think : false,
          phase: "work",
          schema,
          submitResult: true,
        },
        client,
        model,
      );
    }

    const json = extractJson(raw);
    if (!json) {
      throw new AgentRunError(
        "Structured output missing after the runner reported completion",
      );
    }
    try {
      return schema.parse(JSON.parse(json));
    } catch (err) {
      throw new AgentRunError(
        `Structured output failed validation after the runner reported completion: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
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

  protected async reviewCandidate(
    messages: ChatMessage[],
    output = messages.at(-1)?.content ?? "",
    signal?: AbortSignal,
    client: ChatProvider = this.routes[0].client,
    model: string = this.routes[0].model,
  ): Promise<Array<{ name: string; result: ReviewResult }>> {
    const context = { output, messages: [...messages], signal, client, model };
    const reviews: Array<{ name: string; result: ReviewResult }> = [];

    for (const [name, reviewer] of this.reviewers) {
      const result = await this.withChildSpan(
        "EVALUATOR",
        name,
        { [SemanticConventions.INPUT_VALUE]: output },
        async (span) => {
          const review = await this.awaitWithSignal(
            reviewer.review(context),
            signal ?? new AbortController().signal,
          );
          span.setAttribute(SemanticConventions.OUTPUT_VALUE, safeJson(review));
          return review;
        },
      );
      reviews.push({ name, result });
    }

    return reviews;
  }

  protected async loop(
    messages: ChatMessage[],
    options: LoopOptions,
    client: ChatProvider = this.routes[0].client,
    model: string = this.routes[0].model,
  ): Promise<string> {
    const toolDefs = options.toolsEnabled === false
      ? []
      : [...this.tools.values()].map((tool) => tool.definition);
    if (options.submitResult && options.schema) {
      const resultFormat = toOutputFormat("agent_output", options.schema);
      toolDefs.push({
        type: "function",
        function: {
          name: SUBMIT_RESULT_TOOL_NAME,
          description: "Submit the completed, schema-valid final result.",
          parameters: resultFormat.schema,
        },
      });
    }

    let turn = 0;
    let retryDelayMs = 250;
    while (true) {
      if (options.signal.aborted) throw abortReason(options.signal);
      turn++;

      let msg: ChatMessage;
      try {
        msg = await this.awaitWithSignal(
          client.chat(messages, {
            model,
            tools: toolDefs,
            think: options.think,
            format: options.format,
            signal: options.signal,
            turn,
            phase: options.phase,
          }),
          options.signal,
        );
        retryDelayMs = 250;
      } catch (error) {
        if (options.signal.aborted) throw abortReason(options.signal);
        if (!this.isTransientProviderError(error)) throw error;
        log.warn("[retry] transient model call failure", {
          turn,
          phase: options.phase,
          retryInMs: retryDelayMs,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.waitFor(retryDelayMs, options.signal);
        retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
        continue;
      }

      if (msg.thinking) {
        log.info(`\n[thinking] ${msg.thinking.slice(0, 200)}...`);
      }
      messages.push(msg); // preserve native reasoning/tool payload for continuation

      if (this.isRefusal(msg.finishReason)) {
        throw new AgentRunError(
          `Model declined the request (finish reason: ${msg.finishReason})`,
        );
      }

      if (msg.toolCalls?.length) {
        let submitted: string | undefined;
        let submitFeedback: string | undefined;

        for (const call of msg.toolCalls) {
          if (
            options.submitResult &&
            options.schema &&
            call.name === SUBMIT_RESULT_TOOL_NAME
          ) {
            if (msg.toolCalls.length > 1) {
              messages.push({
                role: "tool",
                toolCallId: call.id,
                toolName: call.name,
                content:
                  "Result deferred because this turn requested additional tools. " +
                  "Use their results, then submit the final result in its own turn.",
              });
              continue;
            }
            const parsed = options.schema.safeParse(call.arguments);
            if (parsed.success) {
              submitted = JSON.stringify(parsed.data);
              const failedReviews = (
                await this.reviewCandidate(
                  messages,
                  submitted,
                  options.signal,
                  client,
                  model,
                )
              ).filter(({ result }) => !result.passed);
              if (!failedReviews.length) return submitted;
              submitFeedback = failedReviews
                .map(({ name, result }) => `${name} Feedback: ${result.feedback}`)
                .join("\n");
            } else {
              submitFeedback = parsed.error.message;
            }
            messages.push({
              role: "tool",
              toolCallId: call.id,
              toolName: call.name,
              content: `Result rejected: ${submitFeedback}`,
            });
            continue;
          }

          const output = await this.invokeTool(
            call.name,
            call.arguments,
            options.signal,
          );
          messages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: output,
          });
        }

        if (submitted && submitFeedback) {
          messages.push({
            role: "system",
            content: submitFeedback,
          });
        }
        continue;
      }

      const content = msg.content.trim();
      if (
        this.isIncomplete(msg.finishReason) ||
        (!content && (Boolean(options.schema) || Boolean(msg.thinking)))
      ) {
        log.warn("[continue] model turn was incomplete", {
          turn,
          phase: options.phase,
          finishReason: msg.finishReason ?? "unknown",
          reasoningChars: msg.thinking?.length ?? 0,
          contentChars: msg.content.length,
        });
        messages.push({
          role: "user",
          content: options.schema
            ? options.submitResult
              ? `Continue working. When complete, call ${SUBMIT_RESULT_TOOL_NAME} with the final result.`
              : "Return the complete JSON object matching the schema."
            : "Continue working and provide the complete final answer when ready.",
        });
        // A local server can occasionally return an immediate empty response.
        // Pace those continuations so the deadline cannot turn into a hot loop.
        if (!content && !msg.thinking) {
          await this.waitFor(100, options.signal);
        }
        continue;
      }

      if (options.schema) {
        const validation = this.validateStructured(content, options.schema);
        if (!validation.ok) {
          messages.push({
            role: "user",
            content: options.submitResult
              ? `The candidate did not match the required schema: ${validation.error}. Continue working, then call ${SUBMIT_RESULT_TOOL_NAME}.`
              : `The candidate did not match the required schema: ${validation.error}. Return the complete corrected JSON object.`,
          });
          continue;
        }
      }

      const failedReviews = (await this.reviewCandidate(
        messages,
        content,
        options.signal,
        client,
        model,
      )).filter(
        ({ result }) => !result.passed,
      );
      if (!failedReviews.length) return content;

      messages.push({
        role: "system",
        content: failedReviews
          .map(({ name, result }) => `${name} Feedback: ${result.feedback}`)
          .join("\n"),
      });
    }
  }

  private validateStructured(
    raw: string,
    schema: z.ZodType,
  ): { ok: true } | { ok: false; error: string } {
    const json = extractJson(raw);
    if (!json) return { ok: false, error: "the response was empty" };
    try {
      schema.parse(JSON.parse(json));
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: message.length > 2_000 ? `${message.slice(0, 2_000)}…` : message,
      };
    }
  }

  private isIncomplete(finishReason: string | undefined): boolean {
    return finishReason === "length" || finishReason === "max_tokens";
  }

  private isRefusal(finishReason: string | undefined): boolean {
    return finishReason === "content_filter" || finishReason === "refusal";
  }

  private isTransientProviderError(error: unknown): boolean {
    const candidate = error as {
      status?: number;
      statusCode?: number;
      code?: string;
      name?: string;
      message?: string;
      cause?: { code?: string };
    };
    const status = candidate?.status ?? candidate?.statusCode;
    if (status === 408 || status === 409 || status === 429) return true;
    if (typeof status === "number" && status >= 500) return true;
    const code = candidate?.code ?? candidate?.cause?.code ?? "";
    return [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EPIPE",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(code) || [
      "TimeoutError",
      "APIConnectionError",
      "APIConnectionTimeoutError",
    ].includes(candidate?.name ?? "") || (
      candidate?.name === "TypeError" && candidate?.message?.includes("fetch failed") === true
    );
  }

  private awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortReason(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private waitFor(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  protected async invokeTool(
    name: string,
    rawArgs: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
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
          const result = await this.awaitWithSignal(
            Promise.resolve(tool.execute(args, { signal })),
            signal ?? new AbortController().signal,
          );
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
