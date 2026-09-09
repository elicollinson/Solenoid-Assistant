// The app below 700px.
//
// Four destinations and no rail. Which four is the design's decision, not a
// shortage of room: Reminders and Recommendations have no phone screen drawn,
// and the design's own rule is absent rather than invented. Nothing here hints
// at them, so nothing here promises something a tap cannot deliver.
//
// Each tab fetches for itself. The alternative — reading all four here so the
// state could live in one place — would put four requests on the wire to draw
// one screen, on the frame least able to afford them.
import { useEffect, useRef, useState } from "react";
import { usePrefersDusk } from "../frame";
import {
  answerDeferredWrite as writeDeferred,
  pauseWorkflow,
  runWorkflow,
  useCalendar,
  useCalendarItem,
  useKnowledge,
  useKnowledgeObject,
  useHome,
  useWorkflow,
  useWorkflows,
  type HomeAction,
  type HomePayload,
  type WorkflowRunAccepted,
} from "../api";
import { isDeferredWrite, pendingDecisionFor, withoutResolved } from "../settle";
import { ActivityPhone } from "./ActivityPhone";
import { CalendarPhone } from "./CalendarPhone";
import { MemoryPhone } from "./MemoryPhone";
import { WorkflowsPhone, type WorkflowTrigger } from "./WorkflowsPhone";
import { ChatPhone } from "./ChatPhone";
import { useChat } from "../chat";
import { PhoneAlert, PhoneNotice, PhoneScreen, type PhoneTab } from "./chrome";

/** What each screen has open, kept per screen rather than as one field: coming
 *  back to Workflows should find the sheet you left open there. */
type OpenBy = Partial<Record<PhoneTab, string | null>>;

export function PhoneHome() {
  const dusk = usePrefersDusk();
  const [tab, setTab] = useState<PhoneTab>("Activity");
  const [open, setOpen] = useState<OpenBy>({});
  // What the ask dock was last used to say, if anything. It is handed to the
  // Chat tab, which starts a conversation with it and sends it — the design's
  // `seed`. Cleared once spent, so switching back to Chat later does not send
  // it a second time.
  const [seed, setSeed] = useState<string | null>(null);

  // A gate answered in the browser settles here, the same bargain the desktop
  // strikes: the entry turns done and the header recounts, and a reload puts
  // the question back. The one exception is below.
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set());

  // Which deferred write is being run right now, and what went wrong if it
  // was refused. The desktop keeps the same two, for the same reason: this is
  // the one button on the feed that DOES something rather than closing a
  // question, so it waits for the server and can be told no.
  const [pendingWrite, setPendingWrite] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [homeNonce, setHomeNonce] = useState(0);

  // A pause is written, not kept in this tab — the desktop's rule, and the
  // schedule's: what the row says is what the worker will honour. While the
  // write is out the button is held, and a refusal is put in front of you.
  const [pausing, setPausing] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [workflowsNonce, setWorkflowsNonce] = useState(0);

  const openOn = (screen: PhoneTab) => open[screen] ?? null;
  const setOpenOn = (screen: PhoneTab) => (id: string | null) => setOpen((current) => ({ ...current, [screen]: id }));

  const togglePause = (slug: string, paused: boolean) => {
    if (pausing) return;
    setPauseError(null);
    setPausing(slug);
    pauseWorkflow(slug, paused)
      .catch((error: unknown) => setPauseError(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        setWorkflowsNonce((n) => n + 1);
        setPausing(null);
      });
  };

  const resolve = (decisionId: string) => setResolved((current) => new Set(current).add(decisionId));

  /**
   * A deferred write, answered.
   *
   * The screen waits for the server here, unlike every other button. The
   * others close a question — true the instant you press them. This one runs
   * a tool that can still be refused by a rule narrowed since the run asked,
   * so moving the row first would show you a write as done that the server
   * was about to turn down. One at a time: these make real writes, and a
   * double tap is two.
   */
  const answerDeferred = (actionId: string, decisionId: string) => {
    if (pendingWrite) return;
    setWriteError(null);
    setPendingWrite(actionId);
    writeDeferred(actionId)
      .then(() => {
        resolve(decisionId);
        setHomeNonce((n) => n + 1);
      })
      .catch((error: unknown) => setWriteError(error instanceof Error ? error.message : String(error)))
      .finally(() => setPendingWrite(null));
  };

  /**
   * Where a button says to go.
   *
   * The desktop routes to any of its seven views. Here only four exist, so an
   * effect naming Reminders is dropped rather than half-followed — a tab bar
   * that jumped to a screen the phone does not draw would be worse than a
   * button that only settles what it settles.
   *
   * Settling is not done here. Which decision an action closes is a fact about
   * the feed, and the feed is two components down; each screen closes what it
   * can see and calls this for the rest.
   */
  const invoke = (action: HomeAction) => {
    const effect = action.effect as { view?: string; id?: string } | null;
    if (!effect || typeof effect.view !== "string" || !isTab(effect.view)) return;
    const view = effect.view;
    setTab(view);
    setOpen((current) => ({ ...current, [view]: effect.id ?? null }));
  };

  /** Said from another screen: go to Chat and let it start one with this. */
  const ask = (text: string) => {
    setSeed(text);
    setTab("Chat");
  };

  return (
    <div data-theme={dusk ? "dusk" : undefined} style={{ display: "contents" }}>
      {tab === "Chat" ? (
        <Chat onTab={setTab} seed={seed} onSeeded={() => setSeed(null)} />
      ) : null}
      {tab === "Activity" ? (
        <Activity
          tab={tab}
          onTab={setTab}
          onAsk={ask}
          nonce={homeNonce}
          resolved={resolved}
          writeError={writeError}
          onInvoke={invoke}
          onResolve={resolve}
          onDeferred={answerDeferred}
        />
      ) : null}
      {tab === "Calendar" ? (
        <Calendar tab={tab} onTab={setTab} onAsk={ask} openId={openOn("Calendar")} onOpen={setOpenOn("Calendar")} onInvoke={invoke} />
      ) : null}
      {tab === "Things I know" ? (
        <Memory tab={tab} onTab={setTab} onAsk={ask} openId={openOn("Things I know")} onOpen={setOpenOn("Things I know")} />
      ) : null}
      {tab === "Workflows" ? (
        <Workflows
          tab={tab}
          onTab={setTab}
          onAsk={ask}
          nonce={workflowsNonce}
          openSlug={openOn("Workflows")}
          onOpen={setOpenOn("Workflows")}
          pausing={pausing}
          pauseError={pauseError}
          writeError={writeError}
          onTogglePause={togglePause}
          onInvoke={invoke}
          onResolve={resolve}
          onDeferred={answerDeferred}
        />
      ) : null}
    </div>
  );
}

/** How often the open workflow asks again while a run is going. */
const RUNNING_TICK_MS = 2000;

const isTab = (view: string): view is PhoneTab =>
  view === "Chat" || view === "Activity" || view === "Calendar" ||
  view === "Things I know" || view === "Workflows";

type Chrome = { tab: PhoneTab; onTab: (tab: PhoneTab) => void; onAsk: (text: string) => void };

/**
 * Its own component so the live connection is opened when Chat is and closed
 * when it is — see the same note on the desktop's.
 *
 * `seed` is what the ask dock said on another screen. Started here rather than
 * there because starting a conversation and sending into it are two requests,
 * and the screen that owns the connection is the one that should make them.
 */
function Chat({
  onTab,
  seed,
  onSeeded,
}: {
  onTab: (tab: PhoneTab) => void;
  seed: string | null;
  onSeeded: () => void;
}) {
  const chat = useChat("phone");
  const { start, send } = chat;
  // Whether the seed is already on its way. The effect below re-runs when the
  // list lands, when the new conversation opens, and — in development — once
  // more on mount; without this each of those started a conversation of its
  // own, and the message went into whichever the auto-open reached first.
  const seeding = useRef(false);

  // Two steps and they cannot be one: a conversation has to exist before
  // anything can be said into it. `start` opens it and answers with its id,
  // and the seed goes into THAT one by name — not into whatever happens to be
  // open by the time the answer comes back.
  useEffect(() => {
    if (!seed || seeding.current) return;
    seeding.current = true;
    void start().then((id) => {
      if (id) send(seed, id);
      onSeeded();
      seeding.current = false;
    });
  }, [seed, start, send, onSeeded]);

  return <ChatPhone chat={chat} onTab={onTab} />;
}

function Activity({
  tab,
  onTab,
  onAsk,
  nonce,
  resolved,
  writeError,
  onInvoke,
  onResolve,
  onDeferred,
}: Chrome & {
  nonce: number;
  resolved: ReadonlySet<string>;
  writeError: string | null;
  onInvoke: (action: HomeAction) => void;
  onResolve: (id: string) => void;
  onDeferred: (actionId: string, decisionId: string) => void;
}) {
  const home = useHome("phone", nonce);
  const shown: HomePayload | null = home.status === "ready" ? withoutResolved(home.data, resolved) : null;

  // The desktop's rules, on the desktop's payload. A button that only goes
  // somewhere goes there and closes nothing: reading the draft is not an
  // answer to whether it should be sent. A deferred write goes to the server
  // and waits. Everything else settles here, and drops out of the header's
  // count as well as out of the entry — the lookup needs the payload, which
  // is why this is here rather than in PhoneHome.
  const settle = (action: HomeAction) => {
    if (action.effectKind === "navigate") {
      onInvoke(action);
      return;
    }
    const decisionId = action.decisionId ?? (home.status === "ready" ? pendingDecisionFor(home.data, action.id) : null);
    if (decisionId && (action.effectKind === "tool_call" || (home.status === "ready" && isDeferredWrite(home.data, action.id)))) {
      onDeferred(action.id, decisionId);
      return;
    }
    if (decisionId) onResolve(decisionId);
    onInvoke(action);
  };

  return (
    <PhoneScreen meta={home.status === "ready" ? home.data.rail.agent.line : undefined} tab={tab} onTab={onTab} onAsk={onAsk}>
      {home.status === "loading" ? <PhoneNotice label="Reading" text="Fetching what I did overnight." /> : null}
      {home.status === "error" ? (
        <PhoneNotice
          label="No answer"
          text={`I couldn't reach the API — ${home.message}. Start it with \`bun run start:server\`, and seed it with \`bun run db:seed\` if you haven't yet.`}
        />
      ) : null}
      {writeError ? (
        <PhoneAlert label="Not written">{writeError} Nothing changed; the question is still open.</PhoneAlert>
      ) : null}
      {shown ? <ActivityPhone home={shown} resolved={resolved} onInvoke={settle} /> : null}
    </PhoneScreen>
  );
}

function Calendar({
  tab,
  onTab,
  onAsk,
  openId,
  onOpen,
  onInvoke,
}: Chrome & { openId: string | null; onOpen: (id: string | null) => void; onInvoke: (action: HomeAction) => void }) {
  const list = useCalendar("phone");
  const one = useCalendarItem(openId);

  // No disc while a sheet is up: the design draws one or the other, and a
  // disc floating over a sheet sits on its last rows and its buttons.
  return (
    <PhoneScreen meta={list.status === "ready" ? list.data.range : undefined} tab={tab} onTab={onTab} onAsk={openId ? undefined : onAsk}>
      {list.status === "loading" ? <PhoneNotice label="Reading" text="Laying out your week." /> : null}
      {list.status === "error" ? <PhoneNotice label="No answer" text={`I couldn't read the week — ${list.message}.`} /> : null}
      {list.status === "ready" ? (
        <CalendarPhone calendar={list.data} detail={one} openId={openId} onOpen={onOpen} onInvoke={onInvoke} />
      ) : null}
    </PhoneScreen>
  );
}

function Memory({ tab, onTab, onAsk, openId, onOpen }: Chrome & { openId: string | null; onOpen: (id: string | null) => void }) {
  const list = useKnowledge("phone");
  const one = useKnowledgeObject(openId);
  const facts = list.status === "ready" ? list.data.rows.reduce((sum, row) => sum + row.facts, 0) : 0;

  return (
    <PhoneScreen meta={list.status === "ready" ? `${facts} facts` : undefined} tab={tab} onTab={onTab} onAsk={openId ? undefined : onAsk}>
      {list.status === "loading" ? <PhoneNotice label="Reading" text="Going through what I've written down." /> : null}
      {list.status === "error" ? <PhoneNotice label="No answer" text={`I couldn't read the store — ${list.message}.`} /> : null}
      {list.status === "ready" ? <MemoryPhone knowledge={list.data} detail={one} openId={openId} onOpen={onOpen} /> : null}
    </PhoneScreen>
  );
}

function Workflows({
  tab,
  onTab,
  onAsk,
  nonce,
  openSlug,
  onOpen,
  pausing,
  pauseError,
  writeError,
  onTogglePause,
  onInvoke,
  onResolve,
  onDeferred,
}: Chrome & {
  nonce: number;
  openSlug: string | null;
  onOpen: (slug: string | null) => void;
  pausing: string | null;
  pauseError: string | null;
  writeError: string | null;
  onTogglePause: (slug: string, paused: boolean) => void;
  onInvoke: (action: HomeAction) => void;
  onResolve: (id: string) => void;
  onDeferred: (actionId: string, decisionId: string) => void;
}) {
  // A run started here, and what came of asking. Held on this screen, as the
  // desktop holds them on its detail: leaving the tab drops them, and the
  // record — the run itself — is what comes back on the re-read.
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [opened, setOpened] = useState<WorkflowRunAccepted | null>(null);
  const [ticks, setTicks] = useState(0);

  const list = useWorkflows("phone", nonce + ticks);
  const one = useWorkflow(openSlug, "phone", nonce + ticks);
  const count = list.status === "ready" ? list.data.rows.length : 0;

  // The server cannot tell the browser that a run moved, so while the open
  // one is going the browser asks every two seconds, as the desktop does.
  const running = one.status === "ready" && one.data.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTicks((n) => n + 1), RUNNING_TICK_MS);
    return () => clearInterval(timer);
  }, [running]);

  const trigger: WorkflowTrigger = {
    pending: starting,
    error: refused,
    started: opened?.label ?? null,
    onClear: () => setRefused(null),
    onRun: (args) => {
      if (!openSlug) return;
      setStarting(true);
      setRefused(null);
      runWorkflow(openSlug, args)
        .then((accepted) => {
          setOpened(accepted);
          setTicks((n) => n + 1);
        })
        .catch((error: unknown) => setRefused(error instanceof Error ? error.message : String(error)))
        .finally(() => setStarting(false));
    },
  };

  // A gate's button closes the gate as well as doing whatever it says, so the
  // Activity feed stops asking about something answered here. A deferred
  // write is told apart by the pair, as on the feed: the gate that holds a
  // `tool_call` is one, and both of its buttons have to reach the server.
  const settle = (action: HomeAction) => {
    if (action.effectKind === "navigate") {
      onInvoke(action);
      return;
    }
    const gate = one.status === "ready" ? one.data.gate : null;
    const decisionId = action.decisionId ?? gate?.id ?? null;
    const deferred = Boolean(gate?.actions.some((a) => a.effectKind === "tool_call"));
    if (decisionId && deferred && (action.effectKind === "tool_call" || action.effectKind === "resolve")) {
      onDeferred(action.id, decisionId);
      return;
    }
    if (decisionId) onResolve(decisionId);
    onInvoke(action);
  };

  return (
    <PhoneScreen meta={list.status === "ready" ? `${count} workflows` : undefined} tab={tab} onTab={onTab} onAsk={openSlug ? undefined : onAsk}>
      {list.status === "loading" ? <PhoneNotice label="Reading" text="Listing everything I run." /> : null}
      {list.status === "error" ? <PhoneNotice label="No answer" text={`I couldn't list them — ${list.message}.`} /> : null}
      {pauseError ? <PhoneAlert label="Not changed">{pauseError} The schedule is as it was.</PhoneAlert> : null}
      {writeError ? (
        <PhoneAlert label="Not written">{writeError} Nothing changed; the question is still open.</PhoneAlert>
      ) : null}
      {list.status === "ready" ? (
        <WorkflowsPhone
          workflows={list.data}
          detail={one}
          openSlug={openSlug}
          onOpen={onOpen}
          busy={pausing !== null}
          onTogglePause={onTogglePause}
          onInvoke={settle}
          trigger={trigger}
        />
      ) : null}
    </PhoneScreen>
  );
}
