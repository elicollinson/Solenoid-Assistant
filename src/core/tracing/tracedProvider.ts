// LLM span logic for chat providers.
import type { ChatMessage, ChatOptions, ChatProvider } from "../providers";
import {
  SemanticConventions,
  inputMessageAttributes,
  llmRequestAttributes,
  outputMessageAttributes,
  safeMessagesJson,
  withSpanKind,
} from "./spans";

export function tracedChat(
  providerName: string,
  messages: ChatMessage[],
  opts: ChatOptions,
  inner: () => Promise<ChatMessage>,
): Promise<ChatMessage> {
  return withSpanKind(
    "LLM",
    `chat ${opts.model}`,
    {
      ...llmRequestAttributes(opts, providerName),
      ...inputMessageAttributes(messages),
      [SemanticConventions.INPUT_VALUE]: safeMessagesJson(messages),
      [SemanticConventions.INPUT_MIME_TYPE]: "application/json",
    },
    async (span) => {
      const msg = await inner();
      span.setAttributes({
        ...outputMessageAttributes(msg),
        [SemanticConventions.OUTPUT_VALUE]: msg.content,
        ...(msg.usage?.promptTokens != null
          ? { [SemanticConventions.LLM_TOKEN_COUNT_PROMPT]: msg.usage.promptTokens }
          : {}),
        ...(msg.usage?.completionTokens != null
          ? { [SemanticConventions.LLM_TOKEN_COUNT_COMPLETION]: msg.usage.completionTokens }
          : {}),
        ...(msg.usage?.totalTokens != null
          ? { [SemanticConventions.LLM_TOKEN_COUNT_TOTAL]: msg.usage.totalTokens }
          : {}),
        ...(msg.finishReason ? { "llm.finish_reason": msg.finishReason } : {}),
      });
      return msg;
    },
  );
}

export class TracedChatProvider implements ChatProvider {
  readonly traced = true;
  readonly providerName: string;

  constructor(private readonly inner: ChatProvider) {
    this.providerName = inner.providerName ?? inner.constructor.name;
  }

  chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    return tracedChat(this.providerName, messages, opts, () => this.inner.chat(messages, opts));
  }
}

export function traceProvider(p: ChatProvider): ChatProvider {
  return "traced" in p && (p as { traced?: boolean }).traced ? p : new TracedChatProvider(p);
}
