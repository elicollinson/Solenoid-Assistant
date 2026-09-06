// The agent you talk to, and the only one that stops to ask.
//
// Every other agent in this directory is given the handful of tools its job
// needs. This one is given all ten groups at full trust and told to fetch what
// it needs, which is the whole argument of ../core/toolGroups.ts: sixty-odd
// tool definitions would not fit in a conversation's context, ten loaders do,
// and a chat cannot know in advance which of them a sentence will turn out to
// need.
//
// Full trust with a gate in front of it, rather than `read_only`. The read-only
// form exists for an agent whose context holds a stranger's text and which must
// not be able to write at all — see ../tools/groups.ts. A chat is the opposite
// case: the person typing IS the principal, so there is no privilege here for
// an injection to escalate to, and the answer to "should this write happen" is
// one they are present to give. So it can write, and it asks first.
//
// What it reads is a different question, and the gate does not cover it: a
// message this agent reads out of iMessage was written by somebody else, and
// ../core/rawAgent.ts screens every tool result for injection whether or not
// this file is involved.
import { Agent, type AgentOptions, type ToolOutcome } from "../core/rawAgent";
import type { ChatMessage } from "../core/providers";
import type { z } from "zod";
import { loaderName, type ToolSession } from "../core/toolGroups";
import type { AgentTool } from "../core/tools";
import { createModelRoutes } from "../core/providerFactory";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";
import { chatSystemPrompt } from "../prompts";
import { APP_TZ } from "../db/schema/_shared";
import { TOOL_GROUP_CATALOG, buildToolGroups, type ToolGroupContext } from "../tools/groups";
import {
  currentTurn,
  displayArg,
  displayDuration,
  displayName,
  type ChatTurn,
} from "../chat/turn";

/**
 * Which calls stop and ask.
 *
 * The default is the whole of the product decision: a write waits for you, a
 * read does not. It is a function rather than a constant so that a permission
 * layer can narrow or widen it later without this class learning what a
 * permission is — the read/write classification on every tool is what that
 * layer will be built on, and it already exists.
 */
export type ApprovalPolicy = (tool: AgentTool) => boolean;

export const APPROVE_WRITES: ApprovalPolicy = (tool) => tool.kind === "write";

export interface ChatAgentOptions extends Omit<AgentOptions, "toolGroups" | "tools"> {
  context: ToolGroupContext;
  /** Which groups this chat may open. Defaults to every one in the catalog. */
  groups?: readonly string[];
  policy?: ApprovalPolicy;
}

export class ChatAgent extends Agent {
  private readonly policy: ApprovalPolicy;

  constructor(options: ChatAgentOptions) {
    const { context, groups, policy, ...rest } = options;
    super({
      ...rest,
      // Full, deliberately. See the header.
      toolGroups: buildToolGroups(context, groups ?? Object.keys(TOOL_GROUP_CATALOG), {
        trust: "full",
      }),
    });
    this.policy = policy ?? APPROVE_WRITES;
  }

  /**
   * The gate, and the only override this class needs.
   *
   * Here rather than in `loop` because this is where a call has been resolved
   * to a tool and therefore to a `kind`. Doing it a level up would mean
   * re-deriving read-or-write from a name, and ../core/toolGroups.ts documents
   * why a name cannot be trusted to say which group it came from, let alone
   * what it does.
   */
  protected override async invokeTool(
    name: string,
    rawArgs: unknown,
    signal: AbortSignal | undefined,
    session: ToolSession,
  ): Promise<ToolOutcome> {
    const turn = currentTurn();
    const tool = this.tools.get(name) ?? session.resolve(name);

    // Not in a chat, or a name that resolves to nothing. Either way there is
    // nobody to ask and nothing to report: hand it back to the base class,
    // which has the right words for an unopened group and an unknown tool.
    if (!turn || !tool) return super.invokeTool(name, rawArgs, signal, session);

    let gated: string | undefined;
    if (this.policy(tool)) {
      const decision = await turn.decide({
        tool: name,
        args: rawArgs,
        group: session.ownerOf(name) ?? name,
        description: tool.definition.function.description,
        ...(signal ? { signal } : {}),
      });
      // Refused, and the model is told so in a sentence rather than by an
      // exception — but it is not a failed call, because no call was made.
      if (decision.outcome !== "approved") {
        return { ok: true, output: declined(name, decision.outcome) };
      }
      gated = decision.decisionId;
    }

    const started = performance.now();
    const result = await super.invokeTool(name, rawArgs, signal, session);
    this.report(turn, name, rawArgs, tool, result, performance.now() - started, session);
    // The second sentence of the approval's outcome line. Only now is it true:
    // until this point the only honest thing to write was which button was
    // pressed. See `noteApprovalOutcome` in ../db/mutations/chat.ts.
    if (gated) {
      turn.settled(gated, result.ok ? null : result.output, displayName(name));
    }
    return result;
  }

  /**
   * The standing prompt, plus what today is.
   *
   * The date has to be minted per run and cannot live in the prompt the
   * constructor was handed: this agent is a module-level singleton on a server
   * that stays up for weeks, so a date baked in at construction is wrong by the
   * next morning and confidently wrong thereafter. A live run produced
   * `dueAt: 2025-05-15` for "tomorrow" before this existed.
   *
   * Prepended as a system message rather than appended to the transcript,
   * because ../core/rawAgent.ts injects `systemPrompt` only when the caller
   * supplied no system message — so supplying one here is also what stops it
   * adding a second, undated copy.
   */
  override runMessages(messages: ChatMessage[]): Promise<string>;
  override runMessages<S extends z.ZodType>(messages: ChatMessage[], schema: S): Promise<z.infer<S>>;
  override async runMessages(messages: ChatMessage[], schema?: z.ZodType): Promise<unknown> {
    const dated = { role: "system" as const, content: `${this.systemPrompt}\n\n${today()}` };
    return schema
      ? super.runMessages([dated, ...messages], schema)
      : super.runMessages([dated, ...messages]);
  }

  /**
   * The sentence before the act.
   *
   * Only when the turn also called something: a turn that is only prose IS the
   * answer, and it reaches the screen as `message` once it is written down.
   * Emitting both would draw it twice.
   */
  protected override onAssistantTurn(message: ChatMessage): void {
    const body = message.content.trim();
    if (body && message.toolCalls?.length) currentTurn()?.emit({ type: "say", body });
  }

  /**
   * Tell the screen what just ran.
   *
   * `ok` comes off the outcome rather than off its wording: `invokeTool`
   * catches a failing tool and hands the model the error rather than throwing,
   * which is right for the model and would otherwise leave the transcript
   * drawing a failed call as a clean one.
   */
  private report(
    turn: ChatTurn,
    name: string,
    rawArgs: unknown,
    tool: AgentTool,
    result: ToolOutcome,
    elapsedMs: number,
    session: ToolSession,
  ): void {
    // A group's loader answers to the group's own name, so this is how one is
    // told apart from a member of the group it opens. Drawing "10 tool calls ·
    // get_okf_tools, get_photos_tools, …" would bury the two that did work.
    const group = session.ownerOf(name);
    if (group && name === loaderName(group)) {
      turn.emit({ type: "opened", group });
      return;
    }
    turn.emit({
      type: "tool",
      name: displayName(name),
      kind: tool.kind,
      arg: displayArg(rawArgs),
      duration: displayDuration(elapsedMs),
      ok: result.ok,
    });
  }
}

/**
 * "Today is Friday, 28 August 2026, 15:12 in America/New_York."
 *
 * Spelled out rather than given as an ISO instant: a model asked to turn
 * "tomorrow at ten" into a timestamp has to know the weekday as well as the
 * date, and reads a written date more reliably than an offset it has to
 * subtract from.
 */
function today(now = new Date()): string {
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
  return `Right now it is ${when} in ${APP_TZ}. Every relative date you are given — ` +
    "\"tomorrow\", \"Thursday\", \"next week\" — is relative to that. When you write a " +
    "timestamp, write the local time with its offset (2026-08-29T09:00:00-04:00), " +
    "never the same wall clock marked Z — that is four or five hours out.";
}

/**
 * What the model is told when a person says no.
 *
 * Returned rather than thrown, like every other tool failure: a refused write
 * is an ordinary turn of the conversation, and the useful next move is for the
 * agent to say what it was going to do and ask what to do instead.
 *
 * "Do not retry" is there because without it a capable model treats a refusal
 * as a transient failure and calls the same tool again with the same arguments,
 * which puts the person back in front of the same question they just answered.
 */
function declined(tool: string, outcome: "declined" | "expired"): string {
  const what = outcome === "declined"
    ? `They said no to ${displayName(tool)}.`
    : `${displayName(tool)} was put to them and they did not answer in time.`;
  // "Say what you were about to do" was the first wording, and a small model
  // read it as licence to restate the intent — it answered a refused write with
  // "I'll add a reminder to water the plants", which is the one sentence that
  // must not follow a decline. Say what the next message may NOT claim.
  return `${what} NOTHING WAS WRITTEN and nothing changed. Do not call it again. ` +
    "Your next message must say plainly that you have not done it — never describe " +
    "the change as though it happened — and, if they declined, ask what they would " +
    "rather you did.";
}

/**
 * The chat agent this service talks through.
 *
 * A singleton, like every other agent here, and safe as one for the reason
 * ../core/rawAgent.ts mints a ToolSession per attempt: what a run opens belongs
 * to that run, so two conversations cannot leak groups into each other.
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
