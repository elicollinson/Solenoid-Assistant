// Surface 6 — Checkpoint & Approval Persistence, Schema Integrity, and Surface Hydration
//
// Locks down:
// 1. Drizzle migration creates `chat_sessions` & `chat_checkpoints` as STRICT SQLite tables.
// 2. `DrizzleCheckpointStore` full `CheckpointStore` contract (monotonic seq, prefix lookup,
//    ambiguous prefix rejection, loadLatest/list excluding child subagents, renameDevice,
//    reconcileOrphaned, cascade delete).
// 3. `DrizzleApprovalStore` full `ApprovalStore` contract (relational `decisions`, `actions`,
//    and `activity_items` rows, opaque choice lookup, atomic `settle` / AlreadySettledError,
//    post-execution `recordExecution` narrative append).
// 4. `loadChat()`, `loadConversations()`, and `loadHome()` hydration from checkpoints +
//    relational blocking & deferred approvals (and `yoursOnly` workflow exclusion).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@ag-ui/core";
import { eq } from "drizzle-orm";
import {
  OPEN_TOOL_GROUP,
  SOLENOID_METADATA_KEY,
  type DeviceConfig,
} from "@elicollinson/solenoid-engine";
import {
  AlreadySettledError,
  type ApprovalChoice,
  type CreateApprovalInput,
} from "@elicollinson/solenoid-security";
import { createDb, runMigrations, ulid, type Db } from "./index";
import * as s from "./schema";
import { DrizzleApprovalStore, DrizzleCheckpointStore } from "./chatCheckpoints";
import { markConversationVoiceInvoked, startConversation } from "./mutations/chat";
import { loadChat, loadConversations } from "./queries/chat";
import { loadHome } from "./queries/home";

const DEVICE_A: DeviceConfig = { id: "dev-studio", name: "studio-mac" };
const DEVICE_B: DeviceConfig = { id: "dev-laptop", name: "road-air" };

function sha256Hex(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function makeChoices(affirmId = ulid(), declineId = ulid()): ApprovalChoice[] {
  return [
    { id: affirmId, label: "Go ahead", stance: "affirm", approves: true },
    { id: declineId, label: "Not this one", stance: "quiet", approves: false },
  ];
}

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chat-checkpoints-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Schema Integrity
// ---------------------------------------------------------------------------

describe("chat checkpoint schema integrity", () => {
  test("migrations create chat_sessions and chat_checkpoints as STRICT SQLite tables", () => {
    const tables = db.$client
      .query<{ name: string; type: string; strict: number }, []>(`PRAGMA table_list`)
      .all()
      .filter(
        (t) =>
          t.type === "table" &&
          !t.name.startsWith("sqlite_") &&
          !t.name.startsWith("__drizzle") &&
          !t.name.startsWith("search_"),
      );

    const byName = new Map(tables.map((t) => [t.name, t]));
    expect(byName.get("chat_sessions")).toBeDefined();
    expect(byName.get("chat_sessions")?.strict).toBe(1);
    expect(byName.get("chat_checkpoints")).toBeDefined();
    expect(byName.get("chat_checkpoints")?.strict).toBe(1);

    // Every relational table in the migrated database must remain STRICT.
    const loose = tables.filter((t) => t.strict !== 1).map((t) => t.name);
    expect(loose).toEqual([]);
  });

  test("foreign keys are enabled so chat_checkpoints cascades on session delete", () => {
    const [fk] = db.$client.query<{ foreign_keys: number }, []>(`PRAGMA foreign_keys`).all();
    expect(fk?.foreign_keys).toBe(1);

    const fks = db.$client
      .query<{ table: string; on_delete: string }, []>(`PRAGMA foreign_key_list('chat_checkpoints')`)
      .all();
    expect(fks.some((row) => row.table === "chat_sessions" && row.on_delete.toUpperCase() === "CASCADE")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. DrizzleCheckpointStore Contract
// ---------------------------------------------------------------------------

describe("DrizzleCheckpointStore", () => {
  test("saves monotonic seq and turnStartSeq across Phase 2 mid-turn boundaries", async () => {
    const store = new DrizzleCheckpointStore(db);
    const sessionId = "aaaa1111-0000-0000-0000-000000000001";

    const m1 = await store.save({
      sessionId,
      status: "running",
      kind: "turn_start",
      device: DEVICE_A,
      committed: false,
      transcript: [{ role: "user", content: "Check my reminders and add one", origin: "operator" }],
      thread: [{ id: "u1", role: "user", content: "Check my reminders and add one" }],
    });
    expect(m1).toEqual({ seq: 1, turnStartSeq: 1 });

    const m2 = await store.save({
      sessionId,
      status: "waiting_approval",
      kind: "interrupt",
      device: DEVICE_A,
      committed: false,
      turnStartSeq: m1.turnStartSeq,
      transcript: [
        { role: "user", content: "Check my reminders and add one", origin: "operator", screened: true },
        {
          role: "assistant",
          content: "I'll add a reminder.",
          toolCalls: [{ id: "tc-1", name: "reminders_create", arguments: { title: "Call dentist" } }],
        },
      ],
      thread: [
        { id: "u1", role: "user", content: "Check my reminders and add one" },
        {
          id: "a1",
          role: "assistant",
          content: "I'll add a reminder.",
          toolCalls: [
            {
              id: "tc-1",
              type: "function",
              function: { name: "reminders_create", arguments: JSON.stringify({ title: "Call dentist" }) },
            },
          ],
        },
      ],
      pending: {
        interrupts: [
          {
            interruptId: "int-1",
            toolCallId: "tc-1",
            tool: "reminders_create",
            args: { title: "Call dentist" },
            argsDigest: sha256Hex({ title: "Call dentist" }),
            description: "Create a reminder.",
            approvalId: "dec-1",
          },
        ],
        completedResults: [],
        committed: false,
        turnStartSeq: 1,
      },
    });
    expect(m2).toEqual({ seq: 2, turnStartSeq: 1 });

    const mid = await store.load(sessionId);
    expect(mid?.session.status).toBe("waiting_approval");
    expect(mid?.checkpoint.seq).toBe(2);
    expect(mid?.checkpoint.kind).toBe("interrupt");
    expect(mid?.checkpoint.turnStartSeq).toBe(1);
    expect(mid?.checkpoint.committed).toBe(false);
    expect(mid?.checkpoint.pending).toMatchObject({
      committed: false,
      interrupts: [{ interruptId: "int-1", toolCallId: "tc-1", tool: "reminders_create", approvalId: "dec-1" }],
    });

    const m3 = await store.save({
      sessionId,
      status: "idle",
      kind: "turn_end",
      device: DEVICE_A,
      committed: true,
      turnStartSeq: m1.turnStartSeq,
      transcript: [
        { role: "user", content: "Check my reminders and add one", origin: "operator", screened: true },
        { role: "assistant", content: "Done — reminder created.", screened: true },
      ],
      thread: [
        { id: "u1", role: "user", content: "Check my reminders and add one" },
        { id: "a2", role: "assistant", content: "Done — reminder created." },
      ],
    });
    expect(m3).toEqual({ seq: 3, turnStartSeq: 1 });

    // Next turn opens a fresh turnStartSeq equal to its own seq.
    const m4 = await store.save({
      sessionId,
      status: "running",
      kind: "turn_start",
      device: DEVICE_A,
      transcript: [
        { role: "user", content: "Check my reminders and add one", origin: "operator", screened: true },
        { role: "assistant", content: "Done — reminder created.", screened: true },
        { role: "user", content: "Thanks!", origin: "operator" },
      ],
      thread: [
        { id: "u1", role: "user", content: "Check my reminders and add one" },
        { id: "a2", role: "assistant", content: "Done — reminder created." },
        { id: "u2", role: "user", content: "Thanks!" },
      ],
    });
    expect(m4).toEqual({ seq: 4, turnStartSeq: 4 });

    await store.close();
  });

  test("load matches exact ID and unambiguous prefix, returns undefined for unknown, and throws on ambiguous prefix", async () => {
    const store = new DrizzleCheckpointStore(db);

    await store.save({
      sessionId: "pref-alpha-0001",
      status: "idle",
      kind: "turn_end",
      device: DEVICE_A,
      transcript: [{ role: "user", content: "First session" }],
      thread: [{ id: "u1", role: "user", content: "First session" }],
    });
    await store.save({
      sessionId: "pref-beta-0002",
      status: "idle",
      kind: "turn_end",
      device: DEVICE_A,
      transcript: [{ role: "user", content: "Second session" }],
      thread: [{ id: "u2", role: "user", content: "Second session" }],
    });

    const exact = await store.load("pref-alpha-0001");
    expect(exact?.session.id).toBe("pref-alpha-0001");
    expect(exact?.session.title).toBe("First session");

    const uniquePrefix = await store.load("pref-beta");
    expect(uniquePrefix?.session.id).toBe("pref-beta-0002");

    expect(await store.load("nonexistent-prefix")).toBeUndefined();
    expect(await store.load("   ")).toBeUndefined();

    await expect(store.load("pref-")).rejects.toThrow(/ambiguous/i);

    await store.close();
  });

  test("loadLatest and list return newest-first top-level sessions while excluding child subagent sessions", async () => {
    const store = new DrizzleCheckpointStore(db);
    expect(await store.loadLatest()).toBeUndefined();
    expect(await store.list()).toEqual([]);

    await store.save({
      sessionId: "parent-older",
      status: "idle",
      kind: "turn_end",
      device: DEVICE_A,
      transcript: [{ role: "user", content: "Older parent conversation" }],
      thread: [{ id: "u1", role: "user", content: "Older parent conversation" }],
    });
    await Bun.sleep(5);

    await store.save({
      sessionId: "parent-newer",
      status: "idle",
      kind: "turn_end",
      device: DEVICE_A,
      transcript: [{ role: "user", content: "Newer parent conversation" }],
      thread: [{ id: "u2", role: "user", content: "Newer parent conversation" }],
    });
    await Bun.sleep(5);

    // Child session saved AFTER both parents must still be excluded from loadLatest() and list().
    await store.save({
      sessionId: "child-subagent-1",
      parentId: "parent-newer",
      status: "idle",
      kind: "turn_end",
      device: DEVICE_A,
      transcript: [{ role: "user", content: "Subagent task" }],
      thread: [{ id: "cu1", role: "user", content: "Subagent task" }],
    });

    const latest = await store.loadLatest();
    expect(latest?.session.id).toBe("parent-newer");

    const listed = await store.list();
    expect(listed.map((s) => s.id)).toEqual(["parent-newer", "parent-older"]);
    expect(listed.every((s) => s.parentId == null)).toBe(true);

    const limited = await store.list(1);
    expect(limited.map((s) => s.id)).toEqual(["parent-newer"]);

    // Child can still be loaded directly by ID.
    const child = await store.load("child-subagent-1");
    expect(child?.session.parentId).toBe("parent-newer");

    await store.close();
  });

  test("renameDevice backfills matching device sessions and checkpoints without touching other devices", async () => {
    const store = new DrizzleCheckpointStore(db);

    await store.save({
      sessionId: "dev-sess-1",
      status: "idle",
      kind: "turn_end",
      device: DEVICE_A,
      transcript: [{ role: "user", content: "A only" }],
      thread: [],
    });

    // Cross-device: started on A, continued on B
    await store.save({
      sessionId: "dev-sess-2",
      status: "idle",
      kind: "turn_end",
      device: DEVICE_A,
      transcript: [{ role: "user", content: "Started on A" }],
      thread: [],
    });
    await store.save({
      sessionId: "dev-sess-2",
      status: "idle",
      kind: "turn_end",
      device: DEVICE_B,
      transcript: [
        { role: "user", content: "Started on A" },
        { role: "user", content: "Continued on B" },
      ],
      thread: [],
    });

    await store.save({
      sessionId: "dev-sess-3",
      status: "idle",
      kind: "turn_end",
      device: DEVICE_B,
      transcript: [{ role: "user", content: "B only" }],
      thread: [],
    });

    const updated = await store.renameDevice(DEVICE_A.id, "home-studio", DEVICE_A.name);
    expect(updated).toBe(2);

    const s1 = await store.load("dev-sess-1");
    expect(s1?.session.originDeviceName).toBe("home-studio");
    expect(s1?.session.lastDeviceName).toBe("home-studio");
    expect(s1?.checkpoint.deviceName).toBe("home-studio");

    const s2 = await store.load("dev-sess-2");
    expect(s2?.session.originDeviceName).toBe("home-studio");
    expect(s2?.session.lastDeviceName).toBe(DEVICE_B.name);
    expect(s2?.checkpoint.deviceName).toBe(DEVICE_B.name);

    const s3 = await store.load("dev-sess-3");
    expect(s3?.session.originDeviceName).toBe(DEVICE_B.name);
    expect(s3?.session.lastDeviceName).toBe(DEVICE_B.name);

    await store.close();
  });

  test("reconcileOrphaned marks running+committed->failed and running+uncommitted->idle while leaving waiting_approval and idle untouched", async () => {
    const store = new DrizzleCheckpointStore(db);

    await store.save({
      sessionId: "orphan-committed",
      status: "running",
      kind: "step_tools",
      device: DEVICE_A,
      committed: true,
      transcript: [{ role: "user", content: "Committed write in progress" }],
      thread: [],
    });
    await store.save({
      sessionId: "orphan-uncommitted",
      status: "running",
      kind: "turn_start",
      device: DEVICE_A,
      committed: false,
      transcript: [{ role: "user", content: "Read-only turn in progress" }],
      thread: [],
    });
    await store.save({
      sessionId: "waiting-durable",
      status: "waiting_approval",
      kind: "interrupt",
      device: DEVICE_A,
      committed: false,
      transcript: [{ role: "user", content: "Waiting on user approval" }],
      thread: [],
    });
    await store.save({
      sessionId: "healthy-idle",
      status: "idle",
      kind: "turn_end",
      device: DEVICE_A,
      committed: true,
      transcript: [{ role: "user", content: "Already finished" }],
      thread: [],
    });

    const reconciled = await store.reconcileOrphaned();
    expect(reconciled).toHaveLength(2);

    const byId = new Map(reconciled.map((r) => [r.sessionId, r]));
    expect(byId.get("orphan-committed")).toMatchObject({
      sessionId: "orphan-committed",
      previousStatus: "running",
      newStatus: "failed",
      committed: true,
    });
    expect(byId.get("orphan-uncommitted")).toMatchObject({
      sessionId: "orphan-uncommitted",
      previousStatus: "running",
      newStatus: "idle",
      committed: false,
    });

    expect((await store.load("orphan-committed"))?.session.status).toBe("failed");
    expect((await store.load("orphan-uncommitted"))?.session.status).toBe("idle");
    expect((await store.load("waiting-durable"))?.session.status).toBe("waiting_approval");
    expect((await store.load("healthy-idle"))?.session.status).toBe("idle");

    // Reconciling a second time is an idempotent no-op.
    expect(await store.reconcileOrphaned()).toEqual([]);

    await store.close();
  });

  test("delete removes the session and cascades all of its chat_checkpoints rows", async () => {
    const store = new DrizzleCheckpointStore(db);
    const sessionId = "cascade-delete-sess";

    await store.save({
      sessionId,
      status: "running",
      kind: "turn_start",
      device: DEVICE_A,
      transcript: [{ role: "user", content: "Turn 1" }],
      thread: [],
    });
    await store.save({
      sessionId,
      status: "idle",
      kind: "turn_end",
      device: DEVICE_A,
      transcript: [
        { role: "user", content: "Turn 1" },
        { role: "assistant", content: "Reply 1" },
      ],
      thread: [],
    });

    await store.delete(sessionId);

    expect(await store.load(sessionId)).toBeUndefined();
    const remaining = db.$client
      .query<{ n: number }, [string]>(`SELECT count(*) as n FROM chat_checkpoints WHERE session_id = ?1`)
      .get(sessionId);
    expect(remaining?.n).toBe(0);

    await store.close();
  });
});

// ---------------------------------------------------------------------------
// 3. DrizzleApprovalStore Contract
// ---------------------------------------------------------------------------

describe("DrizzleApprovalStore", () => {
  test("creates blocking relational decisions + actions, resolves opaque choiceId, settles atomically, and appends execution outcome", async () => {
    const conversationId = startConversation(db);
    const store = new DrizzleApprovalStore(db);
    const affirmId = ulid();
    const declineId = ulid();
    const args = { title: "Call the plumber" };
    const argsDigest = sha256Hex(args);

    const input: CreateApprovalInput = {
      mode: "blocking",
      tool: "reminders_create",
      capability: "reminders.write",
      args,
      argsDigest,
      title: "I'll set a reminder to call the plumber.",
      why: "Create a reminder.",
      hold: "Nothing has been written. I stopped before the call.",
      facts: [
        ["Call", "reminders.create"],
        ["title", "Call the plumber"],
      ],
      choices: makeChoices(affirmId, declineId),
      scope: { conversationId, toolCallId: "tc-plumber" },
    };

    const created = await store.create(input);
    expect(created.id).toBeTruthy();
    expect(created.ref).toMatch(/^ap\/\d{4}-\d+$/);
    expect(created.mode).toBe("blocking");
    expect(created.status).toBe("open");
    expect(created.argsDigest).toBe(argsDigest);
    expect(created.chosenId).toBeNull();
    expect(created.outcome).toBeNull();

    // Relational rows exist in `decisions` and `actions`.
    const decisionRow = db.select().from(s.decisions).where(eq(s.decisions.id, created.id)).get();
    expect(decisionRow).toMatchObject({
      id: created.id,
      subjectId: conversationId,
      state: "open",
      blocking: true,
    });
    const actionRows = db.select().from(s.actions).where(eq(s.actions.decisionId, created.id)).all();
    expect(actionRows).toHaveLength(2);

    // Lookup by exact ID and opaque choiceId.
    expect((await store.get(created.id))?.id).toBe(created.id);
    const foundAffirm = await store.findByChoiceId(affirmId);
    expect(foundAffirm?.record.id).toBe(created.id);
    expect(foundAffirm?.choice).toMatchObject({ id: affirmId, approves: true, label: "Go ahead" });
    const foundDecline = await store.findByChoiceId(declineId);
    expect(foundDecline?.choice).toMatchObject({ id: declineId, approves: false, label: "Not this one" });
    expect(await store.findByChoiceId("forged-choice-id")).toBeUndefined();

    // Atomic settlement.
    const settled = await store.settle({
      approvalId: created.id,
      outcome: "approved",
      chosenId: affirmId,
      settledNote: 'You said "Go ahead", 09:30.',
      now: new Date("2026-08-25T13:30:00Z"),
    });
    expect(settled.status).toBe("approved");
    expect(settled.outcome).toBe("approved");
    expect(settled.chosenId).toBe(affirmId);
    expect(settled.settledNote).toContain('You said "Go ahead"');

    const decisionAfterSettle = db.select().from(s.decisions).where(eq(s.decisions.id, created.id)).get();
    expect(decisionAfterSettle).toMatchObject({
      state: "resolved",
      chosenActionId: affirmId,
      resolvedBy: "user",
    });

    // Double settlement MUST throw AlreadySettledError.
    await expect(
      Promise.resolve().then(() =>
        store.settle({
          approvalId: created.id,
          outcome: "declined",
          chosenId: declineId,
        }),
      ),
    ).rejects.toBeInstanceOf(AlreadySettledError);

    // Post-execution outcome appends the second sentence without overwriting the first.
    const executed = await store.recordExecution(
      created.id,
      { status: "ok", durationMs: 35 },
      "reminders.create ran and finished.",
    );
    expect(executed.execution).toMatchObject({ status: "ok", durationMs: 35 });
    expect(executed.settledNote).toContain('You said "Go ahead"');
    expect(executed.settledNote).toContain("reminders.create ran and finished.");

    const outcomeNarratives = db
      .select({ text: s.narratives.text })
      .from(s.narratives)
      .where(eq(s.narratives.subjectId, created.id))
      .all()
      .map((r) => r.text)
      .join(" ");
    expect(outcomeNarratives).toContain('You said "Go ahead"');
    expect(outcomeNarratives).toContain("reminders.create ran and finished.");
  });

  test("creates deferred approval with decisions, tool_call action, and activity_items feed row", async () => {
    const conversationId = startConversation(db);
    const store = new DrizzleApprovalStore(db);
    const affirmId = ulid();
    const declineId = ulid();
    const args = { title: "Buy milk" };

    const record = await store.create({
      mode: "deferred",
      tool: "reminders_create",
      capability: "reminders.write",
      args,
      argsDigest: sha256Hex(args),
      title: "Planner wants to add a reminder to buy milk.",
      why: "Create a reminder.",
      hold: "Nothing was written. The subagent continued without it.",
      facts: [
        ["Governed by", "reminders.write"],
        ["Call", "reminders.create"],
        ["title", "Buy milk"],
      ],
      choices: makeChoices(affirmId, declineId),
      scope: { conversationId, subagentId: "sa-1", subagentName: "planner" },
    });

    expect(record.mode).toBe("deferred");
    expect(record.status).toBe("open");

    const decisionRow = db.select().from(s.decisions).where(eq(s.decisions.id, record.id)).get();
    expect(decisionRow).toMatchObject({
      id: record.id,
      subjectId: conversationId,
      state: "open",
      blocking: false,
    });

    const affirmAction = db.select().from(s.actions).where(eq(s.actions.id, affirmId)).get();
    expect(affirmAction).toBeDefined();
    expect(affirmAction?.decisionId).toBe(record.id);
    expect(affirmAction?.effectKind).toBe("tool_call");

    const feedItem = db.select().from(s.activityItems).where(eq(s.activityItems.decisionId, record.id)).get();
    expect(feedItem).toBeDefined();
    expect(feedItem?.state).toBe("attention");

    const found = await store.findByChoiceId(affirmId);
    expect(found?.record.id).toBe(record.id);
    expect(found?.record.mode).toBe("deferred");
    expect(found?.choice.approves).toBe(true);
  });

  test("settle records expired state and timeout resolver", async () => {
    const conversationId = startConversation(db);
    const store = new DrizzleApprovalStore(db);

    const record = await store.create({
      mode: "blocking",
      tool: "reminders_create",
      capability: "reminders.write",
      args: { title: "Expire me" },
      argsDigest: sha256Hex({ title: "Expire me" }),
      title: "Expire this approval",
      why: "Create a reminder.",
      hold: "Nothing has been written.",
      facts: [["Call", "reminders.create"]],
      choices: makeChoices(),
      scope: { conversationId },
    });

    const settled = await store.settle({
      approvalId: record.id,
      outcome: "expired",
      settledNote: "No answer — nothing was written.",
    });
    expect(settled.status).toBe("expired");
    expect(settled.outcome).toBe("expired");

    const decisionRow = db.select().from(s.decisions).where(eq(s.decisions.id, record.id)).get();
    expect(decisionRow).toMatchObject({ state: "expired", resolvedBy: "timeout" });

    await expect(
      Promise.resolve().then(() => store.settle({ approvalId: record.id, outcome: "approved" })),
    ).rejects.toBeInstanceOf(AlreadySettledError);
  });
});

// ---------------------------------------------------------------------------
// 4. loadChat(), loadConversations(), and loadHome() Checkpoint Hydration
// ---------------------------------------------------------------------------

describe("checkpoint-backed surface hydration", () => {
  test("baseline: loadConversations excludes workflow_runs.transcript_conversation_id via yoursOnly", () => {
    const now = new Date("2026-08-25T14:00:00Z");
    const userChatId = startConversation(db, now);

    const wfId = ulid();
    const runId = ulid();
    const runTranscriptId = ulid();
    db.insert(s.entities)
      .values([
        { id: wfId, kind: "workflow", createdAt: now, updatedAt: now },
        { id: runId, kind: "workflow_run", createdAt: now, updatedAt: now },
        { id: runTranscriptId, kind: "conversation", createdAt: now, updatedAt: now },
      ])
      .run();
    db.insert(s.workflows)
      .values({ id: wfId, slug: "baseline-wf", name: "Baseline WF", triggerKind: "on_demand", createdAt: now })
      .run();
    db.insert(s.conversations)
      .values({
        id: runTranscriptId,
        channel: "agent_chat",
        title: "baseline-wf · run 1",
        startedAt: now,
        lastMessageAt: now,
      })
      .run();
    db.insert(s.workflowRuns)
      .values({
        id: runId,
        workflowId: wfId,
        ordinal: 1,
        trigger: "manual",
        state: "done",
        startedAt: now,
        transcriptConversationId: runTranscriptId,
      })
      .run();

    const list = loadConversations(db, now);
    expect(list.conversations.map((c) => c.id)).toEqual([userChatId]);
  });

  test("loadChat hydrates full tool calls, ×N toolSummary, opened group note, voice source badge, and blocking + deferred approvals", async () => {
    const now = new Date("2026-08-25T14:00:00Z");
    const conversationId = startConversation(db, now);
    const checkpointStore = new DrizzleCheckpointStore(db);
    const approvalStore = new DrizzleApprovalStore(db);

    const blockingArgs = { title: "Book plumber" };
    const blockingApproval = await approvalStore.create({
      mode: "blocking",
      tool: "reminders_create",
      capability: "reminders.write",
      args: blockingArgs,
      argsDigest: sha256Hex(blockingArgs),
      title: "I'll set a reminder to book the plumber.",
      why: "Create a reminder.",
      hold: "Nothing has been written. I stopped before the call.",
      facts: [
        ["Call", "reminders.create"],
        ["title", "Book plumber"],
      ],
      choices: makeChoices(),
      scope: { conversationId, toolCallId: "tc-write-1" },
    });

    const deferredArgs = { title: "Order filters" };
    const deferredApproval = await approvalStore.create({
      mode: "deferred",
      tool: "reminders_create",
      capability: "reminders.write",
      args: deferredArgs,
      argsDigest: sha256Hex(deferredArgs),
      title: "Scheduler wants to add a reminder to order filters.",
      why: "Create a reminder.",
      hold: "Nothing was written. The subagent continued without it.",
      facts: [
        ["Call", "reminders.create"],
        ["title", "Order filters"],
      ],
      choices: makeChoices(),
      scope: { conversationId, subagentId: "sa-1", subagentName: "scheduler" },
    });

    const thread: Message[] = [
      // Turn 1: typed user + assistant that opens reminders group, runs 2× reminders_list + 1× calendar_list
      { id: "u-1", role: "user", content: "Check my reminders and calendar" },
      {
        id: "a-1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc-open",
            type: "function",
            function: { name: OPEN_TOOL_GROUP, arguments: JSON.stringify({ group: "reminders" }) },
          },
          {
            id: "tc-r1",
            type: "function",
            function: { name: "reminders_list", arguments: JSON.stringify({ query: "today" }) },
          },
          {
            id: "tc-r2",
            type: "function",
            function: { name: "reminders_list", arguments: JSON.stringify({ query: "overdue" }) },
          },
          {
            id: "tc-c1",
            type: "function",
            function: { name: "calendar_list", arguments: JSON.stringify({ query: "week" }) },
          },
        ],
      },
      {
        id: "tr-open",
        role: "tool",
        toolCallId: "tc-open",
        content: "Opened reminders tool group.",
        metadata: { [SOLENOID_METADATA_KEY]: { durationMs: 2 } },
      },
      {
        id: "tr-r1",
        role: "tool",
        toolCallId: "tc-r1",
        content: "[]",
        metadata: { [SOLENOID_METADATA_KEY]: { durationMs: 120 } },
      },
      {
        id: "tr-r2",
        role: "tool",
        toolCallId: "tc-r2",
        content: "[]",
        metadata: { [SOLENOID_METADATA_KEY]: { durationMs: 85 } },
      },
      {
        id: "tr-c1",
        role: "tool",
        toolCallId: "tc-c1",
        content: "[]",
        metadata: { [SOLENOID_METADATA_KEY]: { durationMs: 240 } },
      },
      { id: "a-2", role: "assistant", content: "Nothing urgent is due today." },
      // Turn 2: voice exchange stamped with metadata.solenoid.source = 'voice'
      {
        id: "u-voice",
        role: "user",
        content: "Can you check again by voice?",
        metadata: {
          [SOLENOID_METADATA_KEY]: {
            source: "voice",
            model: "models/gemini-3.8-live-extended-thinking",
          },
        },
      },
      {
        id: "a-voice",
        role: "assistant",
        content: "Still completely clear today.",
        metadata: {
          [SOLENOID_METADATA_KEY]: {
            source: "voice",
            model: "models/gemini-3.8-live-extended-thinking",
          },
        },
      },
      // Turn 3: pending blocking write approval
      { id: "u-3", role: "user", content: "Add a reminder to book the plumber" },
      {
        id: "a-3",
        role: "assistant",
        content: "I'll set a reminder to book the plumber.",
        toolCalls: [
          {
            id: "tc-write-1",
            type: "function",
            function: { name: "reminders_create", arguments: JSON.stringify(blockingArgs) },
          },
        ],
      },
    ];

    await checkpointStore.save({
      sessionId: conversationId,
      status: "waiting_approval",
      kind: "interrupt",
      device: DEVICE_A,
      committed: false,
      transcript: [
        { role: "user", content: "Check my reminders and calendar", origin: "operator", screened: true },
        { role: "assistant", content: "Nothing urgent is due today.", screened: true },
        {
          role: "user",
          content: "Can you check again by voice?",
          origin: "operator",
          metadata: { [SOLENOID_METADATA_KEY]: { source: "voice" } },
        },
        {
          role: "assistant",
          content: "Still completely clear today.",
          metadata: { [SOLENOID_METADATA_KEY]: { source: "voice" } },
        },
        { role: "user", content: "Add a reminder to book the plumber", origin: "operator", screened: true },
      ],
      thread,
      pending: {
        interrupts: [
          {
            interruptId: "int-plumber",
            toolCallId: "tc-write-1",
            tool: "reminders_create",
            args: blockingArgs,
            argsDigest: blockingApproval.argsDigest,
            description: "Create a reminder.",
            approvalId: blockingApproval.id,
          },
        ],
        completedResults: [],
        committed: false,
      },
    });

    const chat = loadChat(db, conversationId, now);

    // Turn 1 agent response has FULL hydrated calls (no longer empty on reload!), ×2 collapse, and opened group note.
    const toolTurn = chat.turns.find((t) => t.by === "agent" && t.body.includes("Nothing urgent"));
    expect(toolTurn).toBeDefined();
    expect(toolTurn?.note).toContain("opened reminders");
    expect(toolTurn?.toolSummary).toBe("3 tool calls · reminders.list ×2, calendar.list");
    expect(toolTurn?.calls).toHaveLength(3);
    expect(toolTurn?.calls.map((c) => c.name)).toEqual([
      "reminders.list",
      "reminders.list",
      "calendar.list",
    ]);
    // open_tool_group must NOT appear as a work tool call.
    expect(toolTurn?.calls.some((c) => c.name.includes("open"))).toBe(false);

    // Voice turns carry source: 'voice'.
    const voiceUser = chat.turns.find((t) => t.body === "Can you check again by voice?");
    const voiceAgent = chat.turns.find((t) => t.body === "Still completely clear today.");
    expect(voiceUser?.source).toBe("voice");
    expect(voiceAgent?.source).toBe("voice");

    // Blocking approval is hydrated onto the waiting turn.
    const blockingTurn = chat.turns.find((t) => t.approval?.decisionId === blockingApproval.id);
    expect(blockingTurn?.approval).toMatchObject({
      decisionId: blockingApproval.id,
      state: "open",
      title: "I'll set a reminder to book the plumber.",
    });
    expect(blockingTurn?.approval?.choices.map((c) => c.label)).toEqual(["Go ahead", "Not this one"]);

    // Deferred approval is hydrated onto turns' deferredApprovals list.
    const allDeferred = chat.turns.flatMap((t) => t.deferredApprovals ?? []);
    expect(allDeferred.find((d) => d.decisionId === deferredApproval.id)).toMatchObject({
      decisionId: deferredApproval.id,
      state: "open",
      deferred: true,
      subagentName: "scheduler",
    });

    // Both blocking and deferred open approvals are counted in waiting.
    expect(chat.waiting).toBe(2);

    await checkpointStore.close();
  });

  test("loadConversations derives title, lede, when, attention state, model, voiceInvoked and excludes workflow run transcripts", async () => {
    const now = new Date("2026-08-25T14:00:00Z");
    const checkpointStore = new DrizzleCheckpointStore(db);
    const approvalStore = new DrizzleApprovalStore(db);

    // 1. Checkpoint-backed chat with voice + open blocking approval (attention state).
    const chatA = startConversation(db, new Date("2026-08-25T13:50:00Z"));
    markConversationVoiceInvoked(db, chatA, "models/gemini-3.8-live-extended-thinking");
    await checkpointStore.save({
      sessionId: chatA,
      title: "Can the Latham review move to…",
      status: "waiting_approval",
      kind: "interrupt",
      device: DEVICE_A,
      transcript: [
        { role: "user", content: "Can the Latham review move to Monday afternoon?" },
        { role: "assistant", content: "Monday at 2pm is open. Shall I move it?" },
      ],
      thread: [
        { id: "u-a", role: "user", content: "Can the Latham review move to Monday afternoon?" },
        { id: "a-a", role: "assistant", content: "Monday at 2pm is open. Shall I move it?" },
      ],
    });
    await approvalStore.create({
      mode: "blocking",
      tool: "calendar_update",
      capability: "calendar.write",
      args: { title: "Latham review" },
      argsDigest: sha256Hex({ title: "Latham review" }),
      title: "Move the Latham review to Monday.",
      why: "Update a calendar event.",
      hold: "Nothing has been written.",
      facts: [["Call", "calendar.update"]],
      choices: makeChoices(),
      scope: { conversationId: chatA },
    });

    // 2. Seeded workflow run transcript (`channel = 'agent_chat'` referenced by `workflow_runs.transcript_conversation_id`)
    const wfId = ulid();
    const runId = ulid();
    const runTranscriptConvId = ulid();
    db.insert(s.entities)
      .values([
        { id: wfId, kind: "workflow", createdAt: now, updatedAt: now },
        { id: runId, kind: "workflow_run", createdAt: now, updatedAt: now },
        { id: runTranscriptConvId, kind: "conversation", createdAt: now, updatedAt: now },
      ])
      .run();
    db.insert(s.workflows)
      .values({ id: wfId, slug: "contract-review", name: "Contract review", triggerKind: "on_demand", createdAt: now })
      .run();
    db.insert(s.conversations)
      .values({
        id: runTranscriptConvId,
        channel: "agent_chat",
        title: "contract-review · run 3",
        startedAt: now,
        lastMessageAt: now,
      })
      .run();
    db.insert(s.workflowRuns)
      .values({
        id: runId,
        workflowId: wfId,
        ordinal: 3,
        trigger: "manual",
        state: "done",
        startedAt: now,
        transcriptConversationId: runTranscriptConvId,
      })
      .run();

    const list = loadConversations(db, now);
    expect(list.conversations.map((c) => c.id)).toEqual([chatA]);
    expect(list.conversations.find((c) => c.id === runTranscriptConvId)).toBeUndefined();

    const row = list.conversations[0]!;
    expect(row.title).toBeTruthy();
    expect(row.lede).toContain("Monday at 2pm is open.");
    expect(row.when).toBeTruthy();
    expect(row.state).toBe("attention");
    expect(row.model).toBe("models/gemini-3.8-live-extended-thinking");
    expect(row.voiceInvoked).toBe(true);
    expect(list.waiting).toBe(1);

    await checkpointStore.close();
  });

  test("loadHome and nav rail waiting count include both open blocking chat approvals and open deferred subagent approvals", async () => {
    const now = new Date("2026-08-25T14:00:00Z");
    const convBlocking = startConversation(db, now);
    const convDeferred = startConversation(db, now);
    const approvalStore = new DrizzleApprovalStore(db);

    const blocking = await approvalStore.create({
      mode: "blocking",
      tool: "reminders_create",
      capability: "reminders.write",
      args: { title: "Call Ferris" },
      argsDigest: sha256Hex({ title: "Call Ferris" }),
      title: "Add reminder to call Ferris.",
      why: "Create a reminder.",
      hold: "Nothing has been written.",
      facts: [["Call", "reminders.create"]],
      choices: makeChoices(),
      scope: { conversationId: convBlocking },
    });

    const deferred = await approvalStore.create({
      mode: "deferred",
      tool: "reminders_create",
      capability: "reminders.write",
      args: { title: "Follow up on permit" },
      argsDigest: sha256Hex({ title: "Follow up on permit" }),
      title: "Helper wants to add a reminder to follow up on permit.",
      why: "Create a reminder.",
      hold: "Nothing was written. The subagent continued without it.",
      facts: [["Call", "reminders.create"]],
      choices: makeChoices(),
      scope: { conversationId: convDeferred, subagentId: "sa-1", subagentName: "helper" },
    });

    const home = loadHome(db, now);
    const waitingIds = home.aside.waiting.map((w) => w.id);
    expect(waitingIds).toContain(blocking.id);
    expect(waitingIds).toContain(deferred.id);

    const railItems = home.rail.groups.flatMap((g) => g.items);
    const chatRail = railItems.find((item) => item.label === "Chat");
    expect(chatRail).toMatchObject({ label: "Chat", count: 2, dot: "amber" });

    // Deferred approval also surfaces in the Activity feed with live choices.
    const feedItems = home.sections.flatMap((sec) => sec.items);
    const deferredCard = feedItems.find((item) => item.decisionId === deferred.id);
    expect(deferredCard).toBeDefined();
    expect(deferredCard?.actions.length).toBeGreaterThanOrEqual(2);

    // Once both settle, waiting drops cleanly to 0 / null.
    await approvalStore.settle({ approvalId: blocking.id, outcome: "declined" });
    await approvalStore.settle({ approvalId: deferred.id, outcome: "declined" });
    const after = loadHome(db, now);
    const chatRailAfter = after.rail.groups.flatMap((g) => g.items).find((i) => i.label === "Chat");
    expect(chatRailAfter?.count).toBeNull();
    expect(after.aside.waiting).toEqual([]);
  });
});
