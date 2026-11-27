// The agent you talk to, and the only one that stops to ask.
//
// `createChatProfile` is the primary `@elicollinson/solenoid-engine` profile used
// by `SessionCoordinator`: all catalog tool groups compiled through
// `compileToolCatalog` (sticky `open_tool_group`), background subagent spawning
// (`canSpawn: true`) with non-blocking deferred write approvals
// (`subagentApproval: "defer"`), fail-closed write-response quarantine
// (`abortOnWriteQuarantine: true`), byte-immutable `systemPrompt` for KV-cache
// stability, and live ephemeral `today()` injected per turn via `turnContext`.
//
// `ChatAgent` and `createChatAgent` remain exported on top of
// `@elicollinson/solenoid-engine`'s `Agent` so existing callers and unit tests
// (`session.test.ts`, `chat.test.ts`, `pushover.test.ts`, `diagnostics.test.ts`,
// `chatExecution.test.ts`) continue to work cleanly.
import {
  Agent,
  OPEN_TOOL_GROUP,
  defineProfile,
  defineTool as defineEngineTool,
  toolGroupOpener,
  type AgentEvent,
  type AgentOptions,
  type AgentProfile,
  type AgentTool as EngineAgentTool,
  type ChatMessage,
  type ModelRouteChain,
  type Screener,
  type Skill,
  type SkillStore,
  type ToolGroup,
  type ToolSettledInfo,
  type Unlocks,
} from "@elicollinson/solenoid-engine";
import { authoredText, createSecurity } from "@elicollinson/solenoid-security";
import { z } from "zod";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";
import { createEngineLogger } from "../core/engine";
import { privateSourceContext } from "../core/privateSourceContext";
import { createModelRoutes } from "../core/providerFactory";
import { loaderName } from "../core/toolGroups";
import type { AgentTool as LocalAgentTool } from "../core/tools";
import { APP_TZ } from "../db/schema/_shared";
import { DrizzleSkillStore } from "../db/skills";
import { chatSystemPrompt } from "../prompts";
import { createSecurityScreener } from "../safety/modelArmor";
import { compileToolCatalog, type ToolGroupName } from "../tools/groupAdapter";
import { TOOL_GROUP_CATALOG, type ToolGroupContext } from "../tools/groups";
import {
  currentTurn,
  displayArg,
  displayDuration,
  displayName,
} from "../chat/turn";

/**
 * Which calls stop and ask.
 *
 * The default is the whole of the product decision: a write waits for you, a
 * read does not.
 */
export type ApprovalPolicy = (tool: LocalAgentTool | EngineAgentTool) => boolean;

export const APPROVE_WRITES: ApprovalPolicy = (tool) => tool.kind === "write";

export type LegacyPromptInjectionScreener = (
  parts: readonly [string, ...string[]],
) => Promise<{ flagged: boolean; blocked?: boolean }>;

function adaptLegacyScreener(fn: LegacyPromptInjectionScreener): Screener {
  return createSecurity({
    authoredText,
    provider: {
      async assess(parts) {
        const res = await fn(parts);
        const blocked = res.blocked ?? res.flagged;
        return {
          flagged: res.flagged,
          blocked,
          label: res.flagged ? "MALICIOUS" : blocked ? "CONTENT_BLOCKED" : "BENIGN",
          score: res.flagged ? 1 : 0,
        };
      },
    },
  }).screen;
}

/**
 * "Right now it is Friday, 28 August 2026, 15:12 in America/New_York."
 *
 * Minted per turn via `turnContext` rather than baked into `systemPrompt` so
 * `messages[0]` remains byte-immutable across turns for KV-cache prefix reuse
 * while relative dates ("tomorrow", "Thursday") stay accurate on long-lived
 * server processes.
 */
export function today(now = new Date()): string {
  const when = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return (
    `Right now it is ${when} in ${APP_TZ}. Every relative date you are given — ` +
    '"tomorrow", "Thursday", "next week" — is relative to that. When you write a ' +
    "timestamp, write the local time with its offset (2026-08-29T09:00:00-04:00), " +
    "never the same wall clock marked Z — that is four or five hours out."
  );
}

/**
 * What the model is told when a person declines or fails to answer a write gate.
 */
export function declined(tool: string, outcome: "declined" | "expired"): string {
  const what =
    outcome === "declined"
      ? `They said no to ${displayName(tool)}.`
      : `${displayName(tool)} was put to them and they did not answer in time.`;
  return (
    `${what} NOTHING WAS WRITTEN and nothing changed. Do not call it again. ` +
    "Your next message must say plainly that you have not done it — never describe " +
    "the change as though it happened — and, if they declined, ask what they would " +
    "rather you did."
  );
}

export interface CreateChatProfileOptions {
  /** Runtime configuration used when explicit `routes` are not supplied. */
  config?: RuntimeConfig;
  /** Override model route chain directly. */
  routes?: ModelRouteChain;
  /** Subset of catalog groups to expose; defaults to all catalog groups. */
  groups?: readonly ToolGroupName[];
  /** Optional static skills added alongside or instead of the SQLite skill store. */
  skills?: readonly Skill[];
  /** Optional skill store override (defaults to live SQLite `DrizzleSkillStore`). */
  skillStore?: SkillStore;
  /** Override whether subagents can be spawned (defaults to true). */
  canSpawn?: boolean;
  /** Override subagent approval handling (defaults to "defer"). */
  subagentApproval?: AgentProfile["subagentApproval"];
  /** Deferred subagent approval callback wired by `SessionCoordinator`. */
  onSubagentDefer?: AgentProfile["onSubagentDefer"];
  /** Tool settlement callback wired by `SessionCoordinator`. */
  onToolSettled?: AgentProfile["onToolSettled"];
  /** Standing agent permission rules. */
  permissions?: AgentProfile["permissions"];
  /** Explicitly disable injection screening (e.g. offline tests). */
  screening?: boolean;
  /** Override reasoning level. */
  think?: AgentProfile["think"];
  /** Override max model turns per attempt. */
  maxTurns?: number;
  /** Clock provider for deterministic testing of ephemeral `turnContext`. */
  now?: () => Date;
}

/**
 * Build the `solenoid-engine` `AgentProfile` for interactive assistant chat:
 * - Sticky `open_tool_group` compiled from `TOOL_GROUP_CATALOG` via `compileToolCatalog`
 * - Background subagents (`canSpawn: true`) with non-blocking deferred writes (`subagentApproval: "defer"`)
 * - Fail-closed write-tool response quarantine (`abortOnWriteQuarantine: true`)
 * - Byte-immutable `systemPrompt` registered via `defineProfile` + ephemeral `today()` via `turnContext`
 */
export function createChatProfile(
  context: ToolGroupContext,
  options: CreateChatProfileOptions = {},
): AgentProfile {
  const toolGroups = compileToolCatalog(
    context,
    options.groups ? { groups: options.groups } : {},
  );
  const skillStore = options.skillStore ?? new DrizzleSkillStore(context.db);
  const routes =
    options.routes ?? (options.config ? createModelRoutes(options.config) : undefined);
  const nowFn = options.now ?? (() => new Date());

  return defineProfile({
    name: "chat",
    systemPrompt: chatSystemPrompt(),
    toolGroups,
    skillStore,
    ...(options.skills ? { skills: options.skills } : {}),
    canSpawn: options.canSpawn ?? true,
    subagentApproval: options.subagentApproval ?? "defer",
    abortOnWriteQuarantine: true,
    turnContext: () => today(nowFn()),
    shouldTrace: () => !privateSourceContext.getStore(),
    ...(routes ? { routes } : {}),
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(options.screening !== undefined ? { screening: options.screening } : {}),
    ...(options.think !== undefined ? { think: options.think } : {}),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.onSubagentDefer ? { onSubagentDefer: options.onSubagentDefer } : {}),
    ...(options.onToolSettled ? { onToolSettled: options.onToolSettled } : {}),
  });
}

// ---------------------------------------------------------------------------
// Legacy `ChatAgent` compatibility adapter built on `@elicollinson/solenoid-engine`
// ---------------------------------------------------------------------------

function buildLegacyLoaderTool(group: ToolGroup): EngineAgentTool {
  const loader = loaderName(group.name);
  const tool = defineEngineTool({
    name: loader,
    description: `Load schema, tools and instructions for the ${group.name} group: ${group.summary}`,
    kind: "internal",
    schema: z.object({}),
    execute: () => group.briefing,
  });

  const unlocks: Unlocks = {
    tools: group.tools,
    unlocked: (messages) => {
      const answered = new Set(messages.map((m) => m.toolCallId));
      const wasOpened = messages
        .flatMap((m) => m.toolCalls ?? [])
        .some((c) => c.name === loader && answered.has(c.id));
      return wasOpened ? group.tools : [];
    },
  };

  return { ...tool, unlocks } as EngineAgentTool;
}

export interface ChatAgentOptions
  extends Omit<AgentOptions, "tools" | "screen" | "requiresApproval"> {
  context: ToolGroupContext;
  /** Which groups this chat may open. Defaults to every one in the catalog. */
  groups?: readonly string[];
  policy?: ApprovalPolicy;
  screen?: Screener;
  /** Legacy compatibility option accepted by existing chat tests. */
  promptInjectionScreening?: boolean | LegacyPromptInjectionScreener;
}

export class ChatAgent {
  private readonly agent: Agent;
  private readonly policy: ApprovalPolicy;
  private readonly baseSystemPrompt: string;
  private readonly ownerByToolName = new Map<string, string>();
  private readonly groupByLoaderName = new Map<string, string>();
  private readonly toolKindByName = new Map<string, "read" | "write">();

  constructor(options: ChatAgentOptions) {
    const {
      context,
      groups,
      policy,
      screen: explicitScreen,
      promptInjectionScreening,
      systemPrompt,
      ...rest
    } = options;

    this.policy = policy ?? APPROVE_WRITES;
    this.baseSystemPrompt = systemPrompt ?? "";

    const groupNames = (groups ?? Object.keys(TOOL_GROUP_CATALOG)) as readonly ToolGroupName[];
    const compiledGroups = compileToolCatalog(context, { groups: groupNames });

    const startingTools: EngineAgentTool[] = [];
    const opener = toolGroupOpener(compiledGroups);
    if (opener) {
      startingTools.push(opener);
    }

    for (const group of compiledGroups) {
      const loader = loaderName(group.name);
      this.groupByLoaderName.set(loader, group.name);
      startingTools.push(buildLegacyLoaderTool(group));
      for (const tool of group.tools) {
        const name = tool.definition.function.name;
        this.ownerByToolName.set(name, group.name);
        this.toolKindByName.set(name, tool.kind === "write" ? "write" : "read");
      }
    }

    const resolvedScreen =
      explicitScreen !== undefined
        ? explicitScreen
        : promptInjectionScreening === false
          ? undefined
          : typeof promptInjectionScreening === "function"
            ? adaptLegacyScreener(promptInjectionScreening)
            : createSecurityScreener(loadRuntimeConfig());

    this.agent = new Agent({
      ...rest,
      name: rest.name ?? "chat",
      systemPrompt: this.baseSystemPrompt || undefined,
      tools: startingTools,
      screen: resolvedScreen,
      abortOnWriteQuarantine: rest.abortOnWriteQuarantine ?? true,
      shouldTrace: rest.shouldTrace ?? (() => !privateSourceContext.getStore()),
      requiresApproval: (tool) => this.policy(tool),
      logger: rest.logger ?? createEngineLogger("chat"),
    });
  }

  addTool(tool: LocalAgentTool | EngineAgentTool): this {
    const engineTool: EngineAgentTool = {
      kind: tool.kind,
      schema: tool.schema,
      definition: tool.definition,
      execute: (args, ctx) => tool.execute(args as never, ctx),
      ...("component" in tool && tool.component ? { component: tool.component } : {}),
      ...("unlocks" in tool && tool.unlocks ? { unlocks: tool.unlocks } : {}),
    };
    this.agent.addTool(engineTool);
    this.toolKindByName.set(
      tool.definition.function.name,
      tool.kind === "write" ? "write" : "read",
    );
    return this;
  }

  runMessages(messages: ChatMessage[]): Promise<string>;
  runMessages<S extends z.ZodType>(messages: ChatMessage[], schema: S): Promise<z.infer<S>>;
  async runMessages(messages: ChatMessage[], schema?: z.ZodType): Promise<unknown> {
    const turn = currentTurn();
    const datedSystem = this.baseSystemPrompt
      ? `${this.baseSystemPrompt}\n\n${today()}`
      : today();
    const hasSystem = messages.some((m) => m.role === "system");
    const withSystem: ChatMessage[] = hasSystem
      ? messages
      : [{ role: "system", content: datedSystem }, ...messages];

    const argsByCallId = new Map<string, unknown>();
    const gatedByCallId = new Map<string, string>();

    const onEvent = (event: AgentEvent) => {
      if (!turn) return;
      if (event.type === "assistant_turn") {
        const body = event.message.content.trim();
        if (body && event.message.toolCalls?.length) {
          turn.emit({ type: "say", body });
        }
        return;
      }
      if (event.type === "tool_start") {
        argsByCallId.set(event.id, event.args);
        return;
      }
      if (event.type === "tool_end") {
        const rawArgs = argsByCallId.get(event.id);
        argsByCallId.delete(event.id);
        if (event.name === OPEN_TOOL_GROUP) {
          const group =
            rawArgs && typeof rawArgs === "object"
              ? (rawArgs as { group?: unknown }).group
              : undefined;
          if (typeof group === "string" && group.trim()) {
            turn.emit({ type: "opened", group: group.trim() });
          }
          return;
        }
        const loaderGroup = this.groupByLoaderName.get(event.name);
        if (loaderGroup) {
          turn.emit({ type: "opened", group: loaderGroup });
          return;
        }
        if (event.declined) return;

        const kind = this.toolKindByName.get(event.name) ?? "read";
        const responseQuarantined = Boolean(event.quarantined && kind === "write");
        turn.emit({
          type: "tool",
          name: displayName(event.name),
          kind,
          arg: displayArg(rawArgs),
          duration: displayDuration(event.durationMs),
          ok: responseQuarantined ? true : event.ok,
          ...(responseQuarantined ? { responseQuarantined: true } : {}),
        });
      }
    };

    const approve = turn
      ? async (request: {
          tool: string;
          toolCallId: string;
          args: unknown;
          description: string;
          signal: AbortSignal;
        }) => {
          const decision = await turn.decide({
            tool: request.tool,
            args: request.args,
            group: this.ownerByToolName.get(request.tool) ?? request.tool,
            description: request.description,
            signal: request.signal,
          });
          if (decision.outcome !== "approved") {
            return { allow: false as const, tell: declined(request.tool, decision.outcome) };
          }
          gatedByCallId.set(request.toolCallId, decision.decisionId);
          return { allow: true as const };
        }
      : undefined;

    const onToolSettled = turn
      ? (info: ToolSettledInfo) => {
          const decisionId = gatedByCallId.get(info.toolCallId);
          if (!decisionId) return;
          gatedByCallId.delete(info.toolCallId);
          if (info.outcome.declined) return;

          const called = displayName(info.tool);
          if (info.responseQuarantined || info.outcome.quarantined) {
            turn.settled(decisionId, null, called, "response_quarantined");
            return;
          }
          turn.settled(
            decisionId,
            info.outcome.ok ? null : (info.outcome.error ?? info.outcome.output),
            called,
          );
        }
      : undefined;

    const result = schema
      ? await this.agent.runMessages(withSystem, {
          schema,
          onEvent,
          ...(approve ? { approve } : {}),
          ...(onToolSettled ? { onToolSettled } : {}),
        })
      : await this.agent.runMessages(withSystem, {
          onEvent,
          ...(approve ? { approve } : {}),
          ...(onToolSettled ? { onToolSettled } : {}),
        });

    return result.output;
  }
}

/**
 * Build the legacy `ChatAgent` singleton adapter.
 * New coordinator-backed sessions use `createChatProfile` directly.
 */
export function createChatAgent(
  context: ToolGroupContext,
  options: { config?: RuntimeConfig; groups?: readonly string[] } = {},
): ChatAgent {
  const config = options.config ?? loadRuntimeConfig();
  return new ChatAgent({
    name: "chat",
    routes: createModelRoutes(config),
    systemPrompt: chatSystemPrompt(),
    context,
    ...(options.groups ? { groups: options.groups } : {}),
  });
}
