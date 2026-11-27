// Surface 6 — SessionCoordinator: Lazy Hydration, Serialization, Idle Eviction,
// Durable Phase 2 Crash-Resume Mid-Approval, Orphan Boot Reconciliation,
// Write-Tool Quarantine 3-Case Matrix, and Double-Click / Forgery Safety.
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
  type AgentProfile,
  type AgentTool,
  type ChatMessage,
  type ChatOptions,
  type ChatProvider,
  type Screener,
} from "@elicollinson/solenoid-engine";
import {
  AlreadySettledError,
  ApprovalNotFoundError,
  createSecurity,
  type ScreeningAssessment,
} from "@elicollinson/solenoid-security";
import { createDb, runMigrations, type Db } from "../db";
import * as s from "../db/schema";
import { DrizzleCheckpointStore } from "../db/chatCheckpoints";
import { NoSuchDecisionError, startConversation } from "../db/mutations/chat";
import { loadChat } from "../db/queries/chat";
import type { ChatEvent } from "../shared/chat";
import { SessionCoordinator } from "./coordinator";

type ScriptStep =
  | ChatMessage
  | Error
  | ((messages: ChatMessage[], opts: ChatOptions) => ChatMessage | Promise<ChatMessage>);

class ScriptedProvider implements ChatProvider {
  readonly providerName = "scripted";
  readonly calls: ChatMessage[][] = [];

  constructor(private readonly steps: ScriptStep[]) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    this.calls.push(messages.map((m) => ({ ...m })));
    const step = this.steps.shift();
    if (!step) throw new Error(`ScriptedProvider exhausted at call ${this.calls.length}`);
    if (step instanceof Error) throw step;
    const msg = typeof step === "function" ? await step(messages, opts) : step;
    if (msg.content) opts.onDelta?.({ type: "text", text: msg.content });
    return msg;
  }
}

/** Routes parent vs child subagent steps deterministically without timing races. */
class RoleRoutedProvider implements ChatProvider {
  readonly providerName = "scripted";
  readonly parentCalls: ChatMessage[][] = [];
  readonly childCalls: ChatMessage[][] = [];

  constructor(
    private readonly parentSteps: ScriptStep[],
    private readonly childSteps: ScriptStep[],
  ) {}

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatMessage> {
    const isParent = opts.tools.some((t) => t.function.name === "spawn_subagent");
    const bucket = isParent ? this.parentCalls : this.childCalls;
    const queue = isParent ? this.parentSteps : this.childSteps;
    bucket.push(messages.map((m) => ({ ...m })));
    const step = queue.shift();
    if (!step) {
      throw new Error(`RoleRoutedProvider (${isParent ? "parent" : "child"}) exhausted`);
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
let dbPath: string;
let db: Db;
let activeCoordinators: SessionCoordinator[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chat-coordinator-"));
  dbPath = join(dir, "test.db");
  db = createDb(dbPath);
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

async function buildCoordinator(options: {
  provider: ChatProvider;
  tools?: AgentTool[];
  canSpawn?: boolean;
  screener?: Screener | null;
  approvalTimeoutMs?: number;
  idleEvictMs?: number;
  targetDb?: Db;
}) {
  const targetDb = options.targetDb ?? db;
  const store = new DrizzleCheckpointStore(targetDb);
  const settings = AppSettingsSchema.parse({
    screening: { enabled: false },
    checkpoints: { enabled: true },
    device: { id: "server-1", name: "solenoid-server" },
  });
  const harness = await createHarness(settings, {
    checkpointStore: store,
    routes: [{ client: options.provider, model: "scripted" }],
    screener: options.screener ?? null,
    baseTools: [],
  });
  const tools = options.tools ?? [];
  const toolsByName = new Map(tools.map((t) => [t.definition.function.name, t]));
  const profileFactory = (): AgentProfile => ({
    name: "chat",
    tools,
    canSpawn: options.canSpawn ?? false,
    routes: [{ client: options.provider, model: "scripted" }],
    ...(options.screener ? {} : { screening: false }),
  });
  const coordinator = new SessionCoordinator({
    db: targetDb,
    harness,
    profileFactory,
    ...(options.approvalTimeoutMs !== undefined ? { approvalTimeoutMs: options.approvalTimeoutMs } : {}),
    ...(options.idleEvictMs !== undefined ? { idleEvictMs: options.idleEvictMs } : {}),
    resolveTool: async (name) => toolsByName.get(name),
  });
  activeCoordinators.push(coordinator);
  return { coordinator, store, harness };
}

function makeRemindersCreateTool(counter: { calls: number; titles: string[] }): AgentTool {
  return defineTool({
    name: "reminders_create",
    kind: "write",
    description: "Create a reminder with a title.",
    schema: z.object({ title: z.string() }),
    execute: ({ title }) => {
      counter.calls++;
      counter.titles.push(title);
      return { id: `rem-${counter.calls}`, title };
    },
  });
}

// ---------------------------------------------------------------------------
// 1. Lazy Hydration, Queue Serialization & Idle Eviction
// ---------------------------------------------------------------------------

describe("SessionCoordinator lifecycle", () => {
  test("lazily hydrates Session from SQLite checkpoint on first send and emits initial snapshot on subscribe", async () => {
    const conversationId = startConversation(db);
    const seedStore = new DrizzleCheckpointStore(db);
    await seedStore.save({
      sessionId: conversationId,
      status: "idle",
      kind: "turn_end",
      device: { id: "server-1", name: "solenoid-server" },
      transcript: [
        { role: "user", content: "Remember code cobalt-9", origin: "operator", screened: true },
        { role: "assistant", content: "Noted: cobalt-9.", screened: true },
      ],
      thread: [
        { id: "u1", role: "user", content: "Remember code cobalt-9" },
        { id: "a1", role: "assistant", content: "Noted: cobalt-9." },
      ],
    });

    const provider = new ScriptedProvider([say("The code you asked me to remember is cobalt-9.")]);
    const { coordinator } = await buildCoordinator({ provider });

    // Before any interaction, session is NOT loaded in memory.
    expect(coordinator.isActive(conversationId)).toBe(false);

    const collector = new EventCollector();
    const unsubscribe = coordinator.subscribe(conversationId, collector.listener);
    expect(collector.events[0]).toEqual({ type: "snapshot", live: null });

    await coordinator.send(conversationId, "What was the code?");
    const msg = await collector.waitFor((e): e is Extract<ChatEvent, { type: "message" }> => e.type === "message");

    expect(msg.body).toBe("The code you asked me to remember is cobalt-9.");
    expect(coordinator.isActive(conversationId)).toBe(true);

    // Model received the hydrated prior turns before the new user turn.
    const spoken = provider.calls[0]!.filter((m) => m.role !== "system").map((m) => m.content);
    expect(spoken).toEqual(["Remember code cobalt-9", "Noted: cobalt-9.", "What was the code?"]);

    const hydrated = loadChat(db, conversationId);
    expect(hydrated.turns.map((t) => t.body)).toEqual([
      "Remember code cobalt-9",
      "Noted: cobalt-9.",
      "What was the code?",
      "The code you asked me to remember is cobalt-9.",
    ]);

    unsubscribe();
  });

  test("serializes concurrent send(), appendVoiceTurn(), and onAutoTurn() without losing turns", async () => {
    const conversationId = startConversation(db);
    const childGate = Promise.withResolvers<void>();
    const turn2Gate = Promise.withResolvers<void>();
    const turn2Started = Promise.withResolvers<void>();

    const echoRead = defineTool({
      name: "echo_read",
      kind: "read",
      description: "Read a short test note.",
      schema: z.object({ key: z.string() }),
      execute: ({ key }) => `val:${key}`,
    });

    const provider = new RoleRoutedProvider(
      [
        // Turn 1: spawn background subagent and return immediately
        call("spawn_subagent", { name: "scout", task: "Check status", tools: ["echo_read"] }, "tc-spawn"),
        say("Started scout."),
        // Turn 2 (typed user message): pauses while voice turn & subagent completion arrive
        async () => {
          turn2Started.resolve();
          await turn2Gate.promise;
          return say("Turn two answer.");
        },
        // Turn 3 (auto-turn from completed subagent OR next turn)
        say("Scout reported back."),
        // Final typed turn to inspect full serialized history
        say("Everything accounted for."),
      ],
      [
        async () => {
          await childGate.promise;
          return say("Scout found all clear.");
        },
      ],
    );

    const { coordinator, store } = await buildCoordinator({
      provider,
      tools: [echoRead],
      canSpawn: true,
    });

    const collector = new EventCollector();
    const unsubscribe = coordinator.subscribe(conversationId, collector.listener);

    // Turn 1 finishes while subagent stays blocked on childGate.
    await coordinator.send(conversationId, "Start background check");
    await collector.waitFor((e) => e.type === "message" && e.body === "Started scout.");

    // Start Turn 2, wait until provider is actively mid-flight.
    const send2 = coordinator.send(conversationId, "Second typed question");
    await turn2Started.promise;

    // While Turn 2 is running, BOTH a voice turn AND a subagent completion arrive concurrently!
    const voiceAppend = coordinator.appendVoiceTurn(conversationId, {
      userText: "Quick voice note",
      assistantText: "Got your voice note.",
      source: "voice",
      model: "models/gemini-3.8-live-extended-thinking",
      screened: false,
    });
    childGate.resolve();

    // Release Turn 2 and let the serialized queue drain cleanly.
    turn2Gate.resolve();
    await Promise.all([send2, voiceAppend]);
    await collector.waitFor((e) => e.type === "message" && e.body === "Turn two answer.");
    await collector.waitFor((e) => e.type === "message" && e.body === "Scout reported back.");

    // Final send verifies all prior turns survived serialization in the checkpoint.
    await coordinator.send(conversationId, "Confirm everything");
    await collector.waitFor((e) => e.type === "message" && e.body === "Everything accounted for.");

    const loaded = await store.load(conversationId);
    expect(loaded).toBeDefined();
    expect(loaded!.checkpoint.seq).toBeGreaterThanOrEqual(4);
    const allContents = loaded!.checkpoint.transcript.map((m) => m.content).join("\n");
    expect(allContents).toContain("Start background check");
    expect(allContents).toContain("Second typed question");
    expect(allContents).toContain("Quick voice note");
    expect(allContents).toContain("Got your voice note.");
    expect(allContents).toContain("Scout reported back.");

    unsubscribe();
  });

  test("evicts idle in-memory sessions after idleEvictMs without losing persisted checkpoints", async () => {
    const conversationId = startConversation(db);
    const provider = new ScriptedProvider([
      say("Stored alpha-7."),
      say("Still remember alpha-7 after eviction."),
    ]);
    const { coordinator, store } = await buildCoordinator({
      provider,
      idleEvictMs: 30,
    });

    const collector = new EventCollector();
    const unsubscribe = coordinator.subscribe(conversationId, collector.listener);

    await coordinator.send(conversationId, "Remember alpha-7");
    await collector.waitFor((e) => e.type === "message" && e.body === "Stored alpha-7.");
    expect(coordinator.isActive(conversationId)).toBe(true);

    // Wait for idle eviction timer to reclaim the in-memory Session.
    const deadline = Date.now() + 500;
    while (coordinator.isActive(conversationId) && Date.now() < deadline) {
      await Bun.sleep(15);
    }
    expect(coordinator.isActive(conversationId)).toBe(false);

    // Checkpoint in SQLite remains intact after eviction.
    const persisted = await store.load(conversationId);
    expect(persisted?.session.status).toBe("idle");
    expect(persisted?.checkpoint.transcript.some((m) => m.content === "Stored alpha-7.")).toBe(true);

    // Next send lazily re-hydrates from SQLite and sees Turn 1 history.
    await coordinator.send(conversationId, "What did I tell you?");
    await collector.waitFor((e) => e.type === "message" && e.body === "Still remember alpha-7 after eviction.");
    expect(coordinator.isActive(conversationId)).toBe(true);
    expect(provider.calls[1]!.map((m) => m.content)).toContain("Remember alpha-7");

    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// 2. Durable Server Restart Mid-Approval (Phase 2 Crash-Resume!)
// ---------------------------------------------------------------------------

describe("durable server restart mid-approval (Phase 2 crash-resume)", () => {
  test("approved across full coordinator restart resumes from interrupt checkpoint, runs write once, notes outcome, and finishes idle", async () => {
    const conversationId = startConversation(db);
    const counter = { calls: 0, titles: [] as string[] };
    const remindersTool = makeRemindersCreateTool(counter);

    // --- Process 1 (Coordinator #1) ---
    const provider1 = new ScriptedProvider([
      call(
        "reminders_create",
        { title: "Call the plumber" },
        "tc-plumber",
        "I'll set a reminder to call the plumber.",
      ),
      say("must never execute on Coordinator #1"),
    ]);
    const { coordinator: coordinator1, store: store1 } = await buildCoordinator({
      provider: provider1,
      tools: [remindersTool],
    });

    const collector1 = new EventCollector();
    const unsub1 = coordinator1.subscribe(conversationId, collector1.listener);

    await coordinator1.send(conversationId, "remind me to call the plumber");
    const approval = await collector1.waitFor(
      (e): e is Extract<ChatEvent, { type: "approval" }> => e.type === "approval",
    );

    const approveAction = approval.actions.find((a) => a.stance === "affirm")!;
    expect(approveAction).toBeDefined();
    expect(counter.calls).toBe(0);

    // Verify relational `decisions` row AND Phase 2 `interrupt` checkpoint exist in SQLite BEFORE restart.
    const decisionBefore = db.select().from(s.decisions).where(eq(s.decisions.id, approval.decisionId)).get();
    expect(decisionBefore).toMatchObject({ id: approval.decisionId, state: "open", blocking: true });

    const cpBefore = await store1.load(conversationId);
    expect(cpBefore?.session.status).toBe("waiting_approval");
    expect(cpBefore?.checkpoint.kind).toBe("interrupt");
    expect(cpBefore?.checkpoint.pending).toMatchObject({
      interrupts: [expect.objectContaining({ tool: "reminders_create", toolCallId: "tc-plumber" })],
    });
    expect(loadChat(db, conversationId).waiting).toBe(1);

    // Simulate full server process restart: close and discard Coordinator #1 completely.
    unsub1();
    await coordinator1.close();
    activeCoordinators = activeCoordinators.filter((c) => c !== coordinator1);

    // --- Process 2 (Brand-new Coordinator #2 against same SQLite DB, empty in-memory map) ---
    const provider2 = new ScriptedProvider([say("Done — your plumber reminder is set.")]);
    const { coordinator: coordinator2, store: store2 } = await buildCoordinator({
      provider: provider2,
      tools: [remindersTool],
    });
    expect(coordinator2.isActive(conversationId)).toBe(false);

    const collector2 = new EventCollector();
    const unsub2 = coordinator2.subscribe(conversationId, collector2.listener);

    const answer = await coordinator2.answerDecision(approveAction.id);
    expect(answer).toMatchObject({
      decisionId: approval.decisionId,
      outcome: "approved",
      resumed: true,
    });

    const finalMessage = await collector2.waitFor(
      (e): e is Extract<ChatEvent, { type: "message" }> => e.type === "message",
    );
    expect(finalMessage.body).toBe("Done — your plumber reminder is set.");

    // (a) Provider #2 resumed from checkpoint and received tool output.
    expect(provider2.calls).toHaveLength(1);
    expect(provider2.calls[0]!.some((m) => m.role === "tool" && m.content.includes("Call the plumber"))).toBe(true);

    // (b) Write tool executed EXACTLY ONCE.
    expect(counter.calls).toBe(1);
    expect(counter.titles).toEqual(["Call the plumber"]);

    // (c) `noteApprovalOutcome` recorded execution outcome on the decision.
    const reloaded = loadChat(db, conversationId);
    const bubble = reloaded.turns.find((t) => t.approval?.decisionId === approval.decisionId)?.approval;
    expect(bubble).toMatchObject({ state: "resolved" });
    expect(bubble?.settled).toContain('You said "Go ahead"');
    expect(bubble?.settled).toContain("reminders.create ran and finished.");
    expect(reloaded.waiting).toBe(0);

    // (d) Checkpoint transitioned cleanly to `status: 'idle'`.
    const cpAfter = await store2.load(conversationId);
    expect(cpAfter?.session.status).toBe("idle");
    expect(cpAfter?.checkpoint.kind).toBe("turn_end");

    unsub2();
  });

  test('declined ("Not this one") across full coordinator restart runs write 0 times and delivers declined feedback', async () => {
    const conversationId = startConversation(db);
    const counter = { calls: 0, titles: [] as string[] };
    const remindersTool = makeRemindersCreateTool(counter);

    const provider1 = new ScriptedProvider([
      call("reminders_create", { title: "Cancel gym" }, "tc-gym", "I'll add a reminder to cancel the gym."),
    ]);
    const { coordinator: coordinator1 } = await buildCoordinator({
      provider: provider1,
      tools: [remindersTool],
    });

    const collector1 = new EventCollector();
    const unsub1 = coordinator1.subscribe(conversationId, collector1.listener);
    await coordinator1.send(conversationId, "remind me to cancel gym");

    const approval = await collector1.waitFor(
      (e): e is Extract<ChatEvent, { type: "approval" }> => e.type === "approval",
    );
    const declineAction = approval.actions.find((a) => a.stance === "quiet")!;
    expect(declineAction.label).toBe("Not this one");

    // Full server restart
    unsub1();
    await coordinator1.close();
    activeCoordinators = activeCoordinators.filter((c) => c !== coordinator1);

    const provider2 = new ScriptedProvider([say("Okay, I did not add that reminder.")]);
    const { coordinator: coordinator2, store: store2 } = await buildCoordinator({
      provider: provider2,
      tools: [remindersTool],
    });

    const collector2 = new EventCollector();
    const unsub2 = coordinator2.subscribe(conversationId, collector2.listener);

    const answer = await coordinator2.answerDecision(declineAction.id);
    expect(answer).toMatchObject({
      decisionId: approval.decisionId,
      outcome: "declined",
      resumed: true,
    });

    const finalMsg = await collector2.waitFor(
      (e): e is Extract<ChatEvent, { type: "message" }> => e.type === "message",
    );
    expect(finalMsg.body).toBe("Okay, I did not add that reminder.");

    // Write NEVER ran.
    expect(counter.calls).toBe(0);
    // Model received declined feedback.
    const toolResult = provider2.calls[0]!.find((m) => m.role === "tool");
    expect(toolResult?.content.toLowerCase()).toMatch(/declined|nothing was written/);

    const reloaded = loadChat(db, conversationId);
    const bubble = reloaded.turns.find((t) => t.approval?.decisionId === approval.decisionId)?.approval;
    expect(bubble?.state).toBe("resolved");
    expect(bubble?.settled).toContain('You said "Not this one"');
    expect(bubble?.settled).not.toContain("ran and finished");
    expect(reloaded.waiting).toBe(0);

    expect((await store2.load(conversationId))?.session.status).toBe("idle");

    unsub2();
  });

  test("expired blocking approval (approvalTimeoutMs: 40) settles expired and never executes tool", async () => {
    const conversationId = startConversation(db);
    const counter = { calls: 0, titles: [] as string[] };
    const remindersTool = makeRemindersCreateTool(counter);

    const provider = new ScriptedProvider([
      call("reminders_create", { title: "Water plants" }, "tc-plants", "I'll remind you to water the plants."),
      say("I did not add the reminder because you didn't answer in time."),
    ]);
    const { coordinator } = await buildCoordinator({
      provider,
      tools: [remindersTool],
      approvalTimeoutMs: 40,
    });

    const collector = new EventCollector();
    const unsubscribe = coordinator.subscribe(conversationId, collector.listener);

    await coordinator.send(conversationId, "remind me to water plants");
    const approval = await collector.waitFor(
      (e): e is Extract<ChatEvent, { type: "approval" }> => e.type === "approval",
    );
    const settled = await collector.waitFor(
      (e): e is Extract<ChatEvent, { type: "settled" }> => e.type === "settled",
    );
    await collector.waitFor((e) => e.type === "message");

    expect(settled).toMatchObject({ decisionId: approval.decisionId, outcome: "expired" });
    expect(counter.calls).toBe(0);

    const reloaded = loadChat(db, conversationId);
    const bubble = reloaded.turns.find((t) => t.approval?.decisionId === approval.decisionId)?.approval;
    expect(bubble).toMatchObject({
      state: "expired",
      settled: "No answer — nothing was written.",
    });
    expect(reloaded.waiting).toBe(0);

    // Answering after expiry must reject with 409 error semantics.
    const approveAction = approval.actions.find((a) => a.stance === "affirm")!;
    await expect(coordinator.answerDecision(approveAction.id)).rejects.toThrow();

    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// 3. Boot Orphan Reconciliation
// ---------------------------------------------------------------------------

describe("boot orphan reconciliation", () => {
  test("reconcileOnBoot marks orphaned running sessions cleanly without replaying writes and preserves waiting_approval", async () => {
    const committedConv = startConversation(db);
    const uncommittedConv = startConversation(db);
    const waitingConv = startConversation(db);
    const store = new DrizzleCheckpointStore(db);

    await store.save({
      sessionId: committedConv,
      status: "running",
      kind: "step_tools",
      device: { id: "server-1", name: "solenoid-server" },
      committed: true,
      transcript: [{ role: "user", content: "Create a reminder" }],
      thread: [{ id: "u1", role: "user", content: "Create a reminder" }],
    });
    await store.save({
      sessionId: uncommittedConv,
      status: "running",
      kind: "turn_start",
      device: { id: "server-1", name: "solenoid-server" },
      committed: false,
      transcript: [{ role: "user", content: "List reminders" }],
      thread: [{ id: "u2", role: "user", content: "List reminders" }],
    });
    await store.save({
      sessionId: waitingConv,
      status: "waiting_approval",
      kind: "interrupt",
      device: { id: "server-1", name: "solenoid-server" },
      committed: false,
      transcript: [{ role: "user", content: "Delete draft" }],
      thread: [{ id: "u3", role: "user", content: "Delete draft" }],
    });

    const counter = { calls: 0, titles: [] as string[] };
    const provider = new ScriptedProvider([]);
    const { coordinator } = await buildCoordinator({
      provider,
      tools: [makeRemindersCreateTool(counter)],
    });

    const reconciled = await coordinator.reconcileOnBoot();
    expect(reconciled).toHaveLength(2);
    expect(reconciled.find((r) => r.sessionId === committedConv)).toMatchObject({
      previousStatus: "running",
      newStatus: "failed",
      committed: true,
    });
    expect(reconciled.find((r) => r.sessionId === uncommittedConv)).toMatchObject({
      previousStatus: "running",
      newStatus: "idle",
      committed: false,
    });

    // Zero writes or model calls replayed on boot.
    expect(counter.calls).toBe(0);
    expect(provider.calls).toHaveLength(0);
    // Waiting approval session stays intact and resumable.
    expect((await store.load(waitingConv))?.session.status).toBe("waiting_approval");
  });
});

// ---------------------------------------------------------------------------
// 4. Write-Tool Response Quarantine 3-Case Matrix
// ---------------------------------------------------------------------------

describe("write-tool response quarantine matrix", () => {
  test.each([
    { label: "PI=true", mode: true as const },
    { label: "PI=false", mode: false as const },
    { label: "PI=scanner_failure", mode: "scanner_failure" as const },
  ])(
    "executes approved write once, quarantines response without leaking payload, and terminates turn with error ($label)",
    async ({ mode }) => {
      const conversationId = startConversation(db);
      let writes = 0;

      const receiptTool = defineTool({
        name: "record_external_receipt",
        kind: "write",
        description: "Record a reminder and return an external receipt.",
        schema: z.object({ title: z.string() }),
        execute: () => {
          writes++;
          return "unsafe external receipt";
        },
      });

      const security = createSecurity({
        provider: {
          async assess(parts): Promise<ScreeningAssessment> {
            const hasUnsafe = parts.some((p) => p.includes("unsafe external receipt"));
            if (!hasUnsafe) {
              return { flagged: false, blocked: false, label: "BENIGN", score: 0.01 };
            }
            if (mode === "scanner_failure") {
              throw new Error("scanner unavailable");
            }
            if (mode === true) {
              return {
                flagged: true,
                blocked: true,
                label: "MALICIOUS",
                score: 0.99,
                matchedFilters: ["pi_and_jailbreak"],
              };
            }
            return {
              flagged: false,
              blocked: true,
              label: "CONTENT_BLOCKED",
              score: 0.05,
              matchedFilters: ["dangerous"],
            };
          },
        },
      });

      const provider = new ScriptedProvider([
        call("record_external_receipt", { title: "Call the plumber" }, "tc-receipt"),
        say("must not continue after quarantined write"),
      ]);

      const { coordinator } = await buildCoordinator({
        provider,
        tools: [receiptTool],
        screener: security.screen,
      });

      const collector = new EventCollector();
      const unsubscribe = coordinator.subscribe(conversationId, collector.listener);

      await coordinator.send(conversationId, "remind me to call the plumber");
      const approval = await collector.waitFor(
        (e): e is Extract<ChatEvent, { type: "approval" }> => e.type === "approval",
      );

      const approveAction = approval.actions.find((a) => a.stance === "affirm")!;
      await coordinator.answerDecision(approveAction.id);

      const errorEvent = await collector.waitFor(
        (e): e is Extract<ChatEvent, { type: "error" }> => e.type === "error",
      );
      expect(errorEvent.type).toBe("error");

      // Write executed EXACTLY ONCE and model was NEVER called a second time to invite a retry.
      expect(writes).toBe(1);
      expect(provider.calls).toHaveLength(1);

      // Stream reports quarantined write completion.
      const toolEvent = collector.events.find(
        (e) => (e.type === "tool_end" || e.type === "tool") && e.name === "record.external_receipt",
      );
      expect(toolEvent).toMatchObject({
        name: "record.external_receipt",
        kind: "write",
        ok: true,
        responseQuarantined: true,
      });

      // Reloaded decision settlement records execution + quarantine without leaking payload or args.
      const chat = loadChat(db, conversationId);
      const settled = chat.turns.find((t) => t.approval?.decisionId === approval.decisionId)?.approval;
      expect(settled?.state).toBe("resolved");
      expect(settled?.settled).toContain("record.external_receipt ran and finished");
      expect(settled?.settled).toContain("response was quarantined");
      expect(settled?.settled).not.toContain("unsafe external receipt");
      expect(settled?.settled).not.toContain("Call the plumber");
      expect(chat.waiting).toBe(0);

      unsubscribe();
    },
  );
});

// ---------------------------------------------------------------------------
// 5. Double-Click & Forgery Safety
// ---------------------------------------------------------------------------

describe("double-click and forgery safety", () => {
  test("rejects unknown actionId and already-settled actionId with 409 error types and uses opaque choice IDs", async () => {
    const conversationId = startConversation(db);
    const counter = { calls: 0, titles: [] as string[] };
    const remindersTool = makeRemindersCreateTool(counter);

    const provider = new ScriptedProvider([
      call("reminders_create", { title: "Pay rent" }, "tc-rent"),
      say("Added rent reminder."),
    ]);
    const { coordinator } = await buildCoordinator({
      provider,
      tools: [remindersTool],
    });

    // Forged / unknown actionId rejects cleanly.
    const unknownErr = await coordinator
      .answerDecision("forged-unknown-action-id")
      .catch((e: unknown) => e);
    expect(
      unknownErr instanceof NoSuchDecisionError || unknownErr instanceof ApprovalNotFoundError,
    ).toBe(true);

    const collector = new EventCollector();
    const unsubscribe = coordinator.subscribe(conversationId, collector.listener);
    await coordinator.send(conversationId, "remind me to pay rent");

    const approval = await collector.waitFor(
      (e): e is Extract<ChatEvent, { type: "approval" }> => e.type === "approval",
    );

    // Choice IDs must be opaque (never predictable booleans or labels).
    const choiceIds = approval.actions.map((a) => a.id);
    expect(choiceIds).toHaveLength(2);
    expect(new Set(choiceIds).size).toBe(2);
    for (const id of choiceIds) {
      expect(id.length).toBeGreaterThanOrEqual(16);
      expect(["true", "false", "approve", "decline", "0", "1"]).not.toContain(id.toLowerCase());
    }

    const affirmId = approval.actions.find((a) => a.stance === "affirm")!.id;
    const quietId = approval.actions.find((a) => a.stance === "quiet")!.id;

    // Concurrent double-click: exactly one succeeds, one rejects with AlreadySettledError / NoSuchDecisionError.
    const [r1, r2] = await Promise.allSettled([
      coordinator.answerDecision(affirmId),
      coordinator.answerDecision(affirmId),
    ]);
    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejected = [r1, r2].filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      rejected[0]!.reason instanceof AlreadySettledError ||
        rejected[0]!.reason instanceof NoSuchDecisionError,
    ).toBe(true);

    await collector.waitFor((e) => e.type === "message");
    expect(counter.calls).toBe(1);

    // Subsequent click on the opposite button also rejects with AlreadySettledError / NoSuchDecisionError.
    const lateErr = await coordinator.answerDecision(quietId).catch((e: unknown) => e);
    expect(lateErr instanceof AlreadySettledError || lateErr instanceof NoSuchDecisionError).toBe(true);
    expect(counter.calls).toBe(1);

    unsubscribe();
  });
});
