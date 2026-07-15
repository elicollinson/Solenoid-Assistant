// Generic OpenInference span helpers. `withSpanKind` is the single primitive
// every traced seam builds on — adding a new span kind (RETRIEVER, GUARDRAIL,
// EVALUATOR, ...) needs no new plumbing, just a different `kind` argument.
import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { Attributes, Span } from "@opentelemetry/api";
import {
  OpenInferenceSpanKind,
  SemanticConventions,
} from "@arizeai/openinference-semantic-conventions";
import type { ChatMessage, ChatOptions } from "../providers";

export type SpanKind = keyof typeof OpenInferenceSpanKind;
export type { Attributes, Span };
export { SemanticConventions, SpanStatusCode };

const tracer = () => trace.getTracer("solenoid-assistant");

export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

// Run `fn` inside an active span of the given OpenInference kind. The span is
// set as the active context (AsyncLocalStorage), so nested spans and log
// events attach to it automatically. Errors are recorded and rethrown.
export async function withSpanKind<T>(
  kind: SpanKind,
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(
    name,
    {
      attributes: {
        [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind[kind],
        ...attributes,
      },
    },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

// --- LLM attribute builders (flattened per the OpenInference spec) ----------

function messageAttributes(prefix: string, m: ChatMessage): Attributes {
  const attrs: Attributes = {
    [`${prefix}.${SemanticConventions.MESSAGE_ROLE}`]: m.role,
    [`${prefix}.${SemanticConventions.MESSAGE_CONTENT}`]: m.content,
  };
  m.toolCalls?.forEach((c, j) => {
    const t = `${prefix}.${SemanticConventions.MESSAGE_TOOL_CALLS}.${j}`;
    attrs[`${t}.${SemanticConventions.TOOL_CALL_ID}`] = c.id;
    attrs[`${t}.${SemanticConventions.TOOL_CALL_FUNCTION_NAME}`] = c.name;
    attrs[`${t}.${SemanticConventions.TOOL_CALL_FUNCTION_ARGUMENTS_JSON}`] = safeJson(c.arguments);
  });
  return attrs;
}

export function inputMessageAttributes(messages: ChatMessage[]): Attributes {
  const attrs: Attributes = {};
  messages.forEach((m, i) => {
    Object.assign(attrs, messageAttributes(`${SemanticConventions.LLM_INPUT_MESSAGES}.${i}`, m));
  });
  return attrs;
}

export function outputMessageAttributes(msg: ChatMessage): Attributes {
  return messageAttributes(`${SemanticConventions.LLM_OUTPUT_MESSAGES}.0`, msg);
}

export function llmRequestAttributes(opts: ChatOptions, providerName: string): Attributes {
  const attrs: Attributes = {
    [SemanticConventions.LLM_MODEL_NAME]: opts.model,
    [SemanticConventions.LLM_PROVIDER]: providerName,
    [SemanticConventions.LLM_INVOCATION_PARAMETERS]: safeJson({
      think: opts.think,
      format: opts.format?.name,
    }),
  };
  opts.tools.forEach((t, i) => {
    attrs[`${SemanticConventions.LLM_TOOLS}.${i}.tool.json_schema`] = safeJson(t);
  });
  return attrs;
}
