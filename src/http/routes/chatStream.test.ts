// Persistent conversation SSE transport & coordinator-backed chat HTTP route
// contract tests (Surface 8).
//
// 100% offline/sandbox-safe: exercises Elysia `routes.handle(new Request(...))`
// against a real temp SQLite database and an injected deterministic
// `SessionCoordinator` test double — no real TCP sockets or live LLM calls.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalTurnInput, ReconciledSession } from "@elicollinson/solenoid-engine";
import { createDb, runMigrations, type Db } from "../../db";
import {
  NoSuchDecisionError,
  openApproval,
  startConversation,
} from "../../db/mutations/chat";
import type { ChatAgent } from "../../agents/chat";
import { SessionCoordinator, type AnswerDecisionResult } from "../../chat/coordinator";
import { NotWaitingError } from "../../chat/session";
import type { ChatEvent, LiveTurnSnapshot } from "../../shared/chat";
import { createChatRoutes } from "./chat";

interface ParsedSseFrame {
  event: string | null;
  data: ChatEvent;
}

/**
 * Deterministic in-memory `SessionCoordinator` double implementing the exact
 * Wave 0 contract so route tests verify HTTP framing, status codes, headers,
 * multi-tab fan-out, disconnect cleanup, and error mapping without network I/O.
 */
class FakeSessionCoordinator extends SessionCoordinator {
  private readonly listeners = new Map<string, Set<(event: ChatEvent) => void>>();
  private readonly snapshots = new Map<string, LiveTurnSnapshot | null>();
  private turnSeq = 0;

  readonly subscribeCalls: string[] = [];
  readonly sendCalls: Array<{ conversationId: string; text: string }> = [];
  readonly cancelCalls: string[] = [];
  readonly decisionCalls: string[] = [];
  unsubscribeCount = 0;

  /** Active conversation ids for `cancel()` to return true on. */
  readonly activeConversations = new Set<string>();
  /** Scripted decision handlers keyed by `actionId`. */
  readonly decisionHandlers = new Map<string, () => Promise<AnswerDecisionResult> | AnswerDecisionResult>();

  constructor(db: Db) {
    super({ db });
  }

  setLiveSnapshot(conversationId: string, snapshot: LiveTurnSnapshot | null): void {
    this.snapshots.set(conversationId, snapshot);
  }

  subscriberCount(conversationId: string): number {
    return this.listeners.get(conversationId)?.size ?? 0;
  }

  emit(conversationId: string, event: ChatEvent): void {
    const set = this.listeners.get(conversationId);
    if (!set) return;
    for (const listener of [...set]) {
      listener(event);
    }
  }

  override subscribe(conversationId: string, listener: (event: ChatEvent) => void): () => void {
    let set = this.listeners.get(conversationId);
    if (!set) {
      set = new Set();
      this.listeners.set(conversationId, set);
    }
    set.add(listener);
    this.subscribeCalls.push(conversationId);
    // Contract: immediately push initial `snapshot` frame on connect.
    listener({ type: "snapshot", live: this.getLiveSnapshot(conversationId) });
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      set.delete(listener);
      this.unsubscribeCount += 1;
    };
  }

  override getLiveSnapshot(conversationId: string): LiveTurnSnapshot | null {
    return this.snapshots.get(conversationId) ?? null;
  }

  override async send(
    conversationId: string,
    text: string,
  ): Promise<{ turnId: string }> {
    this.sendCalls.push({ conversationId, text });
    const turnId = `turn-${++this.turnSeq}`;
    return { turnId };
  }

  override async cancel(conversationId: string): Promise<boolean> {
    this.cancelCalls.push(conversationId);
    if (!this.activeConversations.has(conversationId)) return false;
    this.activeConversations.delete(conversationId);
    this.snapshots.set(conversationId, null);
    this.emit(conversationId, { type: "cancelled", reason: "user" });
    return true;
  }

  override async answerDecision(actionId: string): Promise<AnswerDecisionResult> {
    this.decisionCalls.push(actionId);
    const handler = this.decisionHandlers.get(actionId);
    if (!handler) throw new NoSuchDecisionError(actionId);
    return await handler();
  }

  override async appendVoiceTurn(_conversationId: string, _input: ExternalTurnInput): Promise<void> {}

  override async reconcileOnBoot(): Promise<ReconciledSession[]> {
    return [];
  }

  override isActive(conversationId: string): boolean {
    return this.activeConversations.has(conversationId);
  }

  override async close(): Promise<void> {
    this.listeners.clear();
    this.snapshots.clear();
    this.activeConversations.clear();
    await super.close().catch(() => {});
  }
}

interface ByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

/** Incremental SSE frame reader over a Response's ReadableStream with timeout guards. */
class SseClient {
  private readonly reader: ByteStreamReader;
  private readonly decoder = new TextDecoder();
  private readonly queue: ParsedSseFrame[] = [];
  private buffer = "";
  private closed = false;

  constructor(
    readonly response: Response,
    private readonly controller: AbortController,
  ) {
    if (!response.body) {
      throw new Error(`Expected SSE response body (status ${response.status})`);
    }
    this.reader = response.body.getReader() as ByteStreamReader;
  }

  async next(timeoutMs = 1500): Promise<ParsedSseFrame> {
    if (this.queue.length > 0) return this.queue.shift()!;

    const deadline = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for SSE frame`)),
        timeoutMs,
      );
      timer.unref?.();
    });

    const readFrame = async (): Promise<ParsedSseFrame> => {
      while (this.queue.length === 0) {
        const { done, value } = await this.reader.read();
        if (done) {
          throw new Error("SSE stream closed unexpectedly before delivering expected frame");
        }
        this.buffer += this.decoder.decode(value, { stream: true });
        let cut = this.buffer.indexOf("\n\n");
        while (cut !== -1) {
          const record = this.buffer.slice(0, cut);
          this.buffer = this.buffer.slice(cut + 2);
          const lines = record.split("\n").filter((line) => line.length > 0 && !line.startsWith(":"));
          let eventName: string | null = null;
          const dataParts: string[] = [];
          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataParts.push(line.slice(5).trim());
            }
          }
          if (dataParts.length > 0) {
            this.queue.push({
              event: eventName,
              data: JSON.parse(dataParts.join("\n")) as ChatEvent,
            });
          }
          cut = this.buffer.indexOf("\n\n");
        }
      }
      return this.queue.shift()!;
    };

    return await Promise.race([readFrame(), deadline]);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.reader.cancel().catch(() => {});
    this.controller.abort();
  }
}

let dir: string;
let db: Db;
let coordinator: FakeSessionCoordinator;
let openStreams: SseClient[];

const noAgent = (): ChatAgent => {
  throw new Error("legacy runChatTurn agent path must not be called when SessionCoordinator is wired");
};

function makeApp() {
  return createChatRoutes(
    () => db,
    noAgent,
    () => "google/gemma-4-26b-a4b-qat",
    () => coordinator,
  );
}

async function openStream(app: ReturnType<typeof makeApp>, conversationId: string): Promise<SseClient> {
  const controller = new AbortController();
  const response = await app.handle(
    new Request(`http://localhost/api/chat/${conversationId}/stream`, {
      method: "GET",
      signal: controller.signal,
    }),
  );
  expect(response.status).toBe(200);
  const client = new SseClient(response, controller);
  openStreams.push(client);
  return client;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "solenoid-chat-stream-"));
  db = createDb(join(dir, "test.db"));
  runMigrations(db);
  coordinator = new FakeSessionCoordinator(db);
  openStreams = [];
});

afterEach(async () => {
  for (const stream of openStreams) {
    await stream.close();
  }
  await coordinator.close();
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/chat/:id/stream", () => {
  test("returns 200 with SSE headers and immediately pushes an idle snapshot frame", async () => {
    const conversationId = startConversation(db);
    const app = makeApp();
    const controller = new AbortController();
    const response = await app.handle(
      new Request(`http://localhost/api/chat/${conversationId}/stream`, {
        method: "GET",
        signal: controller.signal,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const client = new SseClient(response, controller);
    openStreams.push(client);

    const first = await client.next();
    expect(first.event).toBe("snapshot");
    expect(first.data).toEqual({ type: "snapshot", live: null });
  });

  test("returns 404 with error payload on unknown conversation without subscribing", async () => {
    const app = makeApp();
    const unknownId = "conv-does-not-exist";
    const response = await app.handle(
      new Request(`http://localhost/api/chat/${unknownId}/stream`, { method: "GET" }),
    );

    expect(response.status).toBe(404);
    const contentType = response.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain(unknownId);
    expect(coordinator.subscribeCalls).toHaveLength(0);
  });

  test("immediately pushes in-flight LiveTurnSnapshot when a turn or approval is active on connect", async () => {
    const conversationId = startConversation(db);
    const inFlight: LiveTurnSnapshot = {
      turnId: "turn-active-1",
      asked: "Schedule dentist appointment Thursday",
      source: "text",
      said: ["I'll put a hold on Thursday at 9am."],
      streamingText: "Waiting for your go-ahead...",
      streamingReasoning: "Checking Thursday slot",
      calls: [
        {
          id: "call-1",
          name: "calendar.list",
          arg: "Aug 24 – 30",
          duration: "0.3s",
          kind: "read",
          ok: true,
          status: "completed",
        },
      ],
      opened: ["calendar"],
      pending: {
        type: "approval",
        decisionId: "dec-live-1",
        ref: "ap/0825-1",
        title: "I'll put a hold on Thursday at 9am.",
        why: "Creates a calendar event.",
        hold: "Nothing has been written. I stopped before the call.",
        tool: "calendar.create",
        facts: [
          ["Call", "calendar.create"],
          ["title", "Dentist"],
        ],
        actions: [
          { id: "act-yes", label: "Go ahead", stance: "affirm" },
          { id: "act-no", label: "Not this one", stance: "quiet" },
        ],
      },
      deferredApprovals: [],
      activeSubagents: [{ id: "sa-1", name: "researcher", status: "running", current: "reading notes" }],
      error: null,
    };
    coordinator.setLiveSnapshot(conversationId, inFlight);

    const app = makeApp();
    const client = await openStream(app, conversationId);

    const first = await client.next();
    expect(first.event).toBe("snapshot");
    expect(first.data).toEqual({ type: "snapshot", live: inFlight });
  });

  test("pushes live frames across multiple turns AND async onAutoTurn completions over one persistent connection", async () => {
    const conversationId = startConversation(db);
    const app = makeApp();
    const client = await openStream(app, conversationId);

    // Initial idle snapshot
    expect((await client.next()).data).toEqual({ type: "snapshot", live: null });

    // Turn 1: typed user turn with tool_start -> tool_end -> delta -> message
    const turn1Events: ChatEvent[] = [
      { type: "turn_start", turnId: "t-1", asked: "Check reminders", source: "text" },
      { type: "tool_start", id: "c-1", name: "reminders.list", kind: "read", arg: "today" },
      { type: "tool_end", id: "c-1", name: "reminders.list", kind: "read", arg: "today", duration: "0.2s", ok: true },
      { type: "delta", text: "You have two reminders." },
      {
        type: "message",
        messageId: "m-1",
        body: "You have two reminders.",
        note: null,
        toolSummary: "1 tool call · reminders.list",
        source: "text",
      },
    ];
    for (const ev of turn1Events) coordinator.emit(conversationId, ev);
    for (const expected of turn1Events) {
      const received = await client.next();
      expect(received.event).toBe(expected.type);
      expect(received.data).toEqual(expected);
    }

    // Turn 2: second typed turn on the SAME open SSE connection (must NOT have closed!)
    const turn2Events: ChatEvent[] = [
      { type: "turn_start", turnId: "t-2", asked: "Research flights in background", source: "text" },
      {
        type: "subagent_status",
        subagents: [{ id: "sa-flights", name: "flight-finder", status: "running", current: "searching" }],
      },
      { type: "delta", text: "Spawned a background researcher." },
      {
        type: "message",
        messageId: "m-2",
        body: "Spawned a background researcher.",
        note: null,
        toolSummary: null,
        source: "text",
      },
    ];
    for (const ev of turn2Events) coordinator.emit(conversationId, ev);
    for (const expected of turn2Events) {
      const received = await client.next();
      expect(received.data).toEqual(expected);
    }

    // Turn 3: async onAutoTurn completion pushed later with zero user POST
    const autoTurnEvents: ChatEvent[] = [
      { type: "subagent_status", subagents: [] },
      { type: "turn_start", turnId: "t-auto-3", asked: "", source: "subagent" },
      { type: "delta", text: "Found 2 nonstop options." },
      {
        type: "message",
        messageId: "m-3",
        body: "Found 2 nonstop options.",
        note: null,
        toolSummary: null,
        source: "subagent",
      },
    ];
    for (const ev of autoTurnEvents) coordinator.emit(conversationId, ev);
    for (const expected of autoTurnEvents) {
      const received = await client.next();
      expect(received.event).toBe(expected.type);
      expect(received.data).toEqual(expected);
    }
  });

  test("fans out identical live frames and approval settlements to multiple concurrent tabs", async () => {
    const conversationId = startConversation(db);
    const app = makeApp();
    const tab1 = await openStream(app, conversationId);
    const tab2 = await openStream(app, conversationId);

    expect(coordinator.subscriberCount(conversationId)).toBe(2);
    expect((await tab1.next()).data).toEqual({ type: "snapshot", live: null });
    expect((await tab2.next()).data).toEqual({ type: "snapshot", live: null });

    const sequence: ChatEvent[] = [
      { type: "turn_start", turnId: "t-shared", asked: "Create hold", source: "text" },
      { type: "delta", text: "I'll ask before creating the hold." },
      {
        type: "approval",
        decisionId: "dec-shared",
        ref: "ap/0825-2",
        title: "Create Thursday hold",
        why: "Writes a calendar event.",
        hold: "Nothing has been written.",
        tool: "calendar.create",
        facts: [["Call", "calendar.create"]],
        actions: [
          { id: "act-approve", label: "Go ahead", stance: "affirm" },
          { id: "act-decline", label: "Not this one", stance: "quiet" },
        ],
      },
      { type: "settled", decisionId: "dec-shared", outcome: "approved" },
      {
        type: "message",
        messageId: "m-shared",
        body: "Done — Thursday hold is on your calendar.",
        note: null,
        toolSummary: "1 tool call · calendar.create",
        source: "text",
      },
    ];

    for (const ev of sequence) coordinator.emit(conversationId, ev);

    for (const expected of sequence) {
      const [frame1, frame2] = await Promise.all([tab1.next(), tab2.next()]);
      expect(frame1.data).toEqual(expected);
      expect(frame2.data).toEqual(expected);
    }
  });

  test("closing one subscriber stream cleans up its listener without aborting active turns or subagents", async () => {
    const conversationId = startConversation(db);
    coordinator.activeConversations.add(conversationId);
    const app = makeApp();
    const tab1 = await openStream(app, conversationId);
    const tab2 = await openStream(app, conversationId);

    expect((await tab1.next()).data).toEqual({ type: "snapshot", live: null });
    expect((await tab2.next()).data).toEqual({ type: "snapshot", live: null });
    expect(coordinator.subscriberCount(conversationId)).toBe(2);

    // Close tab1 only
    await tab1.close();
    await Bun.sleep(15);

    expect(coordinator.subscriberCount(conversationId)).toBe(1);
    expect(coordinator.unsubscribeCount).toBe(1);
    // Critical invariant: closing an SSE tab MUST NOT cancel the running turn or subagents.
    expect(coordinator.cancelCalls).toHaveLength(0);
    expect(coordinator.isActive(conversationId)).toBe(true);

    // Tab 2 continues receiving events cleanly and emitting does not throw
    const followUp: ChatEvent = { type: "delta", text: "Still running smoothly." };
    coordinator.emit(conversationId, followUp);
    expect((await tab2.next()).data).toEqual(followUp);
  });
});

describe("POST /api/chat/:id/messages", () => {
  test("returns 202 with { turnId } accepted into SessionCoordinator queue", async () => {
    const conversationId = startConversation(db);
    const app = makeApp();

    const response = await app.handle(
      new Request(`http://localhost/api/chat/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Summarize my unread emails" }),
      }),
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as { turnId?: string };
    expect(typeof body.turnId).toBe("string");
    expect(body.turnId!.length).toBeGreaterThan(0);
    expect(coordinator.sendCalls).toEqual([
      { conversationId, text: "Summarize my unread emails" },
    ]);
  });

  test("returns 404 on unknown conversation without invoking coordinator.send", async () => {
    const app = makeApp();
    const response = await app.handle(
      new Request("http://localhost/api/chat/nonexistent-conv/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }),
    );

    expect(response.status).toBe(404);
    expect(coordinator.sendCalls).toHaveLength(0);
  });

  test("returns 400 or 422 on empty text without invoking coordinator.send", async () => {
    const conversationId = startConversation(db);
    const app = makeApp();
    const response = await app.handle(
      new Request(`http://localhost/api/chat/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "" }),
      }),
    );

    expect([400, 422]).toContain(response.status);
    expect(coordinator.sendCalls).toHaveLength(0);
  });
});

describe("POST /api/chat/:id/cancel", () => {
  test("cancels active turn via coordinator, returns 200, and broadcasts terminal cancelled frame", async () => {
    const conversationId = startConversation(db);
    coordinator.activeConversations.add(conversationId);
    const app = makeApp();

    const stream = await openStream(app, conversationId);
    expect((await stream.next()).data).toEqual({ type: "snapshot", live: null });

    const response = await app.handle(
      new Request(`http://localhost/api/chat/${conversationId}/cancel`, {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { cancelled?: boolean };
    expect(body).toMatchObject({ cancelled: true });
    expect(coordinator.cancelCalls).toEqual([conversationId]);

    const cancelledFrame = await stream.next();
    expect(cancelledFrame.event).toBe("cancelled");
    expect(cancelledFrame.data.type).toBe("cancelled");
  });

  test("returns 200 { cancelled: false } when conversation is idle", async () => {
    const conversationId = startConversation(db);
    const app = makeApp();

    const response = await app.handle(
      new Request(`http://localhost/api/chat/${conversationId}/cancel`, {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { cancelled?: boolean };
    expect(body).toMatchObject({ cancelled: false });
    expect(coordinator.cancelCalls).toEqual([conversationId]);
  });

  test("returns 404 on unknown conversation without invoking coordinator.cancel", async () => {
    const app = makeApp();
    const unknownId = "missing-conv-cancel";
    const response = await app.handle(
      new Request(`http://localhost/api/chat/${unknownId}/cancel`, {
        method: "POST",
      }),
    );

    expect(response.status).toBe(404);
    const contentType = response.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain(unknownId);
    expect(coordinator.cancelCalls).toHaveLength(0);
  });
});

describe("POST /api/chat/decisions", () => {
  test("handles live blocking interrupt approval via coordinator (200) and notifies subscribers", async () => {
    const conversationId = startConversation(db);
    const app = makeApp();
    const stream = await openStream(app, conversationId);
    expect((await stream.next()).data).toEqual({ type: "snapshot", live: null });

    coordinator.decisionHandlers.set("act-live-approve", () => {
      coordinator.emit(conversationId, {
        type: "settled",
        decisionId: "dec-live-approve",
        outcome: "approved",
      });
      return { decisionId: "dec-live-approve", outcome: "approved", resumed: true };
    });

    const response = await app.handle(
      new Request("http://localhost/api/chat/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: "act-live-approve" }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { decisionId: string; outcome: string };
    expect(body.decisionId).toBe("dec-live-approve");
    expect(body.outcome).toBe("approved");
    expect(coordinator.decisionCalls).toEqual(["act-live-approve"]);

    expect((await stream.next()).data).toEqual({
      type: "settled",
      decisionId: "dec-live-approve",
      outcome: "approved",
    });
  });

  test("handles post-restart resumed blocking approval from SQLite checkpoint (200, not 410)", async () => {
    const conversationId = startConversation(db);
    // Persisted open decision row with NO legacy in-memory `pending` entry (simulating process restart).
    const opened = openApproval(db, {
      conversationId,
      title: "Put a hold on Thursday morning",
      facts: [["Call", "calendar.create"]],
      choices: [
        { label: "Go ahead", stance: "affirm", approves: true },
        { label: "Not this one", stance: "quiet", approves: false },
      ],
    });
    const approveActionId = opened.actions.find((a) => a.stance === "affirm")!.id;

    coordinator.decisionHandlers.set(approveActionId, () => ({
      decisionId: opened.decisionId,
      outcome: "approved",
      resumed: true,
    }));

    const app = makeApp();
    const response = await app.handle(
      new Request("http://localhost/api/chat/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: approveActionId }),
      }),
    );

    // Must resume through SessionCoordinator (200), never fail with legacy 410 NotWaitingError.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { decisionId: string; outcome: string };
    expect(body.decisionId).toBe(opened.decisionId);
    expect(body.outcome).toBe("approved");
    expect(coordinator.decisionCalls).toEqual([approveActionId]);
  });

  test("handles deferred subagent write approval via coordinator (200) and broadcasts settlement", async () => {
    const conversationId = startConversation(db);
    const app = makeApp();
    const stream = await openStream(app, conversationId);
    expect((await stream.next()).data).toEqual({ type: "snapshot", live: null });

    coordinator.decisionHandlers.set("act-deferred-yes", () => {
      coordinator.emit(conversationId, {
        type: "settled",
        decisionId: "dec-deferred-1",
        outcome: "approved",
      });
      return { decisionId: "dec-deferred-1", outcome: "approved", deferred: true };
    });

    const response = await app.handle(
      new Request("http://localhost/api/chat/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: "act-deferred-yes" }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { decisionId: string; outcome: string };
    expect(body.decisionId).toBe("dec-deferred-1");
    expect(body.outcome).toBe("approved");
    expect((await stream.next()).data).toEqual({
      type: "settled",
      decisionId: "dec-deferred-1",
      outcome: "approved",
    });
  });

  test("returns 409 on duplicate or unknown actionId", async () => {
    const app = makeApp();

    // First answer succeeds, second answer to same actionId throws NoSuchDecisionError.
    let answered = false;
    coordinator.decisionHandlers.set("act-once", () => {
      if (answered) throw new NoSuchDecisionError("act-once");
      answered = true;
      return { decisionId: "dec-once", outcome: "declined", resumed: true };
    });

    const first = await app.handle(
      new Request("http://localhost/api/chat/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: "act-once" }),
      }),
    );
    expect(first.status).toBe(200);

    const duplicate = await app.handle(
      new Request("http://localhost/api/chat/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: "act-once" }),
      }),
    );
    expect(duplicate.status).toBe(409);
    const dupBody = (await duplicate.json()) as { error?: string };
    expect(typeof dupBody.error).toBe("string");

    const unknown = await app.handle(
      new Request("http://localhost/api/chat/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: "act-totally-unknown" }),
      }),
    );
    expect(unknown.status).toBe(409);
    const unknownBody = (await unknown.json()) as { error?: string };
    expect(typeof unknownBody.error).toBe("string");
  });

  test("returns 410 when coordinator throws NotWaitingError on an unresumable decision", async () => {
    const app = makeApp();
    coordinator.decisionHandlers.set("act-unresumable", () => {
      throw new NotWaitingError("dec-unresumable");
    });

    const response = await app.handle(
      new Request("http://localhost/api/chat/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: "act-unresumable" }),
      }),
    );

    expect(response.status).toBe(410);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("dec-unresumable");
    expect(coordinator.decisionCalls).toEqual(["act-unresumable"]);
  });
});
