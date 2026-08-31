// Provider adapters: one normalized chat interface, three backends.
// Tool definitions stay in the OpenAI-style function shape (ollama's `Tool`
// type, produced by defineTool) — each adapter converts to its wire format.
import {
  Ollama,
  type ChatResponse as OllamaChatResponse,
  type Message as OllamaMessage,
  type Tool as OllamaTool,
} from "ollama";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { tracedChat } from "./tracing/tracedProvider";
import type { FunctionToolDefinition } from "./tools";
import type { TextOrigin } from "../safety/trust";

export type ThinkLevel = boolean | "low" | "medium" | "high";
export type StructuredOutputStrategy = "native" | "two-stage";

export interface ChatImage {
  /** Raw base64 payload, without a data-URL prefix. */
  data: string;
  mimeType: string;
}

export interface ToolCall {
  id: string;
  name: string;
  // Parsed object when valid; malformed provider JSON is preserved so the
  // schema/tool boundary can return repair feedback on the next turn.
  arguments: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /**
   * Who wrote this, for the injection screen. Absent means `external`, which is
   * the safe answer and the right one for almost everything: the iMessage and
   * screenshot workflows put a stranger's text into the opening transcript, so
   * "it is the first user message" says nothing about who wrote it. Set
   * "operator" only where a person is genuinely typing to their own assistant.
   *
   * Transport ignores this — every provider builds its request objects field by
   * field, so it never reaches an API.
   */
  origin?: TextOrigin;
  /** Multimodal image parts attached to a user message. */
  images?: ChatImage[];
  thinking?: string;
  toolCalls?: ToolCall[]; // assistant messages only
  toolCallId?: string; // tool messages only
  toolName?: string; // tool messages only
  // Provider-native assistant payload, echoed back verbatim on later turns.
  // Anthropic requires its content blocks (incl. thinking) to be resent
  // unmodified; OpenAI needs the original tool_calls array. Never edit this.
  raw?: unknown;
  // Token counts for this call, normalized across providers (assistant
  // messages only). Surfaced onto LLM spans as llm.token_count.*.
  usage?: TokenUsage;
  /** Provider stop signal, normalized without discarding the native value. */
  finishReason?: string;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    // Preserve malformed arguments so the tool/schema boundary can reject
    // them and return actionable feedback to the model on the next turn.
    return raw;
  }
}

// A provider-agnostic structured-output request. `schema` is plain JSON schema
// (derive it from Zod with z.toJSONSchema); each adapter maps it to its wire
// format: Ollama `format`, OpenAI `response_format`, Anthropic `output_config`.
export interface OutputFormat {
  name: string; // identifier for backends that require one (OpenAI); [a-zA-Z0-9_-]
  schema: Record<string, unknown>;
  // OpenAI-only: guaranteed schema adherence. Requires every property to be
  // `required` and additionalProperties:false, so optional fields break it.
  strict?: boolean;
}

export interface ChatOptions {
  model: string;
  tools: FunctionToolDefinition[];
  think?: ThinkLevel;
  format?: OutputFormat;
  signal?: AbortSignal;
  turn?: number;
  phase?: "work" | "serialize";
}

export interface ChatProvider {
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage>;
  // Backend label surfaced on LLM spans as llm.provider.
  readonly providerName?: string;
  // True when the provider already emits its own LLM spans (BaseChatProvider
  // subclasses). Prevents double-wrapping by traceProvider().
  readonly traced?: boolean;
  /** How schema-constrained tasks should be completed on this backend. */
  readonly structuredOutputStrategy?: StructuredOutputStrategy;
}

// ---------------------------------------------------------------------------
// Tracing lives at the client level: `chat` is the final traced entry and
// every adapter implements `chatInner`, so EVERY model call — from any agent
// loop, any subclass method, or a provider used standalone — produces an
// OpenInference LLM span. New providers get tracing for free by extending
// this class.
// ---------------------------------------------------------------------------

export abstract class BaseChatProvider implements ChatProvider {
  abstract readonly providerName: string;
  readonly traced = true;

  constructor(
    readonly structuredOutputStrategy: StructuredOutputStrategy = "native",
  ) {}

  chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    return tracedChat(this.providerName, messages, opts, () => this.chatInner(messages, opts));
  }

  protected abstract chatInner(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage>;
}

// ---------------------------------------------------------------------------
// Ollama (default)
// ---------------------------------------------------------------------------

export class OllamaProvider extends BaseChatProvider {
  readonly providerName = "ollama";

  constructor(
    private readonly client: Ollama,
    options?: { structuredOutputStrategy?: StructuredOutputStrategy },
  ) {
    super(options?.structuredOutputStrategy);
  }

  protected async chatInner(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    const ollamaMessages = messages.map((m) => this.toOllama(m));
    // Belt and braces: local Ollama enforces `format` via constrained decoding,
    // but Ollama Cloud silently ignores it (docs: "Ollama's Cloud platform does
    // not currently support structured outputs"), so also instruct the model.
    // The appended message is a request, not a decoding constraint, so the
    // shared loop still validates and repairs the result. Ollama Cloud reaches
    // this only during its reasoning-disabled serialization phase.
    if (opts.format) {
      ollamaMessages.push({
        role: "system",
        content: `Respond with a single JSON object matching this JSON schema, and nothing else — no markdown, no code fences, no commentary:\n${JSON.stringify(opts.format.schema)}`,
      });
    }
    // Stream even though the normalized provider returns one message. The
    // Ollama client only exposes per-request cancellation for streamed calls,
    // which lets the five-minute agent deadline actually stop server work.
    const stream = await this.client.chat({
      model: opts.model,
      messages: ollamaMessages,
      tools: opts.tools as OllamaTool[],
      think: opts.think,
      format: opts.format?.schema, // ollama constrains decoding to the schema
      stream: true,
    });
    if (opts.signal?.aborted) {
      stream.abort();
      throw opts.signal.reason instanceof Error
        ? opts.signal.reason
        : new Error("Ollama request aborted");
    }
    const onAbort = () => stream.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let final: OllamaChatResponse | undefined;
    let content = "";
    let thinking = "";
    const nativeToolCalls: NonNullable<OllamaMessage["tool_calls"]> = [];
    try {
      for await (const chunk of stream) {
        final = chunk;
        content += chunk.message.content ?? "";
        thinking += chunk.message.thinking ?? "";
        if (chunk.message.tool_calls?.length) {
          nativeToolCalls.push(...chunk.message.tool_calls);
        }
      }
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
    if (opts.signal?.aborted) {
      throw opts.signal.reason instanceof Error
        ? opts.signal.reason
        : new Error("Ollama request aborted");
    }
    if (!final) throw new Error("Ollama returned no response chunks");
    const raw: OllamaMessage = {
      role: "assistant",
      content,
      ...(thinking ? { thinking } : {}),
      ...(nativeToolCalls.length ? { tool_calls: nativeToolCalls } : {}),
    };
    return {
      role: "assistant",
      content,
      thinking: thinking || undefined,
      toolCalls: nativeToolCalls.map((c, i) => ({
        id: `call_${i}`, // ollama tool calls carry no id; synthesize one
        name: c.function.name,
        arguments: c.function.arguments,
      })),
      raw,
      usage: {
        promptTokens: final.prompt_eval_count,
        completionTokens: final.eval_count,
        totalTokens: (final.prompt_eval_count ?? 0) + (final.eval_count ?? 0),
      },
      finishReason: final.done_reason,
    };
  }

  private toOllama(m: ChatMessage): OllamaMessage {
    if (m.role === "assistant" && m.raw) return m.raw as OllamaMessage;
    if (m.role === "tool") return { role: "tool", tool_name: m.toolName, content: m.content };
    return {
      role: m.role,
      content: m.content,
      ...(m.images?.length ? { images: m.images.map((image) => image.data) } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// OpenAI (Chat Completions)
// ---------------------------------------------------------------------------

export class OpenAIProvider extends BaseChatProvider {
  readonly providerName: string = "openai";

  constructor(
    private readonly client: OpenAI,
    options?: { structuredOutputStrategy?: StructuredOutputStrategy },
  ) {
    super(options?.structuredOutputStrategy);
  }

  protected async chatInner(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    const openaiMessages = messages.map((m) => this.toOpenAI(m));
    // Real OpenAI enforces response_format server-side, but OpenAI-compatible
    // backends (e.g. Ollama Cloud's /v1) may silently ignore it — instruct too.
    if (opts.format) {
      openaiMessages.push({
        role: "system",
        content: `Respond with a single JSON object matching this JSON schema, and nothing else — no markdown, no code fences, no commentary:\n${JSON.stringify(opts.format.schema)}`,
      });
    }
    const res = await this.client.chat.completions.create(
      {
        model: opts.model,
        messages: openaiMessages,
        tools: opts.tools.length
          ? (opts.tools as OpenAI.Chat.Completions.ChatCompletionTool[])
          : undefined,
        // A bare `true` uses the backend default. `false` maps to the OpenAI-
        // compatible `none` value (LM Studio uses this to disable reasoning).
        ...(opts.think === false
          ? { reasoning_effort: "none" as const }
          : typeof opts.think === "string"
            ? { reasoning_effort: opts.think }
            : {}),
        ...(opts.format
          ? {
              response_format: {
                type: "json_schema" as const,
                json_schema: {
                  name: opts.format.name,
                  schema: opts.format.schema,
                  ...(opts.format.strict !== undefined ? { strict: opts.format.strict } : {}),
                },
              },
            }
          : {}),
      },
      { signal: opts.signal },
    );

    const choice = res.choices[0];
    const msg = choice?.message;
    if (!msg) throw new Error("OpenAI returned no choices");
    const reasoningContent = (msg as unknown as { reasoning_content?: unknown })
      .reasoning_content;
    return {
      role: "assistant",
      content: msg.content ?? "",
      thinking: typeof reasoningContent === "string" ? reasoningContent : undefined,
      toolCalls: msg.tool_calls
        ?.filter((c) => c.type === "function")
        .map((c) => ({
          id: c.id,
          name: c.function.name,
          arguments: parseToolArguments(c.function.arguments),
        })),
      raw: msg,
      usage: {
        promptTokens: res.usage?.prompt_tokens,
        completionTokens: res.usage?.completion_tokens,
        totalTokens: res.usage?.total_tokens,
      },
      finishReason: choice.finish_reason ?? undefined,
    };
  }

  private toOpenAI(m: ChatMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
    if (m.role === "assistant" && m.raw) {
      return m.raw as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    if (m.role === "user" && m.images?.length) {
      return {
        role: "user",
        content: [
          ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
          ...m.images.map((image) => ({
            type: "image_url" as const,
            image_url: {
              url: `data:${image.mimeType};base64,${image.data}`,
            },
          })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  }
}

/** OpenAI-compatible adapter labeled separately in logs and traces. */
export class OpenRouterProvider extends OpenAIProvider {
  override readonly providerName = "openrouter";
}

// ---------------------------------------------------------------------------
// Anthropic (Messages API)
// ---------------------------------------------------------------------------

export class AnthropicProvider extends BaseChatProvider {
  readonly providerName = "anthropic";
  private readonly maxTokens: number;

  constructor(
    private readonly client: Anthropic,
    options?: {
      maxTokens?: number;
      structuredOutputStrategy?: StructuredOutputStrategy;
    },
  ) {
    super(options?.structuredOutputStrategy);
    this.maxTokens = options?.maxTokens ?? 16000;
  }

  protected async chatInner(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const res = await this.client.messages.create(
      {
        model: opts.model,
        max_tokens: this.maxTokens,
        ...(system ? { system } : {}),
        messages: this.toAnthropic(messages),
        tools: opts.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
        })),
        ...(opts.think
          ? {
              thinking: { type: "adaptive" as const, display: "summarized" as const },
            }
          : {}),
        // effort and format share the single output_config param.
        ...(typeof opts.think === "string" || opts.format
          ? {
              output_config: {
                ...(typeof opts.think === "string" ? { effort: opts.think } : {}),
                ...(opts.format
                  ? { format: { type: "json_schema" as const, schema: opts.format.schema } }
                  : {}),
              },
            }
          : {}),
      },
      { signal: opts.signal },
    );

    const usage: TokenUsage = {
      promptTokens: res.usage.input_tokens,
      completionTokens: res.usage.output_tokens,
      totalTokens: res.usage.input_tokens + res.usage.output_tokens,
    };

    if (res.stop_reason === "refusal") {
      return {
        role: "assistant",
        content: "The request was declined by the model's safety system.",
        raw: res.content,
        usage,
        finishReason: res.stop_reason ?? undefined,
      };
    }

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const thinking = res.content
      .filter((b): b is Anthropic.ThinkingBlock => b.type === "thinking")
      .map((b) => b.thinking)
      .join("");
    const toolCalls = res.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, arguments: b.input }));

    return {
      role: "assistant",
      content: text,
      thinking: thinking || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      raw: res.content, // must be echoed back unchanged (thinking blocks included)
      usage,
      finishReason: res.stop_reason ?? undefined,
    };
  }

  // System messages go in the top-level `system` param; consecutive tool
  // results must be grouped into a single user turn.
  private toAnthropic(messages: ChatMessage[]): Anthropic.MessageParam[] {
    const out: Anthropic.MessageParam[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;

      if (m.role === "tool") {
        const block: Anthropic.ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: m.toolCallId ?? "",
          content: m.content,
        };
        const last = out[out.length - 1];
        if (last?.role === "user" && Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
          (last.content as Anthropic.ToolResultBlockParam[]).push(block);
        } else {
          out.push({ role: "user", content: [block] });
        }
        continue;
      }

      if (m.role === "assistant") {
        out.push({
          role: "assistant",
          content: m.raw
            ? (m.raw as Anthropic.ContentBlockParam[])
            : [{ type: "text", text: m.content }],
        });
        continue;
      }

      if (m.images?.length) {
        out.push({
          role: "user",
          content: [
            ...(m.content
              ? [{ type: "text" as const, text: m.content }]
              : []),
            ...m.images.map((image) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: image.mimeType as Anthropic.Base64ImageSource["media_type"],
                data: image.data,
              },
            })),
          ],
        });
      } else {
        out.push({ role: "user", content: m.content });
      }
    }
    return out;
  }
}
