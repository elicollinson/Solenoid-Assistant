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
  /** What you just said, drawn immediately rather than after the round trip. */
  asked: string;
  /** The agent's sentences so far — the ones before each act. */
  said: string[];
  calls: ChatToolCall[];
  opened: string[];
  pending: Extract<ChatEvent, { type: "approval" }> | null;
  /** Set once, at the end. The turn is over when this is non-null. */
  error: string | null;
}

const EMPTY: LiveTurn = { asked: "", said: [], calls: [], opened: [], pending: null, error: null };

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
  lede: string;
  restraint: string | null;
  /** How many conversations are waiting on you. */
  waiting: number;
  /** The turn in flight, or null between turns. */
  live: LiveTurn | null;
  /** Open one, or pass null to go back to the list. */
  open(id: string | null): void;
  /** Start a fresh one and open it. */
  start(): void;
  /**
   * Say something into the open conversation. Starts one first if there is
   * none, which is what the ask dock does from another screen entirely.
   */
  send(text: string): void;
  /** Press a button on the approval the run is waiting on. */
  answer(actionId: string): void;
  /** Re-read from the server. */
  reload(): void;
}

/**
 * Parse an SSE body by hand.
 *
 * `EventSource` is not usable here for one flat reason: it only issues GET, and
 * this is a POST with a body. The framing is small enough to read — records
 * separated by a blank line, `data:` lines joined — and doing it here keeps the
 * whole exchange on one connection rather than inventing a message id to fetch
 * a stream for.
 */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatEvent> {
  const reader = body.getReader();
  // Decoded here rather than through TextDecoderStream: `stream: true` is the
  // part that matters, and it holds a partial multi-byte character back until
  // the rest of it arrives instead of emitting a replacement character in the
  // middle of a word.
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf("\n\n");
    while (cut !== -1) {
      const record = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = record
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
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
  // Whether you have picked a conversation yourself. See the effect below.
  const chosen = useRef(false);

  const q = surface === "desktop" ? "" : `?surface=${surface}`;
  const reload = useCallback(() => setNonce((n) => n + 1), []);

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

  /** Leaving a conversation drops the turn on screen with it. */
  const open = useCallback((id: string | null) => {
    chosen.current = true;
    setOpenId(id);
    setLive(null);
  }, []);

  /**
   * Land in the newest conversation rather than on an empty canvas.
   *
   * Once, and only before you have navigated: `chosen` is what stops it
   * dragging you back into a thread the moment you press the back link, which
   * is what a plain `openId ?? conversations[0]` would do on every render.
   */
  useEffect(() => {
    if (chosen.current || openId || !list?.conversations.length) return;
    chosen.current = true;
    setOpenId(list.conversations[0]!.id);
  }, [list, openId]);

  const start = useCallback(() => {
    void fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`the server answered ${response.status}`);
        const { conversationId } = (await response.json()) as { conversationId: string };
        chosen.current = true;
        setLive(null);
        setOpenId(conversationId);
        reload();
      })
      .catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error));
      });
  }, [reload]);

  const send = useCallback(
    (text: string) => {
      const said = text.trim();
      if (!said || running.current) return;
      running.current = true;
      setLive({ ...EMPTY, asked: said });

      void (async () => {
        try {
          // "latest" rather than an id when nothing is open: the ask dock sends
          // from a screen that has never loaded a conversation, and the server
          // starting one is a round trip this does not have to make.
          const target = openId ?? "latest";
          const response = await fetch(`/api/chat/${encodeURIComponent(target)}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: said }),
          });
          if (!response.ok || !response.body) {
            throw new Error(`the server answered ${response.status}`);
          }
          for await (const event of readEvents(response.body)) {
            setLive((current) => (current ? apply(current, event) : current));
            // The turn's prose is written down by the time this arrives, so the
            // stored transcript is now the truth and the live one is a
            // duplicate. Dropping it here rather than on the re-read avoids the
            // frame where both are on screen.
            if (event.type === "message") {
              setLive(null);
              reload();
            }
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          setLive((current) => (current ? { ...current, error: message } : current));
        } finally {
          running.current = false;
        }
      })();
    },
    [openId, reload],
  );

  /**
   * Answer the question the run is sitting on.
   *
   * The bubble's buttons go the moment you press one — the run is already
   * moving — and a refusal puts them back, because a 409 means somebody
   * answered it somewhere else and a re-read will say what they chose.
   */
  const answer = useCallback(
    (actionId: string) => {
      setLive((current) => (current ? { ...current, pending: null } : current));
      void fetch("/api/chat/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId }),
      }).then((response) => {
        if (!response.ok) reload();
      });
    },
    [reload],
  );

  return {
    status: failure ? "error" : list ? "ready" : "loading",
    message: failure ?? "",
    conversations: list?.conversations ?? [],
    openId,
    title: payload?.title ?? null,
    stored: payload?.turns ?? [],
    lede: (payload ?? list)?.lede ?? "",
    restraint: (payload ?? list)?.restraint ?? null,
    waiting: list?.waiting ?? 0,
    live,
    open,
    start,
    send,
    answer,
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
 * One event, folded into the turn on screen.
 *
 * The `default` is not dead code. This runs against whatever the server is
 * actually streaming, which on a reload mid-deploy is not necessarily the
 * version this bundle was built from — and a fold that fell off the end of the
 * switch returned `undefined`, which `setLive` then wrote over the turn in
 * flight, taking it off the screen with nothing logged. An event this build
 * does not know is one to ignore.
 */
function apply(turn: LiveTurn, event: ChatEvent): LiveTurn {
  switch (event.type) {
    case "opened":
      return { ...turn, opened: [...turn.opened, event.group] };
    case "say":
      return { ...turn, said: [...turn.said, event.body] };
    case "tool":
      return {
        ...turn,
        calls: [...turn.calls, {
          name: event.name,
          arg: event.arg,
          duration: event.duration,
          kind: event.kind,
          ok: event.ok,
        }],
      };
    case "approval":
      return { ...turn, pending: event };
    case "settled":
      return { ...turn, pending: null };
    case "error":
      return { ...turn, error: event.message };
    case "message":
      return turn;
    default:
      return turn;
  }
}
