// Surface 6 — Background Subagent Auto-Turns, Non-Blocking Subagent `defer` End-to-End,
// Live Permission Narrowing Before Click, Read-Only Subagents, and Monotonic Attenuation.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  AppSettingsSchema,
  createHarness,
  defineTool,
  defineToolGroup,
  type AgentProfile,
  type AgentTool,
  type ChatMessage,
  type ChatOptions,
  type ChatProvider,
  type ToolGroup,
} from "@elicollinson/solenoid-engine";
import { AlreadySettledError } from "@elicollinson/solenoid-security";
import { createDb, runMigrations, ulid, type Db } from "../db";
import * as s from "../db/schema";
import { DrizzleCheckpointStore } from "../db/chatCheckpoints";
import { NoSuchDecisionError, startConversation } from "../db/mutations/chat";
import { loadChat } from "../db/queries/chat";
import { loadHome } from "../db/queries/home";
import type { ChatEvent } from "../shared/chat";
import { SessionCoordinator } from "./coordinator";

type ScriptStep =
  | ChatMessage
  | Error
  | ((messages: ChatMessage[], opts: ChatOptions) => ChatMessage | Promise<ChatMessage>);

/**
 * Deterministic provider separating parent vs child subagent calls by inspecting
 * whether `spawn_subagent` is offered (depth is strictly 1, so only parent holds it).
 */
class RoleRoutedProvider implements ChatProvider {
  readonly providerName = "scripted";
  readonly parentCalls: ChatMessage[][] = [];
  readonly childCalls: ChatMessage[][] = [];
  readonly childOffered: string[][] = [];

  constructor(
    private readonly parentSteps: ScriptStep[],
    private readonly childSteps: ScriptStep[],
  ) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    const toolNames = opts.tools.map((t) => t.function.name);
    const isParent = toolNames.includes("spawn_subagent");
    if (isParent) {
      this.parentCalls.push(messages.map((m) => ({ ...m })));
    } else {
      this.childCalls.push(messages.map((m) => ({ ...m })));
      this.childOffered.push(toolNames);
    }
    const queue = isParent ? this.parentSteps : this.childSteps;
    const step = queue.shift();
    if (!step) {
      throw new Error(
        `RoleRoutedProvider (${isParent ? "parent" : "child"}) exhausted (offered: ${toolNames.join(", ")})`,
      );
    }
    if (step instanceof Error) throw step;
    const msg = typeof step === "function" ? await step(messages, opts) : step;
    if (msg.content) opts.onDelta?.({ type: "text", text: msg.content });
    return msg;
  }
}

const say = (content: string): ChatMessage => ({ role: "assistant", content });
const call = (name: string, args: unknown, id = `call_${name}`, content = ""): ChatMessage => ({
  role: "assistant",
  content,
  toolCalls: [{ id, name, arguments: args }],
});

class EventCollector {
  readonly events: ChatEvent[] = [];
  private readonly waiters: Array<{
    predicate: (event: ChatEvent) => boolean;
    resolve: (event: ChatEvent) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  readonly listener = (event: ChatEvent): void => {
    this.events.push(event);
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i]!;
      if (waiter.predicate(event)) {
        clearTimeout(waiter.timer);
        this.waiters.splice(i, 1);
        waiter.resolve(event);
      }
    }
  };

  waitFor<T extends ChatEvent = ChatEvent>(
    predicate: (event: ChatEvent) => event is T,
    timeoutMs?: number,
    fromIndex?: number,
  ): Promise<T>;
  waitFor(
    predicate: (event: ChatEvent) => boolean,
    timeoutMs?: number,
    fromIndex?: number,
  ): Promise<ChatEvent>;
  waitFor(
    predicate: (event: ChatEvent) => boolean,
    timeoutMs = 2_000,
    fromIndex = 0,
  ): Promise<ChatEvent> {
    const existing = this.events.slice(fromIndex).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<ChatEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for ChatEvent (saw: ${this.events.map((e) => e.type).join(", ")})`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }
}

let dir: string;
let db: Db;
let activeCoordinators: SessionCoordinator[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chat-subagent-defer-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  activeCoordinators = [];
});

afterEach(async () => {
  for (const coordinator of activeCoordinators) {
    try {
      await coordinator.close();
    } catch {
      // Ignore cleanup errors during Wave 1 stub red phase.
    }
  }
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

function buildRemindersGroup(counter: { reads: number; writes: number; titles: string[] }): {
  group: ToolGroup;
  tools: AgentTool[];
} {
  const remindersList = defineTool({
    name: "reminders_list",
    kind: "read",
    description: "List existing reminders.",
    schema: z.object({}),
    execute: () => {
      counter.reads++;
      return { reminders: counter.titles.map((title, idx) => ({ id: `rem-${idx + 1}`, title })) };
    },
  });

  const remindersCreate = defineTool({
    name: "reminders_create",
    kind: "write",
    description: "Create a reminder with a title.",
    schema: z.object({ title: z.string() }),
    execute: ({ title }) => {
      counter.writes++;
      counter.titles.push(title);
      return { id: `rem-${counter.writes}`, title };
    },
  });

  const group = defineToolGroup({
    name: "reminders",
    summary: "Read and create personal reminders.",
    briefing: "Manage the user's reminder list carefully.",
    tools: [remindersList, remindersCreate],
  });

  return { group, tools: [remindersList, remindersCreate] };
}

async function setupChatSubagents(options: {
  provider: ChatProvider;
  toolGroups: ToolGroup[];
  extraTools?: AgentTool[];
  resolveTools: AgentTool[];
}) {
  const store = new DrizzleCheckpointStore(db);
  const settings = AppSettingsSchema.parse({
    screening: { enabled: false },
    checkpoints: { enabled: true },
    device: { id: "server-1", name: "solenoid-server" },
  });
  const harness = await createHarness(settings, {
    checkpointStore: store,
    routes: [{ client: options.provider, model: "scripted" }],
    screener: null,
    baseTools: [],
  });

  const toolsByName = new Map(options.resolveTools.map((t) => [t.definition.function.name, t]));
  const profileFactory = (): AgentProfile => ({
    name: "chat",
    toolGroups: options.toolGroups,
    ...(options.extraTools ? { tools: options.extraTools } : {}),
    canSpawn: true,
    subagentApproval: "defer",
    routes: [{ client: options.provider, model: "scripted" }],
    screening: false,
  });

  const coordinator = new SessionCoordinator({
    db,
    harness,
    profileFactory,
    resolveTool: async (name) => toolsByName.get(name),
  });
  activeCoordinators.push(coordinator);
  return { coordinator, store, harness };
}

// ---------------------------------------------------------------------------
// 1. Background Subagent + Async onAutoTurn Synthesis
// ---------------------------------------------------------------------------

describe("background subagent onAutoTurn", () => {
  test("parent ends its turn immediately while subagent runs, then broadcasts and persists async synthesis turn", async () => {
    const conversationId = startConversation(db);
    const counter = { reads: 0, writes: 0, titles: ["Call dentist"] };
    const { group, tools } = buildRemindersGroup(counter);

    const childGate = Promise.withResolvers<void>();
    const provider = new RoleRoutedProvider(
      [
        call(
          "spawn_subagent",
          { name: "researcher", task: "Check reminders and summarize", tools: ["reminders_list"] },
          "tc-spawn-1",
        ),
        say("I've dispatched a researcher in the background."),
        // Triggered asynchronously via Session.onAutoTurn once the child finishes
        say("The researcher checked your list: Call dentist is pending."),
      ],
      [
        async () => {
          await childGate.promise;
          return call("reminders_list", {}, "tc-child-list");
        },
        say("Found 1 reminder: Call dentist."),
      ],
    );

    const { coordinator } = await setupChatSubagents({
      provider,
      toolGroups: [group],
      resolveTools: tools,
    });

    const collector = new EventCollector();
    const unsubscribe = coordinator.subscribe(conversationId, collector.listener);

    await coordinator.send(conversationId, "Check my reminders in the background");

    // Parent turn MUST complete while the subagent is still gated.
    const parentMsg = await collector.waitFor(
      (e): e is Extract<ChatEvent, { type: "message" }> =>
        e.type === "message" && e.body === "I've dispatched a researcher in the background.",
    );
    expect(parentMsg.body).toBe("I've dispatched a researcher in the background.");
    expect(counter.reads).toBe(0);

    // Release background child -> finishes -> triggers onAutoTurn through SessionCoordinator.
    childGate.resolve();

    const synthesisMsg = await collector.waitFor(
      (e): e is Extract<ChatEvent, { type: "message" }> =>
        e.type === "message" && e.body.includes("Call dentist is pending"),
    );
    expect(synthesisMsg.source).toBe("subagent");
    expect(counter.reads).toBe(1);

    // Synthesis turn is persisted in the checkpoint and hydrated by loadChat().
    const chat = loadChat(db, conversationId);
    const persistedSynthesis = chat.turns.find((t) => t.body.includes("Call dentist is pending"));
    expect(persistedSynthesis).toBeDefined();
    expect(persistedSynthesis?.by).toBe("agent");
    expect(persistedSynthesis?.source).toBe("subagent");

    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// 2. Subagent `defer` End-to-End
// ---------------------------------------------------------------------------

describe("subagent defer end-to-end", () => {
  test("defers write non-blockingly into decisions/actions/activity_items, emits deferred_approval, executes once on Go ahead, and records settlement into parent checkpoint", async () => {
    const conversationId = startConversation(db);
    const counter = { reads: 0, writes: 0, titles: [] as string[] };
    const { group, tools } = buildRemindersGroup(counter);

    const provider = new RoleRoutedProvider(
      [
        // Turn 1: parent spawns helper with read + write tools and ends its turn immediately
        call(
          "spawn_subagent",
          {
            name: "planner",
            task: "Check existing reminders and add one to buy milk",
            tools: ["reminders_list", "reminders_create"],
          },
          "tc-spawn-planner",
        ),
        say("I've asked planner to check and prepare the milk reminder."),
        // Async onAutoTurn once planner finishes
        say("Planner checked your list and left 'Buy milk' waiting for your approval."),
        // Turn 2 (after user approves deferred write): parent inspects updated transcript
        say("Yes — the 'Buy milk' reminder was created."),
      ],
      [
        // Child reads first, then attempts write under standing rule `ask` -> defers!
        call("reminders_list", {}, "tc-c-list"),
        call("reminders_create", { title: "Buy milk" }, "tc-c-create"),
        // Child continues remaining work and reports back without blocking!
        say("Checked reminders; 'Buy milk' is deferred for user approval."),
      ],
    );

    const { coordinator, store } = await setupChatSubagents({
      provider,
      toolGroups: [group],
      resolveTools: tools,
    });

    const collector = new EventCollector();
    const unsubscribe = coordinator.subscribe(conversationId, collector.listener);

    await coordinator.send(conversationId, "Check reminders and add Buy milk via a helper");

    // Parent ends its turn, child defers `reminders_create`, finishes, and triggers auto-turn.
    const deferredEvent = await collector.waitFor(
      (e): e is Extract<ChatEvent, { type: "deferred_approval" }> => e.type === "deferred_approval",
    );
    await collector.waitFor(
      (e) => e.type === "message" && e.body.includes("waiting for your approval"),
    );

    // Before click: write has NOT run yet!
    expect(counter.reads).toBe(1);
    expect(counter.writes).toBe(0);
    expect(deferredEvent).toMatchObject({
      type: "deferred_approval",
      tool: "reminders.create",
      subagentName: "planner",
    });

    // SQLite relational persistence: `decisions`, `actions` (`tool_call`), and `activity_items`.
    const decisionBefore = db
      .select()
      .from(s.decisions)
      .where(eq(s.decisions.id, deferredEvent.decisionId))
      .get();
    expect(decisionBefore).toMatchObject({
      id: deferredEvent.decisionId,
      subjectId: conversationId,
      state: "open",
      blocking: false,
    });

    const approveAction = deferredEvent.actions.find((a) => a.stance === "affirm")!;
    expect(approveAction).toBeDefined();
    expect(approveAction.label).toBe("Go ahead");

    const actionRow = db.select().from(s.actions).where(eq(s.actions.id, approveAction.id)).get();
    expect(actionRow?.decisionId).toBe(deferredEvent.decisionId);
    expect(actionRow?.effectKind).toBe("tool_call");

    const feedItem = db
      .select()
      .from(s.activityItems)
      .where(eq(s.activityItems.decisionId, deferredEvent.decisionId))
      .get();
    expect(feedItem).toBeDefined();
    expect(feedItem?.state).toBe("attention");

    // Both loadChat() and loadHome() expose the waiting deferred approval.
    expect(loadChat(db, conversationId).waiting).toBe(1);
    expect(loadHome(db).aside.waiting.some((w) => w.id === deferredEvent.decisionId)).toBe(true);

    // User clicks "Go ahead" -> recheckAndAuthorize() executes `reminders_create` ONCE!
    const result = await coordinator.answerDecision(approveAction.id);
    expect(result).toMatchObject({
      decisionId: deferredEvent.decisionId,
      outcome: "approved",
      deferred: true,
    });
    expect(counter.writes).toBe(1);
    expect(counter.titles).toEqual(["Buy milk"]);

    // Double-click safety on deferred approval: second click rejects and never re-executes!
    const dupErr = await coordinator.answerDecision(approveAction.id).catch((e: unknown) => e);
    expect(dupErr instanceof AlreadySettledError || dupErr instanceof NoSuchDecisionError).toBe(true);
    expect(counter.writes).toBe(1);

    // Relational decision settled & waiting count cleared.
    const decisionAfter = db
      .select()
      .from(s.decisions)
      .where(eq(s.decisions.id, deferredEvent.decisionId))
      .get();
    expect(decisionAfter?.state).toBe("resolved");
    expect(loadChat(db, conversationId).waiting).toBe(0);

    // Settlement note was appended into the parent Session checkpoint so the next typed turn sees it!
    const cpAfterApprove = await store.load(conversationId);
    expect(cpAfterApprove).toBeDefined();
    const cpTranscriptText = cpAfterApprove!.checkpoint.transcript.map((m) => m.content).join("\n");
    expect(cpTranscriptText.toLowerCase()).toMatch(/reminders[._]create|buy milk/);

    // Next typed user turn sees the settlement note in the transcript passed to the model!
    await coordinator.send(conversationId, "Did the Buy milk reminder get added?");
    await collector.waitFor(
      (e) => e.type === "message" && e.body === "Yes — the 'Buy milk' reminder was created.",
    );
    const turn2Prompt = provider.parentCalls.at(-1)!.map((m) => m.content).join("\n");
    expect(turn2Prompt.toLowerCase()).toMatch(/reminders[._]create|buy milk/);

    unsubscribe();
  });

  test("permission narrowed to deny between subagent defer and user click refuses execution (0 tool runs) and records refusal reason", async () => {
    const conversationId = startConversation(db);
    const counter = { reads: 0, writes: 0, titles: [] as string[] };
    const { group, tools } = buildRemindersGroup(counter);

    const provider = new RoleRoutedProvider(
      [
        call(
          "spawn_subagent",
          {
            name: "planner",
            task: "Add reminder to call bank",
            tools: ["reminders_create"],
          },
          "tc-spawn-narrow",
        ),
        say("Helper started."),
        say("Helper queued the reminder for your approval."),
      ],
      [
        call("reminders_create", { title: "Call bank" }, "tc-c-bank"),
        say("Deferred Call bank."),
      ],
    );

    const { coordinator, harness } = await setupChatSubagents({
      provider,
      toolGroups: [group],
      resolveTools: tools,
    });

    const collector = new EventCollector();
    const unsubscribe = coordinator.subscribe(conversationId, collector.listener);

    await coordinator.send(conversationId, "Have a helper remind me to call the bank");

    const deferredEvent = await collector.waitFor(
      (e): e is Extract<ChatEvent, { type: "deferred_approval" }> => e.type === "deferred_approval",
    );
    await collector.waitFor(
      (e) => e.type === "message" && e.body.includes("queued the reminder"),
    );

    // Narrow standing rule to `deny` AFTER defer and BEFORE user clicks "Go ahead"!
    // Update both the global SQLite permission rule and the harness standing rules.
    db.insert(s.workflowPermissions)
      .values({
        id: ulid(),
        workflowId: null,
        capability: "reminders.write",
        mode: "deny",
        createdAt: new Date(),
      })
      .run();
    harness.setApprovalRules({ "reminders.write": "deny" });

    const approveAction = deferredEvent.actions.find((a) => a.stance === "affirm")!;
    await coordinator.answerDecision(approveAction.id);

    // Tool MUST NOT execute because standing permission was narrowed to deny!
    expect(counter.writes).toBe(0);
    expect(counter.titles).toEqual([]);

    // Decision is settled/closed and its outcome records why execution was refused.
    const outcomeText = db
      .select({ text: s.narratives.text })
      .from(s.narratives)
      .where(eq(s.narratives.subjectId, deferredEvent.decisionId))
      .all()
      .map((r) => r.text)
      .join(" ");
    expect(outcomeText.toLowerCase()).toMatch(/deny|denied|refused|not/);
    expect(outcomeText).not.toContain("ran and finished");
    expect(loadChat(db, conversationId).waiting).toBe(0);

    unsubscribe();
  });

  test('declining a deferred subagent approval ("Not this one") runs write 0 times and settles decision', async () => {
    const conversationId = startConversation(db);
    const counter = { reads: 0, writes: 0, titles: [] as string[] };
    const { group, tools } = buildRemindersGroup(counter);

    const provider = new RoleRoutedProvider(
      [
        call(
          "spawn_subagent",
          { name: "planner", task: "Add reminder", tools: ["reminders_create"] },
          "tc-spawn-dec",
        ),
        say("Started planner."),
        say("Planner left a reminder waiting."),
      ],
      [
        call("reminders_create", { title: "Skip me" }, "tc-c-skip"),
        say("Deferred Skip me."),
      ],
    );

    const { coordinator } = await setupChatSubagents({
      provider,
      toolGroups: [group],
      resolveTools: tools,
    });

    const collector = new EventCollector();
    const unsubscribe = coordinator.subscribe(conversationId, collector.listener);

    await coordinator.send(conversationId, "Have planner add a reminder");
    const deferredEvent = await collector.waitFor(
      (e): e is Extract<ChatEvent, { type: "deferred_approval" }> => e.type === "deferred_approval",
    );
    await collector.waitFor((e) => e.type === "message" && e.body.includes("waiting"));

    const declineAction = deferredEvent.actions.find((a) => a.stance === "quiet")!;
    const res = await coordinator.answerDecision(declineAction.id);
    expect(res).toMatchObject({
      decisionId: deferredEvent.decisionId,
      outcome: "declined",
      deferred: true,
    });
    expect(counter.writes).toBe(0);
    expect(loadChat(db, conversationId).waiting).toBe(0);

    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// 3. Read-Only Subagent & Monotonic Attenuation
// ---------------------------------------------------------------------------

describe("read-only subagent and monotonic privilege attenuation", () => {
  test("subagent spawned with readOnly: true has write tools stripped and cannot reach defer", async () => {
    const conversationId = startConversation(db);
    const counter = { reads: 0, writes: 0, titles: [] as string[] };
    const { group, tools } = buildRemindersGroup(counter);

    const provider = new RoleRoutedProvider(
      [
        call(
          "spawn_subagent",
          {
            name: "auditor",
            task: "Inspect reminders in read-only mode",
            groups: ["reminders"],
            readOnly: true,
          },
          "tc-spawn-ro",
        ),
        say("Dispatched read-only auditor."),
        say("Auditor finished reading."),
      ],
      [
        // Even if the child model tries to invoke a write tool, it is stripped and cannot defer.
        call("reminders_create", { title: "Unauthorized write" }, "tc-ro-write"),
        say("I have no write access; done auditing."),
      ],
    );

    const { coordinator } = await setupChatSubagents({
      provider,
      toolGroups: [group],
      resolveTools: tools,
    });

    const collector = new EventCollector();
    const unsubscribe = coordinator.subscribe(conversationId, collector.listener);

    await coordinator.send(conversationId, "Audit my reminders in read-only mode");
    await collector.waitFor((e) => e.type === "message" && e.body === "Auditor finished reading.");

    // Child was NEVER offered `reminders_create` (nor `spawn_subagent`).
    expect(provider.childOffered.length).toBeGreaterThanOrEqual(1);
    for (const offered of provider.childOffered) {
      expect(offered).not.toContain("reminders_create");
      expect(offered).not.toContain("spawn_subagent");
    }

    // Zero writes ran and zero deferred approvals were created!
    expect(counter.writes).toBe(0);
    expect(collector.events.some((e) => e.type === "deferred_approval")).toBe(false);
    expect(db.select().from(s.decisions).all()).toHaveLength(0);

    unsubscribe();
  });

  test("monotonic attenuation: chat parent with narrow groups cannot spawn a subagent with tools or groups outside those groups", async () => {
    const conversationId = startConversation(db);
    const counter = { reads: 0, writes: 0, titles: [] as string[] };
    const { group: remindersGroup, tools: remindersTools } = buildRemindersGroup(counter);

    // Parent is ONLY granted `remindersGroup` — NOT `calendar`.
    const provider = new RoleRoutedProvider(
      [
        // Attempt 1: escalate via individual tool outside parent's groups
        call(
          "spawn_subagent",
          { name: "esc-tool", task: "Read calendar", tools: ["calendar_list"] },
          "tc-esc-1",
        ),
        // Attempt 2: escalate via group outside parent's groups
        call(
          "spawn_subagent",
          { name: "esc-group", task: "Open calendar group", groups: ["calendar"] },
          "tc-esc-2",
        ),
        // Valid narrowed spawn within parent's allowed group succeeds
        call(
          "spawn_subagent",
          { name: "valid-reader", task: "List reminders", tools: ["reminders_list"] },
          "tc-valid-1",
        ),
        say("Calendar was refused; spawned a reminders-only reader instead."),
        say("Reminders reader finished."),
      ],
      [
        call("reminders_list", {}, "tc-valid-list"),
        say("Listed reminders cleanly."),
      ],
    );

    const { coordinator } = await setupChatSubagents({
      provider,
      toolGroups: [remindersGroup],
      resolveTools: remindersTools,
    });

    const collector = new EventCollector();
    const unsubscribe = coordinator.subscribe(conversationId, collector.listener);

    await coordinator.send(conversationId, "Try spawning calendar and reminders helpers");
    await collector.waitFor((e) => e.type === "message" && e.body === "Reminders reader finished.");

    // Both escalation attempts received error/refusal tool results back to the parent model!
    const afterEsc1 = provider.parentCalls[1]!.find((m) => m.toolCallId === "tc-esc-1");
    expect(afterEsc1?.role).toBe("tool");
    expect(afterEsc1?.content.toLowerCase()).toMatch(/unknown|error|not|refused|outside|disallowed/);

    const afterEsc2 = provider.parentCalls[2]!.find((m) => m.toolCallId === "tc-esc-2");
    expect(afterEsc2?.role).toBe("tool");
    expect(afterEsc2?.content.toLowerCase()).toMatch(/unknown|error|not|refused|outside|disallowed/);

    // Only the valid narrowed subagent actually ran, and it held ONLY `reminders_list`.
    expect(provider.childOffered.length).toBeGreaterThanOrEqual(1);
    expect(provider.childOffered[0]).toEqual(["reminders_list"]);
    expect(counter.reads).toBe(1);

    unsubscribe();
  });
});
