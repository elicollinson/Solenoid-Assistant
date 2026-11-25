// The chat's own client, apart from ./api.ts because it is not a fetch.
//
// Every other surface in this app reads a payload and draws it. This one holds
// a connection open while the agent works, and what arrives down it is not the
// answer but the working: a group opened, a tool called, and — the reason all
// of this exists — a question the run has stopped on and will not continue past
// until you answer it on a SECOND request.
//
// So the state here is a live turn rather than a Load<T>, and the transcript on
// screen is two things concatenated: what the server has written down, and what
// this turn has said since. They are kept apart deliberately. The stored half
// survives a reload and the live half does not, and pretending otherwise would
// have the page lose sentences on refresh with no explanation.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type {
  ChatConversationRow,
  ChatEvent,
  ChatListPayload,
  ChatPayload,
  ChatToolCall,
  ChatTurnRow,
  LiveTurnSnapshot,
  SubagentStatusItem,
} from "../../../src/shared/chat";
import type { Surface } from "../../../src/shared/surface";

export type * from "../../../src/shared/chat";

/**
 * The turn happening right now.
 *
 * `pending` is what makes the composer honest: while it is set, the agent is
 * not thinking about what you type next, it is waiting on the button above it.
 */
export interface LiveTurn {
  /** Optional server-assigned turn id for persistent SSE correlation. */
  turnId?: string;
  /** Whether this turn started from typed user text or an async subagent auto-turn. */
  source?: "text" | "subagent";
  /** What you just said, drawn immediately rather than after the round trip. */
  asked: string;
  /** The agent's sentences so far — the ones before each act. */
  said: string[];
  /** Live streaming prose accumulated from `delta` frames before `message` commits. */
  streamingText?: string;
  /** Live streaming reasoning accumulated from `reasoning_delta` frames. */
  streamingReasoning?: string;
  calls: ChatToolCall[];
  opened: string[];
  pending: Extract<ChatEvent, { type: "approval" }> | null;
  /** Non-blocking deferred approvals opened by background subagents (composer stays unlocked!). */
  deferredApprovals?: Array<Extract<ChatEvent, { type: "deferred_approval" }>>;
  /** Live background subagents attached to this conversation. */
  activeSubagents?: SubagentStatusItem[];
  /** Set once, at the end. The turn is over when this is non-null. */
  error: string | null;
}

export const EMPTY_LIVE_TURN: LiveTurn = {
  asked: "",
  said: [],
  streamingText: "",
  streamingReasoning: "",
  calls: [],
  opened: [],
  pending: null,
  deferredApprovals: [],
  activeSubagents: [],
  error: null,
};
const EMPTY: LiveTurn = EMPTY_LIVE_TURN;

/**
 * How the header names the model answering typed chat: the id without its
 * publisher, so "google/gemma-4-26b-a4b-qat" reads "gemma-4-26b-a4b-qat".
 * Null while the conversation has not loaded.
 */
export function modelLabel(model: string | null): string | null {
  return model ? model.slice(model.lastIndexOf("/") + 1) : null;
}

export interface ChatState {
  status: "loading" | "ready" | "error";
  message: string;
  /** Every conversation, newest first. */
  conversations: ChatConversationRow[];
  /** Which one is open, or null when the list is what is being shown. */
  openId: string | null;
  /** What it is called. Null while nothing has been said in it. */
  title: string | null;
  /** What the server has written down for the open one. */
  stored: ChatTurnRow[];
  model: string | null;
  voiceInvoked: boolean;
  lede: string;
  restraint: string | null;
  /** How many conversations are waiting on you. */
  waiting: number;
  /** The turn in flight, or null between turns. */
  live: LiveTurn | null;
  /** Open one, or pass null to go back to the list. */
  open(id: string | null): void;
  /** Start a fresh one and open it. Answers with its id, or null if the
   *  server refused — the failure is already on `message` by then. */
  start(): Promise<string | null>;
  /**
   * Say something into the open conversation — or into `into`, when the
   * caller has just started one and knows its id before this render does.
   * With neither, start a new conversation (or await the one being created).
   */
  send(text: string, into?: string): void;
  /** Press a button on the approval the run is waiting on. */
  answer(actionId: string): void;
  /** Cancel an active turn on the open conversation. */
  cancel?: () => void;
  /** Re-read from the server. */
  reload(): void;
}

/**
 * Parse an SSE body by hand.
 *
 * `EventSource` is avoided so we control headers, `AbortController` teardown,
 * and compatibility with both persistent `GET /stream` and fallback streaming
 * `POST /messages` responses.
 */
async function* readEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const reader = body.getReader();
  // Decoded here rather than through TextDecoderStream: `stream: true` holds a
  // partial multi-byte character back until the rest arrives instead of
  // emitting a replacement character in the middle of a word.
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
      reader.releaseLock();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done || signal?.aborted) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let cut = buffer.indexOf("\n\n");
      while (cut !== -1) {
        if (signal?.aborted) return;
        const record = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = record
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data) {
          try {
            yield JSON.parse(data) as ChatEvent;
          } catch {
            // A half-written frame is not worth ending a conversation over. The
            // stream is still framed correctly; only this record is unreadable.
          }
        }
        cut = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (signal?.aborted) return;
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Lock may already be released after cancel.
    }
  }
}

/** Whether `live` holds an actively running turn (as opposed to idle background overlays or a finished error). */
export function hasActiveTurn(live: LiveTurn | null): boolean {
  if (!live || live.error) return false;
  return Boolean(
    live.turnId ||
      live.asked ||
      live.source === "subagent" ||
      live.said.length > 0 ||
      live.streamingText ||
      live.streamingReasoning ||
      live.calls.length > 0 ||
      live.opened.length > 0 ||
      live.pending,
  );
}

function hasVisibleLiveState(live: LiveTurn): boolean {
  return Boolean(
    hasActiveTurn(live) ||
      live.error ||
      (live.deferredApprovals && live.deferredApprovals.length > 0) ||
      (live.activeSubagents && live.activeSubagents.length > 0),
  );
}

function preserveBackgroundOverlays(current: LiveTurn | null): LiveTurn | null {
  if (!current) return null;
  const remainingSubagents = (current.activeSubagents ?? []).filter((s) => s.status === "running");
  const remainingDeferred = current.deferredApprovals ?? [];
  if (remainingSubagents.length === 0 && remainingDeferred.length === 0) {
    return null;
  }
  return {
    ...emptyLiveTurn(),
    activeSubagents: remainingSubagents.map((s) => ({ ...s })),
    deferredApprovals: [...remainingDeferred],
  };
}

/**
 * The Chat surface's whole client.
 *
 * One hook rather than a read hook and a write function, because the two are
 * not independent here: a turn ends by writing a message the server now holds,
 * so finishing a turn means re-reading. Splitting them would put that
 * invalidation in every caller.
 */
export function useChat(surface: Surface = "desktop"): ChatState {
  const [list, setList] = useState<ChatListPayload | null>(null);
  const [payload, setPayload] = useState<ChatPayload | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [nonce, setNonce] = useState(0);
  // Guards the composer against a second send, and is checked rather than
  // `live` because state is a render behind and two quick returns would both
  // see null.
  const running = useRef(false);
  // True while POST /messages is awaiting its HTTP reply so an initial empty
  // SSE snapshot racing with the first send cannot wipe the optimistic turn.
  const pendingSend = useRef(false);
  // Always reflects the currently selected conversation synchronously so late
  // frames or async replies from a previous conversation are ignored.
  const openIdRef = useRef<string | null>(openId);
  openIdRef.current = openId;
  // StrictMode replays effects; one loaded app still creates just one chat.
  const initialized = useRef(false);
  const creating = useRef<Promise<string | null> | null>(null);

  const q = surface === "desktop" ? "" : `?surface=${surface}`;
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const handleEvent = useCallback(
    (event: ChatEvent) => {
      switch (event.type) {
        case "snapshot": {
          if (event.live) {
            const hydrated = apply(emptyLiveTurn(), event);
            running.current = hasActiveTurn(hydrated);
            setLive(hasVisibleLiveState(hydrated) ? hydrated : null);
          } else if (!pendingSend.current) {
            running.current = false;
            setLive(null);
          }
          return;
        }
        case "turn_start": {
          running.current = true;
          pendingSend.current = false;
          setLive((current) => apply(current ?? emptyLiveTurn(), event));
          return;
        }
        case "reset": {
          const next = apply(emptyLiveTurn(), event);
          running.current = hasActiveTurn(next);
          setLive(hasVisibleLiveState(next) ? next : null);
          return;
        }
        case "deferred_approval": {
          // Non-blocking: never locks `running.current`.
          setLive((current) => apply(current ?? emptyLiveTurn(), event));
          return;
        }
        case "settled": {
          setLive((current) => {
            if (!current) return null;
            const next = apply(current, event);
            return hasVisibleLiveState(next) ? next : null;
          });
          reload();
          return;
        }
        case "subagent_status": {
          // Background subagent progress never locks the composer.
          setLive((current) => {
            const next = apply(current ?? emptyLiveTurn(), event);
            return hasVisibleLiveState(next) ? next : null;
          });
          return;
        }
        case "message": {
          // The turn's prose is written down by the time this arrives, so the
          // stored transcript is now the truth and the live copy is dropped
          // (preserving any still-running background overlays).
          running.current = false;
          pendingSend.current = false;
          setLive((current) => preserveBackgroundOverlays(current));
          reload();
          return;
        }
        case "cancelled": {
          running.current = false;
          pendingSend.current = false;
          setLive((current) => {
            if (!current) return null;
            const applied = apply(current, event);
            return preserveBackgroundOverlays(applied);
          });
          reload();
          return;
        }
        case "error": {
          running.current = false;
          pendingSend.current = false;
          setLive((current) => apply(current ?? emptyLiveTurn(), event));
          return;
        }
        default: {
          setLive((current) => apply(current ?? emptyLiveTurn(), event));
        }
      }
    },
    [reload],
  );

  // The list. Re-read whenever a turn ends, because a turn changes the row it
  // belongs to — its stamp, its line, and whether it is waiting on you.
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/chat${q}`, { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`/api/chat answered ${response.status}`);
        setList((await response.json()) as ChatListPayload);
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [q, nonce]);

  // The open one. Null means the list is what is on screen, which is a real
  // destination on the phone and the empty state on the desktop.
  useEffect(() => {
    if (!openId) {
      setPayload(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/chat/${encodeURIComponent(openId)}${q}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`that conversation answered ${response.status}`);
        setPayload((await response.json()) as ChatPayload);
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [openId, q, nonce]);

  // Persistent SSE stream for the open conversation. Hydrates in-flight state
  // on connect and delivers streaming tokens, tool execution, subagent status,
  // deferred approvals, and async auto-turns without waiting for user input.
  useEffect(() => {
    if (!openId) return;
    const convId = openId;
    const controller = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = async () => {
      if (controller.signal.aborted || openIdRef.current !== convId) return;
      try {
        const response = await fetch(`/api/chat/${encodeURIComponent(convId)}/stream`, {
          signal: controller.signal,
          headers: { accept: "text/event-stream" },
        });
        if (controller.signal.aborted || openIdRef.current !== convId) return;
        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
          // Non-SSE response (e.g. a non-streaming stub or 404): exit cleanly.
          return;
        }
        attempt = 0;
        for await (const event of readEvents(response.body, controller.signal)) {
          if (controller.signal.aborted || openIdRef.current !== convId) return;
          handleEvent(event);
        }
        if (!controller.signal.aborted && openIdRef.current === convId) {
          const delay = Math.min(1000 * 2 ** attempt, 10_000);
          attempt += 1;
          reconnectTimer = setTimeout(() => {
            void connect();
          }, delay);
        }
      } catch {
        if (controller.signal.aborted || openIdRef.current !== convId) return;
        const delay = Math.min(1000 * 2 ** attempt, 10_000);
        attempt += 1;
        reconnectTimer = setTimeout(() => {
          void connect();
        }, delay);
      }
    };

    void connect();

    return () => {
      controller.abort();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    };
  }, [openId, handleEvent]);

  /** Leaving a conversation aborts its stream and drops the turn on screen with it. */
  const open = useCallback((id: string | null) => {
    openIdRef.current = id;
    running.current = false;
    pendingSend.current = false;
    setOpenId(id);
    setLive(null);
  }, []);

  const start = useCallback(() => {
    if (creating.current) return creating.current;
    const request = fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`the server answered ${response.status}`);
        const { conversationId } = (await response.json()) as { conversationId: string };
        openIdRef.current = conversationId;
        running.current = false;
        pendingSend.current = false;
        setFailure(null);
        setLive(null);
        setOpenId(conversationId);
        reload();
        return conversationId;
      })
      .catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error));
        return null;
      })
      .finally(() => { creating.current = null; });
    creating.current = request;
    return request;
  }, [reload]);

  // Never restore the server's newest chat on load. Navigation keeps this hook
  // mounted; a browser refresh gives it a fresh lifetime and a fresh conversation.
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void start();
  }, [start]);

  const send = useCallback(
    (text: string, into?: string) => {
      const said = text.trim();
      if (!said || running.current) return;
      running.current = true;
      pendingSend.current = true;
      setLive((current) => ({
        ...emptyLiveTurn(),
        asked: said,
        source: "text",
        deferredApprovals: [...(current?.deferredApprovals ?? [])],
        activeSubagents: (current?.activeSubagents ?? []).map((s) => ({ ...s })),
      }));

      void (async () => {
        let target: string | null = into ?? openIdRef.current;
        try {
          if (!target) {
            target = await start();
            if (!target) throw new Error("Could not start a conversation");
            // Creating the conversation clears live state; restore this first turn.
            running.current = true;
            pendingSend.current = true;
            setLive({ ...emptyLiveTurn(), asked: said, source: "text" });
          }
          const response = await fetch(`/api/chat/${encodeURIComponent(target)}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: said }),
          });
          pendingSend.current = false;
          if (!response.ok) {
            throw new Error(`the server answered ${response.status}`);
          }
          if (openIdRef.current !== target) return;
          const contentType = response.headers.get("content-type") ?? "";
          if (response.status === 202 || !contentType.includes("text/event-stream")) {
            // Persistent GET /api/chat/:id/stream delivers live frames and unlocks `running`.
            return;
          }
          if (!response.body) {
            running.current = false;
            return;
          }
          try {
            for await (const event of readEvents(response.body)) {
              if (openIdRef.current !== target) break;
              handleEvent(event);
            }
          } finally {
            running.current = false;
          }
        } catch (error: unknown) {
          pendingSend.current = false;
          running.current = false;
          if (target && openIdRef.current && openIdRef.current !== target) return;
          const message = error instanceof Error ? error.message : String(error);
          setLive((current) =>
            current
              ? { ...current, error: message }
              : { ...emptyLiveTurn(), asked: said, source: "text", error: message },
          );
        }
      })();
    },
    [handleEvent, start],
  );

  /**
   * Answer a blocking approval or a non-blocking deferred subagent approval.
   *
   * Optimistically clears ONLY the matching approval (leaving any unrelated
   * blocking or deferred approvals untouched), posts the opaque actionId, and
   * reloads so stored approvals stay in sync.
   */
  const answer = useCallback(
    (actionId: string) => {
      setLive((current) => {
        if (!current) return current;
        const matchesPending = current.pending?.actions.some((a) => a.id === actionId) ?? false;
        const prevDeferred = current.deferredApprovals ?? [];
        const nextDeferred = prevDeferred.filter((d) => !d.actions.some((a) => a.id === actionId));
        const removedDeferred = nextDeferred.length !== prevDeferred.length;
        if (!matchesPending && !removedDeferred) return current;
        const next: LiveTurn = {
          ...current,
          pending: matchesPending ? null : current.pending,
          deferredApprovals: nextDeferred,
        };
        return hasVisibleLiveState(next) ? next : null;
      });
      void fetch("/api/chat/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId }),
      })
        .then(() => {
          reload();
        })
        .catch(() => {
          reload();
        });
    },
    [reload],
  );

  /** Request cancellation of an active turn on the open conversation. */
  const cancel = useCallback(() => {
    const target = openIdRef.current;
    if (!target) return;
    void fetch(`/api/chat/${encodeURIComponent(target)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    }).catch(() => {
      // Stream remains source of truth for cancelled state.
    });
  }, []);

  const currentPayload = payload?.conversationId === openId ? payload : null;

  return {
    status: failure ? "error" : list ? "ready" : "loading",
    message: failure ?? "",
    conversations: list?.conversations ?? [],
    openId,
    title: currentPayload?.title ?? null,
    stored: currentPayload?.turns ?? [],
    model: currentPayload?.model ?? null,
    voiceInvoked: Boolean(currentPayload?.voiceInvoked),
    lede: (currentPayload ?? list)?.lede ?? "",
    restraint: (currentPayload ?? list)?.restraint ?? null,
    waiting: list?.waiting ?? 0,
    live,
    open,
    start,
    send,
    answer,
    cancel,
    reload,
  };
}

/**
 * Keep a transcript at its foot while it grows, and let go when you scroll up.
 *
 * A dependency list cannot do this job and the first attempt proved it: an
 * effect keyed on "how many turns" fires the instant React commits, which is
 * before the browser has wrapped a word of it — so it scrolled to a height of
 * 449px and stopped, and the 2215px the transcript settled at arrived after
 * nothing was listening. Fonts, images and a streaming turn all land the same
 * way.
 *
 * So the trigger is the content's own size, watched. And it stops following the
 * moment you scroll away from the bottom, because being yanked back down while
 * reading what the agent did an hour ago is worse than not following at all.
 *
 * The moves are instant, and that is load-bearing rather than a preference. A
 * smooth scroll emits scroll events all the way down, and the listener below
 * cannot tell those from yours — so the second one unstuck the follower halfway
 * through its own animation and the transcript sat at 27px of 2215. Instant
 * emits one event, at the bottom, where the gap is zero.
 */
export function useFollowBottom(): {
  box: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
} {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = box.current;
    const inner = content.current;
    if (!node || !inner) return;

    // Whether we are still following. Starts true — a transcript you have just
    // opened is one you want the end of.
    let following = true;

    const onScroll = () => {
      const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
      // A few pixels of slack: sub-pixel layout means an untouched container
      // frequently reports a gap of 0.5 and would otherwise unstick itself.
      following = gap < 40;
    };
    const follow = () => {
      if (!following) return;
      node.scrollTop = node.scrollHeight;
    };

    node.addEventListener("scroll", onScroll, { passive: true });
    const watcher = new ResizeObserver(follow);
    watcher.observe(inner);
    follow();

    return () => {
      watcher.disconnect();
      node.removeEventListener("scroll", onScroll);
    };
  }, []);

  return { box, content };
}

/**
 * Whether the stored transcript already ends with what the live turn asked.
 *
 * The server writes your message down before it starts on the answer, so a
 * turn that then fails leaves it stored with no reply. A re-read in the
 * meantime — the phone's ask dock opens the conversation and sends in the
 * same breath — puts that stored copy on screen beside the live one, and the
 * same sentence is drawn twice. When it is, the live bubble is the copy.
 */
export function echoed(chat: Pick<ChatState, "stored" | "live">): boolean {
  const last = chat.stored.at(-1);
  return Boolean(chat.live && last && last.by === "user" && last.body === chat.live.asked);
}

/**
 * What the agent has said this turn, minus the sentence the gate is asking.
 *
 * The ask IS its last sentence — src/chat/session.ts uses it verbatim as the
 * approval's title, because a tool's own description is written for a model and
 * reads to a person as somebody else's manual. Drawing both puts the same line
 * on the page twice, three inches apart.
 */
export function spoken(live: LiveTurn): string {
  const said = live.pending && live.said.at(-1)?.trim() === live.pending.title
    ? live.said.slice(0, -1)
    : live.said;
  return said.join("\n\n");
}

/**
 * Combined live prose for a turn in flight: committed interim `say` sentences
 * plus live-streamed `streamingText` tokens, without duplicating an open gate's
 * title.
 */
export function liveProse(live: LiveTurn): string {
  const prior = spoken(live);
  const stream = live.streamingText ?? "";
  const duplicateOfPending = Boolean(live.pending && stream.trim() === live.pending.title);
  const activeStream = duplicateOfPending ? "" : stream;
  if (prior && activeStream) return `${prior}\n\n${activeStream}`;
  return prior || activeStream;
}

function emptyLiveTurn(): LiveTurn {
  return {
    ...EMPTY,
    said: [],
    calls: [],
    opened: [],
    deferredApprovals: [],
    activeSubagents: [],
  };
}

function fromSnapshot(snap: LiveTurnSnapshot): LiveTurn {
  return {
    turnId: snap.turnId,
    asked: snap.asked,
    source: snap.source,
    said: [...snap.said],
    streamingText: snap.streamingText,
    streamingReasoning: snap.streamingReasoning,
    calls: snap.calls.map((c) => ({ ...c })),
    opened: [...snap.opened],
    pending: snap.pending,
    deferredApprovals: [...snap.deferredApprovals],
    activeSubagents: snap.activeSubagents.map((s) => ({ ...s })),
    error: snap.error,
  };
}

function failRunningCalls(calls: readonly ChatToolCall[]): ChatToolCall[] {
  return calls.map((c) =>
    c.status === "running" ? { ...c, ok: false, status: "failed" as const } : c,
  );
}

/**
 * One event, folded into the turn on screen.
 *
 * The `default` is not dead code. This runs against whatever the server is
 * actually streaming, which on a reload mid-deploy is not necessarily the
 * version this bundle was built from — and a fold that fell off the end of the
 * switch returned `undefined`, which `setLive` then wrote over the turn in
 * flight, taking it off the screen with nothing logged. An event this build
 * does not know is one to ignore.
 */
export function apply(turn: LiveTurn, event: ChatEvent): LiveTurn {
  switch (event.type) {
    case "turn_start":
      return {
        ...emptyLiveTurn(),
        turnId: event.turnId,
        asked: event.asked,
        source: event.source,
        deferredApprovals: [...(turn.deferredApprovals ?? [])],
        activeSubagents: (turn.activeSubagents ?? []).map((s) => ({ ...s })),
      };
    case "snapshot":
      return event.live ? fromSnapshot(event.live) : emptyLiveTurn();
    case "delta":
      return {
        ...turn,
        streamingText: (turn.streamingText ?? "") + event.text,
      };
    case "reasoning_delta":
      return {
        ...turn,
        streamingReasoning: (turn.streamingReasoning ?? "") + event.text,
      };
    case "opened":
      return turn.opened.includes(event.group)
        ? turn
        : { ...turn, opened: [...turn.opened, event.group] };
    case "say":
      return {
        ...turn,
        said: [...turn.said, event.body],
        streamingText: "",
      };
    case "tool_start": {
      const nextCall: ChatToolCall = {
        id: event.id,
        name: event.name,
        arg: event.arg,
        duration: "",
        kind: event.kind,
        ok: true,
        status: "running",
      };
      const existingIdx = turn.calls.findIndex((c) => c.id === event.id);
      if (existingIdx !== -1) {
        const calls = [...turn.calls];
        calls[existingIdx] = nextCall;
        return { ...turn, calls };
      }
      return { ...turn, calls: [...turn.calls, nextCall] };
    }
    case "tool_end": {
      const updatedCall: ChatToolCall = {
        id: event.id,
        name: event.name,
        arg: event.arg,
        duration: event.duration,
        kind: event.kind,
        ok: event.ok,
        status: event.ok ? "completed" : "failed",
      };
      const existingIdx = turn.calls.findIndex((c) => c.id === event.id);
      if (existingIdx !== -1) {
        const calls = [...turn.calls];
        calls[existingIdx] = updatedCall;
        return { ...turn, calls };
      }
      return { ...turn, calls: [...turn.calls, updatedCall] };
    }
    case "tool":
      return {
        ...turn,
        calls: [...turn.calls, {
          name: event.name,
          arg: event.arg,
          duration: event.duration,
          kind: event.kind,
          ok: event.ok,
          status: event.ok ? "completed" : "failed",
        }],
      };
    case "reset":
      return fromSnapshot(event.live);
    case "approval":
      return { ...turn, pending: event };
    case "deferred_approval": {
      const existing = turn.deferredApprovals ?? [];
      if (existing.some((d) => d.decisionId === event.decisionId)) return turn;
      return { ...turn, deferredApprovals: [...existing, event] };
    }
    case "settled": {
      const pending =
        turn.pending && turn.pending.decisionId === event.decisionId ? null : turn.pending;
      const prevDeferred = turn.deferredApprovals ?? [];
      const nextDeferred = prevDeferred.filter((d) => d.decisionId !== event.decisionId);
      if (pending === turn.pending && nextDeferred.length === prevDeferred.length) {
        return turn;
      }
      return {
        ...turn,
        pending,
        deferredApprovals: nextDeferred,
      };
    }
    case "subagent_status":
      return {
        ...turn,
        activeSubagents: event.subagents.map((s) => ({ ...s })),
      };
    case "message":
      return turn;
    case "cancelled":
      return {
        ...turn,
        pending: null,
        calls: failRunningCalls(turn.calls),
      };
    case "error":
      return {
        ...turn,
        pending: null,
        calls: failRunningCalls(turn.calls),
        error: event.message,
      };
    default:
      return turn;
  }
}
