import {
  Agent,
  AgentAbortedError,
  AgentRunError,
  ContentSafetyDetectedError,
  OpenAICompatibleProvider,
  PromptInjectionDetectedError,
  PromptInjectionScreeningError,
  ProviderStalledError,
  defineTool as defineEngineTool,
  isContentSafetyDetectedError,
  isPromptInjectionDetectedError,
  isPromptInjectionScreeningError,
  isScreeningFailure,
  setTraceFilter,
  type AgentLogger,
  type AgentOptions,
  type AgentTool as EngineAgentTool,
  type RunOptions,
  type Screener,
} from "@elicollinson/solenoid-engine";
import {
  ModelArmorScanner,
  authoredText,
  capabilityFor,
  createSecurity,
  currentToolGate,
  resolvePermission,
  resolveScopedPermission,
  withToolGate,
} from "@elicollinson/solenoid-security";
import type { z } from "zod";
import type { PromptTemplate } from "../prompts";
import { log, type LogAttributes } from "./logger";
import { privateSourceContext } from "./privateSourceContext";
import { runGuidanceTurnContext } from "./runGuidance";
import type { AgentTool as LocalAgentTool } from "./tools";

// Wire process-wide OTel span suppression for candidate screenshots so all
// solenoid-engine spans (AGENT, LLM, TOOL, GUARDRAIL) stay silent inside
// privateSourceContext.run(true, ...).
setTraceFilter(() => !privateSourceContext.getStore());

function flattenLogObject(obj: object): LogAttributes {
  const out: LogAttributes = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      v === null
    ) {
      out[k] = v;
    } else if (v !== undefined) {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}

/**
 * Adapter bridging `@elicollinson/solenoid-engine`'s structured `AgentLogger`
 * into `solenoid-assistant`'s logger (carrying `run_id`, `workflow`, etc. from
 * `withLogContext` into `VictoriaLogsSink`) with zero `./logs/` file creation.
 */
export function createEngineLogger(component = "engine"): AgentLogger {
  const child = log.child(component);
  return {
    info(obj: object, msg?: string) {
      child.info(msg ?? component, flattenLogObject(obj));
    },
    warn(obj: object, msg?: string) {
      child.warn(msg ?? component, flattenLogObject(obj));
    },
  };
}

export function isGuardrailDetectedError(
  error: unknown,
): error is PromptInjectionDetectedError | ContentSafetyDetectedError {
  return isPromptInjectionDetectedError(error) || isContentSafetyDetectedError(error);
}

function isZodSchema(value: unknown): value is z.ZodType {
  return (
    value !== null &&
    typeof value === "object" &&
    "safeParse" in value &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

/**
 * Thin `@elicollinson/solenoid-engine` `Agent` subclass for solenoid-assistant
 * workflow agents. Wires the structured logger bridge, `privateSourceContext`
 * trace suppression, ephemeral `runGuidanceTurnContext` (preserving KV-cache
 * prefix stability on `messages[0]`), and `abortOnWriteQuarantine: true` by
 * default, while retaining `PromptTemplate` and `(prompt, schema)` convenience
 * overloads for existing callers.
 */
export interface AssistantAgentOptions extends Omit<AgentOptions, "tools"> {
  tools?: ReadonlyArray<EngineAgentTool<any> | LocalAgentTool<any>>;
}

export class AssistantAgent extends Agent {
  constructor(opts: AssistantAgentOptions) {
    super({
      ...opts,
      tools: opts.tools as EngineAgentTool[] | undefined,
      abortOnWriteQuarantine: opts.abortOnWriteQuarantine ?? true,
      shouldTrace: opts.shouldTrace ?? (() => !privateSourceContext.getStore()),
      turnContext: opts.turnContext ?? runGuidanceTurnContext,
      logger: opts.logger ?? createEngineLogger("engine"),
    });
  }

  override run(prompt: string, options?: RunOptions): Promise<string>;
  override run<S extends z.ZodType>(
    prompt: string,
    schema: S,
    options?: RunOptions,
  ): Promise<z.infer<S>>;
  override run<V>(
    template: PromptTemplate<V>,
    vars: V,
    options?: RunOptions,
  ): Promise<string>;
  override run<V, S extends z.ZodType>(
    template: PromptTemplate<V>,
    vars: V,
    schema: S,
    options?: RunOptions,
  ): Promise<z.infer<S>>;
  override async run(
    promptOrTemplate: string | PromptTemplate<any>,
    second?: unknown,
    third?: unknown,
    fourth?: RunOptions,
  ): Promise<unknown> {
    if (typeof promptOrTemplate === "function") {
      const rendered = promptOrTemplate(second);
      if (isZodSchema(third)) {
        return this.runStructured(rendered, third, fourth);
      }
      return super.run(rendered, third as RunOptions | undefined);
    }
    if (isZodSchema(second)) {
      return this.runStructured(
        promptOrTemplate,
        second,
        third as RunOptions | undefined,
      );
    }
    return super.run(promptOrTemplate, second as RunOptions | undefined);
  }

  runWithSignal(signal: AbortSignal, prompt: string): Promise<string>;
  runWithSignal<S extends z.ZodType>(
    signal: AbortSignal,
    prompt: string,
    schema: S,
  ): Promise<z.infer<S>>;
  runWithSignal<V>(
    signal: AbortSignal,
    template: PromptTemplate<V>,
    vars: V,
  ): Promise<string>;
  runWithSignal<V, S extends z.ZodType>(
    signal: AbortSignal,
    template: PromptTemplate<V>,
    vars: V,
    schema: S,
  ): Promise<z.infer<S>>;
  async runWithSignal(
    signal: AbortSignal,
    promptOrTemplate: string | PromptTemplate<any>,
    second?: unknown,
    third?: unknown,
  ): Promise<unknown> {
    if (typeof promptOrTemplate === "function") {
      const rendered = promptOrTemplate(second);
      if (isZodSchema(third)) {
        return this.runStructured(rendered, third, { signal });
      }
      return super.run(rendered, { signal });
    }
    if (isZodSchema(second)) {
      return this.runStructured(promptOrTemplate, second, { signal });
    }
    return super.run(promptOrTemplate, { signal });
  }
}

export {
  Agent,
  AgentAbortedError,
  AgentRunError,
  ContentSafetyDetectedError,
  ModelArmorScanner,
  OpenAICompatibleProvider,
  PromptInjectionDetectedError,
  PromptInjectionScreeningError,
  ProviderStalledError,
  authoredText,
  capabilityFor,
  createSecurity,
  currentToolGate,
  defineEngineTool,
  isContentSafetyDetectedError,
  isPromptInjectionDetectedError,
  isPromptInjectionScreeningError,
  isScreeningFailure,
  resolvePermission,
  resolveScopedPermission,
  setTraceFilter,
  withToolGate,
  type AgentLogger,
  type AgentOptions,
  type EngineAgentTool,
  type RunOptions,
  type Screener,
};
