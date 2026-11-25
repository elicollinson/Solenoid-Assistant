// Client-side chat reducer (`apply`) and persistent SSE `useChat` hook tests
// (Surface 8).
//
// Purely offline/sandbox-safe: uses `happy-dom`, React 19 `createRoot` + `act`,
// and mocked `fetch` backed by controllable `ReadableStream` SSE frames.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  ChatEvent,
  ChatListPayload,
  ChatPayload,
  ChatTurnRow,
  LiveTurnSnapshot,
} from "../../../src/shared/chat";
import {
  EMPTY_LIVE_TURN,
  apply,
  useChat,
  type ChatState,
  type LiveTurn,
} from "./chat";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BLOCKING_APPROVAL: Extract<ChatEvent, { type: "approval" }> = {
  type: "approval",
  decisionId: "dec-blocking-1",
  ref: "ap/0825-1",
  title: "Put a hold on Thursday morning.",
  why: "Creates a calendar event.",
  hold: "Nothing has been written. I stopped before the call.",
  tool: "calendar.create",
  facts: [
    ["Call", "calendar.create"],
    ["title", "Ferris walkthrough"],
  ],
  actions: [
    { id: "act-block-yes", label: "Go ahead", stance: "affirm" },
    { id: "act-block-no", label: "Not this one", stance: "quiet" },
  ],
};

const DEFERRED_APPROVAL_1: Extract<ChatEvent, { type: "deferred_approval" }> = {
  type: "deferred_approval",
  decisionId: "dec-deferred-1",
  ref: "ap/0825-2",
  title: "Add Friday dentist reminder.",
  why: "Creates a reminder.",
  hold: "Nothing has been written yet.",
  tool: "reminders.create",
  subagentName: "planner",
  facts: [
    ["Call", "reminders.create"],
    ["title", "Dentist"],
  ],
  actions: [
    { id: "act-def1-yes", label: "Go ahead", stance: "affirm" },
    { id: "act-def1-no", label: "Not this one", stance: "quiet" },
  ],
};

const DEFERRED_APPROVAL_2: Extract<ChatEvent, { type: "deferred_approval" }> = {
  type: "deferred_approval",
  decisionId: "dec-deferred-2",
  ref: "ap/0825-3",
  title: "Update Ferris contact note.",
  why: "Updates an OKF memory note.",
  hold: "Nothing has been written yet.",
  tool: "okf.write",
  subagentName: "researcher",
  facts: [
    ["Call", "okf.write"],
    ["slug", "contact/ferris"],
  ],
  actions: [
    { id: "act-def2-yes", label: "Go ahead", stance: "affirm" },
    { id: "act-def2-no", label: "Not this one", stance: "quiet" },
  ],
};

// ---------------------------------------------------------------------------
// 1. Pure reducer `apply(turn, event)` tests
// ---------------------------------------------------------------------------

describe("apply(turn, event) pure reducer", () => {
  test("delta appends to streamingText (including when initially undefined)", () => {
    const bare: LiveTurn = {
      asked: "hi",
      said: [],
      calls: [],
      opened: [],
      pending: null,
      error: null,
    };
    const t1 = apply(bare, { type: "delta", text: "Hello " });
    const t2 = apply(t1, { type: "delta", text: "from Solenoid." });
    expect(t2.streamingText).toBe("Hello from Solenoid.");
    // Must remain immutable
    expect(bare.streamingText).toBeUndefined();
  });

  test("reasoning_delta appends to streamingReasoning (including when initially undefined)", () => {
    const bare: LiveTurn = {
      asked: "think",
      said: [],
      calls: [],
      opened: [],
      pending: null,
      error: null,
    };
    const t1 = apply(bare, { type: "reasoning_delta", text: "Checking Thursday... " });
    const t2 = apply(t1, { type: "reasoning_delta", text: "slot is open." });
    expect(t2.streamingReasoning).toBe("Checking Thursday... slot is open.");
  });

  test("turn_start initializes turn metadata and clears per-turn transient prose/tools", () => {
    const dirty: LiveTurn = {
      ...EMPTY_LIVE_TURN,
      turnId: "old-turn",
      asked: "old prompt",
      source: "text",
      said: ["stale"],
      streamingText: "stale tokens",
      streamingReasoning: "stale reasoning",
      calls: [{ id: "old-c", name: "okf.read", arg: null, duration: "0.1s", kind: "read", ok: true, status: "completed" }],
      opened: ["calendar"],
      pending: BLOCKING_APPROVAL,
      error: "old error",
    };

    const next = apply(dirty, {
      type: "turn_start",
      turnId: "turn-auto-2",
      asked: "",
      source: "subagent",
    });

    expect(next.turnId).toBe("turn-auto-2");
    expect(next.asked).toBe("");
    expect(next.source).toBe("subagent");
    expect(next.streamingText).toBe("");
    expect(next.streamingReasoning).toBe("");
    expect(next.said).toEqual([]);
    expect(next.calls).toEqual([]);
    expect(next.opened).toEqual([]);
    expect(next.pending).toBeNull();
    expect(next.error).toBeNull();
  });

  test("snapshot hydrates full LiveTurnSnapshot cleanly", () => {
    const snap: LiveTurnSnapshot = {
      turnId: "turn-snap-1",
      asked: "Check flights",
      source: "text",
      said: ["Checking flights now."],
      streamingText: "Found two ",
      streamingReasoning: "Comparing times",
      calls: [
        { id: "c-1", name: "web.search", arg: "NYC BOS", duration: "", kind: "read", ok: true, status: "running" },
      ],
      opened: ["web"],
      pending: null,
      deferredApprovals: [DEFERRED_APPROVAL_1],
      activeSubagents: [{ id: "sa-1", name: "planner", status: "running", current: "drafting" }],
      error: null,
    };

    const next = apply(EMPTY_LIVE_TURN, { type: "snapshot", live: snap });
    expect(next.turnId).toBe("turn-snap-1");
    expect(next.asked).toBe("Check flights");
    expect(next.source).toBe("text");
    expect(next.said).toEqual(["Checking flights now."]);
    expect(next.streamingText).toBe("Found two ");
    expect(next.streamingReasoning).toBe("Comparing times");
    expect(next.calls).toEqual(snap.calls);
    expect(next.opened).toEqual(["web"]);
    expect(next.deferredApprovals).toEqual([DEFERRED_APPROVAL_1]);
    expect(next.activeSubagents).toEqual(snap.activeSubagents);
    expect(next.pending).toBeNull();
    expect(next.error).toBeNull();
  });

  test("reset atomically replaces live state with event.live (wiping discarded retry/route-fallback tokens, said, and failed tools)", () => {
    const dirty: LiveTurn = {
      ...EMPTY_LIVE_TURN,
      turnId: "turn-retry-1",
      asked: "Book Friday lunch",
      source: "text",
      said: ["First broken attempt sentence"],
      streamingText: "Discarded partial output from primary route...",
      streamingReasoning: "Bad chain of thought",
      calls: [
        {
          id: "call-failed",
          name: "calendar.list",
          arg: "Friday",
          duration: "0.9s",
          kind: "read",
          ok: false,
          status: "failed",
        },
      ],
      opened: ["wrong_group"],
      pending: BLOCKING_APPROVAL,
      error: "transient primary error",
    };

    const cleanAttempt: LiveTurnSnapshot = {
      turnId: "turn-retry-1",
      asked: "Book Friday lunch",
      source: "text",
      said: [],
      streamingText: "",
      streamingReasoning: "",
      calls: [],
      opened: [],
      pending: null,
      deferredApprovals: [DEFERRED_APPROVAL_1],
      activeSubagents: [{ id: "sa-1", name: "planner", status: "running", current: null }],
      error: null,
    };

    const afterAttemptReset = apply(dirty, {
      type: "reset",
      scope: "attempt",
      reason: "route_advanced",
      live: cleanAttempt,
    });

    expect(afterAttemptReset.streamingText).toBe("");
    expect(afterAttemptReset.streamingReasoning).toBe("");
    expect(afterAttemptReset.said).toEqual([]);
    expect(afterAttemptReset.calls).toEqual([]);
    expect(afterAttemptReset.opened).toEqual([]);
    expect(afterAttemptReset.pending).toBeNull();
    expect(afterAttemptReset.error).toBeNull();
    expect(afterAttemptReset.deferredApprovals).toEqual([DEFERRED_APPROVAL_1]);
    expect(afterAttemptReset.activeSubagents).toEqual(cleanAttempt.activeSubagents);

    // Step-scoped retry preserves earlier committed tool calls from event.live while wiping discarded tokens
    const stepSnapshot: LiveTurnSnapshot = {
      ...cleanAttempt,
      calls: [
        {
          id: "call-good",
          name: "calendar.list",
          arg: "Friday",
          duration: "0.2s",
          kind: "read",
          ok: true,
          status: "completed",
        },
      ],
    };
    const withPartial = apply(afterAttemptReset, { type: "delta", text: "Cut-off retry text" });
    const afterStepReset = apply(withPartial, {
      type: "reset",
      scope: "step",
      reason: "retry",
      live: stepSnapshot,
    });
    expect(afterStepReset.streamingText).toBe("");
    expect(afterStepReset.calls).toEqual(stepSnapshot.calls);
  });

  test("tool_start inserts running call and tool_end updates matching call by id in place, preserving parallel order", () => {
    let state: LiveTurn = { ...EMPTY_LIVE_TURN, asked: "Read three sources" };

    state = apply(state, { type: "tool_start", id: "call-1", name: "calendar.list", kind: "read", arg: "week" });
    state = apply(state, { type: "tool_start", id: "call-2", name: "reminders.list", kind: "read", arg: "open" });
    state = apply(state, { type: "tool_start", id: "call-3", name: "okf.read", kind: "read", arg: "contact/ferris" });

    expect(state.calls).toHaveLength(3);
    expect(state.calls.map((c) => [c.id, c.status])).toEqual([
      ["call-1", "running"],
      ["call-2", "running"],
      ["call-3", "running"],
    ]);

    // Finish out of order: call-3 (ok), call-1 (failed), call-2 (ok)
    state = apply(state, {
      type: "tool_end",
      id: "call-3",
      name: "okf.read",
      kind: "read",
      arg: "contact/ferris",
      duration: "0.1s",
      ok: true,
    });
    state = apply(state, {
      type: "tool_end",
      id: "call-1",
      name: "calendar.list",
      kind: "read",
      arg: "week",
      duration: "0.6s",
      ok: false,
    });
    state = apply(state, {
      type: "tool_end",
      id: "call-2",
      name: "reminders.list",
      kind: "read",
      arg: "open",
      duration: "0.4s",
      ok: true,
    });

    // Order preserved, no duplicates, each updated in place
    expect(state.calls).toHaveLength(3);
    expect(state.calls.map((c) => c.id)).toEqual(["call-1", "call-2", "call-3"]);
    expect(state.calls[0]).toMatchObject({
      id: "call-1",
      name: "calendar.list",
      duration: "0.6s",
      ok: false,
      status: "failed",
    });
    expect(state.calls[1]).toMatchObject({
      id: "call-2",
      name: "reminders.list",
      duration: "0.4s",
      ok: true,
      status: "completed",
    });
    expect(state.calls[2]).toMatchObject({
      id: "call-3",
      name: "okf.read",
      duration: "0.1s",
      ok: true,
      status: "completed",
    });

    // Fallback: tool_end without prior tool_start appends cleanly
    const withOrphanEnd = apply(state, {
      type: "tool_end",
      id: "call-4",
      name: "weather.get",
      kind: "read",
      arg: "NYC",
      duration: "0.2s",
      ok: true,
    });
    expect(withOrphanEnd.calls).toHaveLength(4);
    expect(withOrphanEnd.calls[3]).toMatchObject({
      id: "call-4",
      name: "weather.get",
      duration: "0.2s",
      ok: true,
      status: "completed",
    });
  });

  test("deferred_approval appends to deferredApprovals WITHOUT setting blocking pending", () => {
    const t1 = apply(EMPTY_LIVE_TURN, DEFERRED_APPROVAL_1);
    expect(t1.pending).toBeNull();
    expect(t1.deferredApprovals).toEqual([DEFERRED_APPROVAL_1]);

    const t2 = apply(t1, DEFERRED_APPROVAL_2);
    expect(t2.pending).toBeNull();
    expect(t2.deferredApprovals).toEqual([DEFERRED_APPROVAL_1, DEFERRED_APPROVAL_2]);
  });

  test("settled clears matching blocking pending OR removes matching deferredApprovals entry without clobbering others", () => {
    const bothOpen: LiveTurn = {
      ...EMPTY_LIVE_TURN,
      pending: BLOCKING_APPROVAL,
      deferredApprovals: [DEFERRED_APPROVAL_1, DEFERRED_APPROVAL_2],
    };

    // Settling a deferred approval removes ONLY that deferred entry and keeps blocking pending intact
    const afterDeferredSettled = apply(bothOpen, {
      type: "settled",
      decisionId: DEFERRED_APPROVAL_1.decisionId,
      outcome: "approved",
    });
    expect(afterDeferredSettled.pending).toEqual(BLOCKING_APPROVAL);
    expect(afterDeferredSettled.deferredApprovals?.map((d) => d.decisionId)).toEqual([
      DEFERRED_APPROVAL_2.decisionId,
    ]);

    // Settling the blocking approval clears pending and keeps remaining deferred approvals intact
    const afterBlockingSettled = apply(afterDeferredSettled, {
      type: "settled",
      decisionId: BLOCKING_APPROVAL.decisionId,
      outcome: "declined",
    });
    expect(afterBlockingSettled.pending).toBeNull();
    expect(afterBlockingSettled.deferredApprovals?.map((d) => d.decisionId)).toEqual([
      DEFERRED_APPROVAL_2.decisionId,
    ]);
  });

  test("subagent_status updates activeSubagents list", () => {
    const running = [
      { id: "sa-1", name: "researcher", status: "running", current: "reading okf notes" },
      { id: "sa-2", name: "planner", status: "running", current: "checking calendar" },
    ];
    const t1 = apply(EMPTY_LIVE_TURN, { type: "subagent_status", subagents: running });
    expect(t1.activeSubagents).toEqual(running);

    const t2 = apply(t1, { type: "subagent_status", subagents: [] });
    expect(t2.activeSubagents).toEqual([]);
  });

  test("cancelled clears pending approval and running tool state cleanly without setting error", () => {
    const active: LiveTurn = {
      ...EMPTY_LIVE_TURN,
      turnId: "turn-cancel-1",
      asked: "Do something long",
      pending: BLOCKING_APPROVAL,
      calls: [
        { id: "c-done", name: "calendar.list", arg: null, duration: "0.2s", kind: "read", ok: true, status: "completed" },
        { id: "c-run", name: "web.search", arg: "query", duration: "", kind: "read", ok: true, status: "running" },
      ],
      error: null,
    };

    const next = apply(active, { type: "cancelled", reason: "user" });
    expect(next.pending).toBeNull();
    expect(next.calls.every((c) => c.status !== "running")).toBe(true);
    expect(next.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Hook (`useChat`) tests against mocked persistent SSE transport
// ---------------------------------------------------------------------------

class MockSseStream {
  readonly body: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly encoder = new TextEncoder();
  aborted = false;
  closed = false;

  constructor(
    readonly conversationId: string,
    signal?: AbortSignal | null,
    options: { closeOnAbort?: boolean } = {},
  ) {
    this.body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.closed = true;
      },
    });

    if (signal) {
      const onAbort = () => {
        this.aborted = true;
        if (options.closeOnAbort !== false && !this.closed) {
          this.closed = true;
          try {
            this.controller.error(new DOMException("Aborted", "AbortError"));
          } catch {
            // Stream may already be closed.
          }
        }
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  }

  push(event: ChatEvent): void {
    if (this.closed) return;
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    this.controller.enqueue(this.encoder.encode(payload));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.close();
    } catch {
      // Ignore already-errored stream.
    }
  }
}

describe("useChat persistent SSE hook", () => {
  let browser: Window;
  let root: Root;
  let container: HTMLDivElement;
  let restore: Array<() => void>;
  let latest: ChatState;
  let createdSeq: number;
  let turnSeq: number;

  let streamsByConv: Map<string, MockSseStream[]>;
  let storedByConv: Map<string, ChatTurnRow[]>;
  let postedMessages: Array<{ conversationId: string; text: string }>;
  let postedCancels: string[];
  let postedDecisions: string[];
  let streamCloseOnAbort: boolean;

  function replace(target: object, key: string, value: unknown) {
    const prior = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    restore.push(() => {
      if (prior) Object.defineProperty(target, key, prior);
      else Reflect.deleteProperty(target, key);
    });
  }

  function latestStream(conversationId: string): MockSseStream | undefined {
    const list = streamsByConv.get(conversationId);
    return list?.at(-1);
  }

  async function flush(ticks = 6): Promise<void> {
    await act(async () => {
      for (let i = 0; i < ticks; i++) {
        await Promise.resolve();
      }
      await Bun.sleep(10);
    });
  }

  async function mountHook(): Promise<void> {
    function Harness() {
      latest = useChat("desktop");
      return null;
    }
    await act(async () => {
      root.render(createElement(Harness));
    });
    await flush();
  }

  beforeEach(() => {
    restore = [];
    createdSeq = 0;
    turnSeq = 0;
    streamsByConv = new Map();
    storedByConv = new Map();
    postedMessages = [];
    postedCancels = [];
    postedDecisions = [];
    streamCloseOnAbort = true;

    browser = new Window({ url: "http://localhost:3000" });
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      ResizeObserver: browser.ResizeObserver,
      getComputedStyle: browser.getComputedStyle.bind(browser),
      requestAnimationFrame: (): number => 0,
      cancelAnimationFrame: () => {},
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      replace(globalThis, key, value);
    }

    replace(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(rawUrl, "http://localhost:3000");
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.pathname;

      // POST /api/chat — create conversation
      if (path === "/api/chat" && method === "POST") {
        const id = `conv-${++createdSeq}`;
        if (!storedByConv.has(id)) storedByConv.set(id, []);
        return Response.json({ conversationId: id }, { status: 201 });
      }

      // GET /api/chat — list conversations
      if (path === "/api/chat" && method === "GET") {
        const listPayload: ChatListPayload = {
          conversations: [...storedByConv.keys()].map((id) => ({
            id,
            title: id,
            lede: "",
            when: "now",
            state: "idle",
          })),
          lede: "Your conversations",
          restraint: null,
          waiting: 0,
        };
        return Response.json(listPayload);
      }

      // POST /api/chat/decisions — answer approval
      if (path === "/api/chat/decisions" && method === "POST") {
        const parsed = JSON.parse(String(init?.body ?? "{}")) as { actionId: string };
        postedDecisions.push(parsed.actionId);
        return Response.json({ decisionId: "dec-answered", outcome: "approved" });
      }

      // GET /api/chat/:id/stream — persistent SSE
      const streamMatch = /^\/api\/chat\/([^/]+)\/stream$/.exec(path);
      if (streamMatch && method === "GET") {
        const convId = decodeURIComponent(streamMatch[1]!);
        const sse = new MockSseStream(convId, init?.signal, { closeOnAbort: streamCloseOnAbort });
        const list = streamsByConv.get(convId) ?? [];
        list.push(sse);
        streamsByConv.set(convId, list);
        return new Response(sse.body, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            "x-accel-buffering": "no",
          },
        });
      }

      // POST /api/chat/:id/messages — accept turn (202)
      const msgMatch = /^\/api\/chat\/([^/]+)\/messages$/.exec(path);
      if (msgMatch && method === "POST") {
        const convId = decodeURIComponent(msgMatch[1]!);
        const parsed = JSON.parse(String(init?.body ?? "{}")) as { text: string };
        postedMessages.push({ conversationId: convId, text: parsed.text });
        return Response.json({ turnId: `turn-${++turnSeq}` }, { status: 202 });
      }

      // POST /api/chat/:id/cancel — cancel active turn (200)
      const cancelMatch = /^\/api\/chat\/([^/]+)\/cancel$/.exec(path);
      if (cancelMatch && method === "POST") {
        const convId = decodeURIComponent(cancelMatch[1]!);
        postedCancels.push(convId);
        return Response.json({ cancelled: true });
      }

      // GET /api/chat/:id — conversation payload
      const chatMatch = /^\/api\/chat\/([^/]+)$/.exec(path);
      if (chatMatch && method === "GET") {
        const convId = decodeURIComponent(chatMatch[1]!);
        const payload: ChatPayload = {
          conversationId: convId,
          title: convId,
          lede: "",
          restraint: null,
          turns: storedByConv.get(convId) ?? [],
          waiting: 0,
          model: "google/gemma-4-26b-a4b-qat",
          voiceInvoked: false,
        };
        return Response.json(payload);
      }

      throw new Error(`Unexpected fetch in chat.stream.test.ts: ${method} ${path}`);
    });

    container = browser.document.createElement("div") as unknown as HTMLDivElement;
    browser.document.body.append(container as never);
    root = createRoot(container);
  });

  afterEach(async () => {
    for (const list of streamsByConv.values()) {
      for (const s of list) s.close();
    }
    await act(async () => root.unmount());
    await browser.happyDOM.close();
    for (const undo of restore.reverse()) undo();
  });

  test("opens persistent GET /api/chat/:id/stream on mount and hydrates in-flight snapshot", async () => {
    await mountHook();
    expect(latest.openId).toBe("conv-1");

    const stream = latestStream("conv-1");
    expect(stream).toBeDefined();

    const snap: LiveTurnSnapshot = {
      turnId: "turn-inflight",
      asked: "Check Thursday",
      source: "text",
      said: [],
      streamingText: "Checking Thursday afternoon...",
      streamingReasoning: "",
      calls: [
        { id: "c-1", name: "calendar.list", arg: "Thu", duration: "", kind: "read", ok: true, status: "running" },
      ],
      opened: ["calendar"],
      pending: null,
      deferredApprovals: [],
      activeSubagents: [],
      error: null,
    };
    stream!.push({ type: "snapshot", live: snap });
    await flush();

    expect(latest.live?.turnId).toBe("turn-inflight");
    expect(latest.live?.streamingText).toBe("Checking Thursday afternoon...");
    expect(latest.live?.calls[0]?.status).toBe("running");
  });

  test("streams deltas live over persistent SSE without duplicating messages when message commits to stored", async () => {
    await mountHook();
    const stream = latestStream("conv-1");
    expect(stream).toBeDefined();

    stream!.push({ type: "snapshot", live: null });
    await flush();

    // Send triggers 202 POST /messages; live frames arrive on the persistent GET /stream
    await act(async () => {
      latest.send("What is on my calendar?");
    });
    await flush();

    expect(postedMessages).toEqual([{ conversationId: "conv-1", text: "What is on my calendar?" }]);

    stream!.push({ type: "turn_start", turnId: "turn-1", asked: "What is on my calendar?", source: "text" });
    stream!.push({ type: "delta", text: "You have " });
    await flush();
    expect(latest.live?.streamingText).toBe("You have ");

    stream!.push({ type: "delta", text: "one meeting at 3pm." });
    await flush();
    expect(latest.live?.streamingText).toBe("You have one meeting at 3pm.");

    // Server commits turn to DB before emitting `message`
    storedByConv.set("conv-1", [
      {
        id: "u-1",
        by: "user",
        body: "What is on my calendar?",
        at: "09:30",
        note: null,
        toolSummary: null,
        calls: [],
        approval: null,
        source: "text",
      },
      {
        id: "a-1",
        by: "agent",
        body: "You have one meeting at 3pm.",
        at: "09:30",
        note: null,
        toolSummary: null,
        calls: [],
        approval: null,
        source: "text",
      },
    ]);
    stream!.push({
      type: "message",
      messageId: "a-1",
      body: "You have one meeting at 3pm.",
      note: null,
      toolSummary: null,
      source: "text",
    });
    await flush();

    // Live copy cleared; stored holds the committed message once (zero duplication!)
    expect(latest.live).toBeNull();
    const matchingStored = latest.stored.filter((t) => t.body === "You have one meeting at 3pm.");
    expect(matchingStored).toHaveLength(1);
    // Persistent stream remains open for subsequent turns
    expect(stream!.aborted).toBe(false);
  });

  test("reset frame wipes discarded retry/route-fallback tokens and failed tools live", async () => {
    await mountHook();
    const stream = latestStream("conv-1");
    expect(stream).toBeDefined();

    stream!.push({ type: "snapshot", live: null });
    stream!.push({ type: "turn_start", turnId: "turn-r", asked: "Draft summary", source: "text" });
    stream!.push({ type: "delta", text: "Wrong route partial tokens" });
    stream!.push({ type: "tool_start", id: "c-bad", name: "okf.read", kind: "read", arg: "x" });
    stream!.push({ type: "tool_end", id: "c-bad", name: "okf.read", kind: "read", arg: "x", duration: "0.3s", ok: false });
    await flush();

    expect(latest.live?.streamingText).toBe("Wrong route partial tokens");
    expect(latest.live?.calls).toHaveLength(1);

    stream!.push({
      type: "reset",
      scope: "attempt",
      reason: "route_advanced",
      live: {
        turnId: "turn-r",
        asked: "Draft summary",
        source: "text",
        said: [],
        streamingText: "",
        streamingReasoning: "",
        calls: [],
        opened: [],
        pending: null,
        deferredApprovals: [],
        activeSubagents: [],
        error: null,
      },
    });
    stream!.push({ type: "delta", text: "Clean fallback answer." });
    await flush();

    expect(latest.live?.streamingText).toBe("Clean fallback answer.");
    expect(latest.live?.calls).toEqual([]);
  });

  test("async onAutoTurn renders automatically with zero user input and leaves composer unlocked", async () => {
    await mountHook();
    const stream = latestStream("conv-1");
    expect(stream).toBeDefined();

    stream!.push({ type: "snapshot", live: null });
    await flush();
    expect(latest.live).toBeNull();
    expect(postedMessages).toHaveLength(0);

    // Background subagent finishes and triggers an async auto-turn without any user send()
    stream!.push({
      type: "subagent_status",
      subagents: [{ id: "sa-1", name: "researcher", status: "running", current: "synthesizing" }],
    });
    stream!.push({ type: "turn_start", turnId: "turn-auto-1", asked: "", source: "subagent" });
    stream!.push({ type: "delta", text: "Background research finished: " });
    stream!.push({ type: "delta", text: "3 flights matched." });
    await flush();

    expect(latest.live?.source).toBe("subagent");
    expect(latest.live?.streamingText).toBe("Background research finished: 3 flights matched.");

    storedByConv.set("conv-1", [
      {
        id: "auto-msg-1",
        by: "agent",
        body: "Background research finished: 3 flights matched.",
        at: "09:42",
        note: null,
        toolSummary: null,
        calls: [],
        approval: null,
        source: "subagent",
      },
    ]);
    stream!.push({ type: "subagent_status", subagents: [] });
    stream!.push({
      type: "message",
      messageId: "auto-msg-1",
      body: "Background research finished: 3 flights matched.",
      note: null,
      toolSummary: null,
      source: "subagent",
    });
    await flush();

    expect(latest.stored.some((t) => t.body === "Background research finished: 3 flights matched.")).toBe(true);
    expect(latest.live).toBeNull();

    // Composer is cleanly unlocked: sending immediately works
    await act(async () => {
      latest.send("Book the morning flight");
    });
    await flush();
    expect(postedMessages).toEqual([{ conversationId: "conv-1", text: "Book the morning flight" }]);
  });

  test("deferred subagent approval arrives without locking composer and settles via answer()", async () => {
    await mountHook();
    const stream = latestStream("conv-1");
    expect(stream).toBeDefined();

    stream!.push({ type: "snapshot", live: null });
    stream!.push(DEFERRED_APPROVAL_1);
    await flush();

    expect(latest.live?.deferredApprovals).toEqual([DEFERRED_APPROVAL_1]);
    expect(latest.live?.pending).toBeNull();

    // Composer stays unlocked even while deferred approval is open
    await act(async () => {
      latest.send("Meanwhile check weather");
    });
    await flush();
    expect(postedMessages).toEqual([{ conversationId: "conv-1", text: "Meanwhile check weather" }]);

    // Answering deferred approval posts opaque actionId and clears once `settled` arrives
    await act(async () => {
      latest.answer("act-def1-yes");
    });
    await flush();
    expect(postedDecisions).toEqual(["act-def1-yes"]);

    stream!.push({ type: "settled", decisionId: DEFERRED_APPROVAL_1.decisionId, outcome: "approved" });
    await flush();
    expect(latest.live?.deferredApprovals ?? []).toEqual([]);
  });

  test("switching conversations aborts old SSE stream and opens new stream without leaking events across conversations", async () => {
    storedByConv.set("conv-2", []);
    // Keep stream1 controller open after abort to verify late buffered chunks cannot leak into conv-2.
    streamCloseOnAbort = false;

    await mountHook();
    const stream1 = latestStream("conv-1");
    expect(stream1).toBeDefined();

    stream1!.push({ type: "snapshot", live: null });
    stream1!.push({ type: "turn_start", turnId: "t-c1", asked: "Hello conv 1", source: "text" });
    stream1!.push({ type: "delta", text: "Reply in conv-1" });
    await flush();
    expect(latest.live?.streamingText).toBe("Reply in conv-1");

    // Switch to conv-2
    await act(async () => {
      latest.open("conv-2");
    });
    await flush();

    expect(latest.openId).toBe("conv-2");
    expect(stream1!.aborted).toBe(true);

    const stream2 = latestStream("conv-2");
    expect(stream2).toBeDefined();

    // Late in-flight frame arriving on stream1 MUST NOT leak into conv-2
    stream1!.push({ type: "delta", text: "LEAKED FROM CONV-1" });
    await flush();
    expect(latest.live?.streamingText ?? "").not.toContain("LEAKED FROM CONV-1");

    // Events on stream2 render normally in conv-2
    stream2!.push({ type: "snapshot", live: null });
    stream2!.push({ type: "turn_start", turnId: "t-c2", asked: "Hello conv 2", source: "text" });
    stream2!.push({ type: "delta", text: "Reply in conv-2" });
    await flush();
    expect(latest.live?.streamingText).toBe("Reply in conv-2");
  });

  test("cancel() posts to POST /api/chat/:id/cancel and cancelled event unlocks the conversation", async () => {
    await mountHook();
    const stream = latestStream("conv-1");
    expect(stream).toBeDefined();

    stream!.push({ type: "snapshot", live: null });
    await flush();

    await act(async () => {
      latest.send("Long running task");
    });
    await flush();

    stream!.push({ type: "turn_start", turnId: "t-cancel", asked: "Long running task", source: "text" });
    stream!.push({ type: "tool_start", id: "c-slow", name: "web.search", kind: "read", arg: "deep" });
    await flush();

    const cancellable = latest as ChatState & { cancel?: () => void };
    expect(typeof cancellable.cancel).toBe("function");
    await act(async () => {
      cancellable.cancel!();
    });
    await flush();
    expect(postedCancels).toEqual(["conv-1"]);

    stream!.push({ type: "cancelled", reason: "user" });
    await flush();

    expect(
      latest.live === null ||
        (latest.live.pending === null && latest.live.calls.every((c) => c.status !== "running")),
    ).toBe(true);

    // Subsequent send succeeds cleanly after cancellation
    await act(async () => {
      latest.send("Never mind, do something else");
    });
    await flush();
    expect(postedMessages.at(-1)).toEqual({
      conversationId: "conv-1",
      text: "Never mind, do something else",
    });
  });
});
