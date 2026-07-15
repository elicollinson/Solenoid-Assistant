// Provider adapters: one normalized chat interface, three backends.
// Tool definitions stay in the OpenAI-style function shape (ollama's `Tool`
// type, produced by defineTool) — each adapter converts to its wire format.
import { Ollama, type Message as OllamaMessage, type Tool } from "ollama";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { tracedChat } from "./tracing/tracedProvider";

export type ThinkLevel = boolean | "low" | "medium" | "high";

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown; // always a parsed object, never a JSON string
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
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
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
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
  tools: Tool[];
  think?: ThinkLevel;
  format?: OutputFormat;
}

export interface ChatProvider {
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage>;
  // Backend label surfaced on LLM spans as llm.provider.
  readonly providerName?: string;
  // True when the provider already emits its own LLM spans (BaseChatProvider
  // subclasses). Prevents double-wrapping by traceProvider().
  readonly traced?: boolean;
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

  constructor(private readonly client: Ollama) {
    super();
  }

  protected async chatInner(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    const ollamaMessages = messages.map((m) => this.toOllama(m));
    // Belt and braces: local Ollama enforces `format` via constrained decoding,
    // but Ollama Cloud silently ignores it (docs: "Ollama's Cloud platform does
    // not currently support structured outputs"), so also instruct the model.
    if (opts.format) {
      ollamaMessages.push({
        role: "system",
        content: `Respond with a single JSON object matching this JSON schema, and nothing else — no markdown, no code fences, no commentary:\n${JSON.stringify(opts.format.schema)}`,
      });
    }
    const res = await this.client.chat({
      model: opts.model,
      messages: ollamaMessages,
      tools: opts.tools,
      think: opts.think,
      format: opts.format?.schema, // ollama constrains decoding to the schema
    });

    const msg = res.message;
    return {
      role: "assistant",
      content: msg.content,
      thinking: msg.thinking,
      toolCalls: msg.tool_calls?.map((c, i) => ({
        id: `call_${i}`, // ollama tool calls carry no id; synthesize one
        name: c.function.name,
        arguments: c.function.arguments,
      })),
      raw: msg,
      usage: {
        promptTokens: res.prompt_eval_count,
        completionTokens: res.eval_count,
        totalTokens: (res.prompt_eval_count ?? 0) + (res.eval_count ?? 0),
      },
    };
  }

  private toOllama(m: ChatMessage): OllamaMessage {
    if (m.role === "assistant" && m.raw) return m.raw as OllamaMessage;
    if (m.role === "tool") return { role: "tool", tool_name: m.toolName, content: m.content };
    return { role: m.role, content: m.content };
  }
}

// ---------------------------------------------------------------------------
// OpenAI (Chat Completions)
// ---------------------------------------------------------------------------

export class OpenAIProvider extends BaseChatProvider {
  readonly providerName = "openai";

  constructor(private readonly client: OpenAI) {
    super();
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
    const res = await this.client.chat.completions.create({
      model: opts.model,
      messages: openaiMessages,
      tools: opts.tools.length
        ? (opts.tools as OpenAI.Chat.Completions.ChatCompletionTool[])
        : undefined,
      // Reasoning models accept an effort hint; a bare `true` uses the default.
      ...(typeof opts.think === "string" ? { reasoning_effort: opts.think } : {}),
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
    });

    const msg = res.choices[0]?.message;
    if (!msg) throw new Error("OpenAI returned no choices");
    return {
      role: "assistant",
      content: msg.content ?? "",
      toolCalls: msg.tool_calls
        ?.filter((c) => c.type === "function")
        .map((c) => ({
          id: c.id,
          name: c.function.name,
          arguments: JSON.parse(c.function.arguments || "{}"),
        })),
      raw: msg,
      usage: {
        promptTokens: res.usage?.prompt_tokens,
        completionTokens: res.usage?.completion_tokens,
        totalTokens: res.usage?.total_tokens,
      },
    };
  }

  private toOpenAI(m: ChatMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
    if (m.role === "assistant" && m.raw) {
      return m.raw as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    return { role: m.role, content: m.content };
  }
}

// ---------------------------------------------------------------------------
// Anthropic (Messages API)
// ---------------------------------------------------------------------------

export class AnthropicProvider extends BaseChatProvider {
  readonly providerName = "anthropic";
  private readonly maxTokens: number;

  constructor(
    private readonly client: Anthropic,
    options?: { maxTokens?: number },
  ) {
    super();
    this.maxTokens = options?.maxTokens ?? 16000;
  }

  protected async chatInner(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const res = await this.client.messages.create({
      model: opts.model,
      max_tokens: this.maxTokens,
      ...(system ? { system } : {}),
      messages: this.toAnthropic(messages),
      tools: opts.tools.map((t) => ({
        name: t.function.name ?? "",
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
    });

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

      out.push({ role: "user", content: m.content });
    }
    return out;
  }
}
