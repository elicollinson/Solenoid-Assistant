// LLM span logic for chat providers. `tracedChat` is the shared
// implementation used by BaseChatProvider (providers.ts), keeping all
// OTel/OpenInference specifics inside the tracing module. TracedChatProvider
// is a safety-net decorator for custom ChatProvider implementations that
// don't extend BaseChatProvider.
import type { ChatMessage, ChatOptions, ChatProvider } from "../providers";
import {
  SemanticConventions,
  inputMessageAttributes,
  llmRequestAttributes,
  outputMessageAttributes,
  safeJson,
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
      [SemanticConventions.INPUT_VALUE]: safeJson(messages),
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

// Idempotent: providers that already trace their own chat calls (anything
// extending BaseChatProvider, or an existing TracedChatProvider) pass through
// unchanged, so double-wrapping is impossible.
export function traceProvider(p: ChatProvider): ChatProvider {
  return p.traced ? p : new TracedChatProvider(p);
}
