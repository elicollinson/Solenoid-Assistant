// The app below 700px.
//
// The desktop's seven destinations and no rail. Five of them are the tab bar,
// which is what the design drew; Reminders and Recommendations sit behind
// Calendar and Memory respectively — where the rail already groups them —
// with a segment row to move between the pair. Nothing the desktop can reach
// is out of reach here.
//
// Each tab fetches for itself. The alternative — reading everything here so
// the state could live in one place — would put seven requests on the wire to
// draw one screen, on the frame least able to afford them.
import { useEffect, useReducer, useRef, useState } from "react";
import { usePrefersDusk } from "../frame";
import {
  answerDeferredWrite as writeDeferred,
  answerRecommendation as writeAnswer,
  pauseWorkflow,
  runWorkflow,
  saveInstructions,
  saveWorkflowPermission,
  stopWorkflow,
  useCalendar,
  useCalendarItem,
  useKnowledge,
  useKnowledgeObject,
  useHome,
  useRecommendation,
  useRecommendations,
  useReminder,
  useReminders,
  useWorkflow,
  useWorkflows,
  type HomeAction,
  type HomePayload,
} from "../api";
import { isDeferredWrite, pendingDecisionFor, withoutResolved } from "../settle";
import type { LocalStance } from "../RecommendationsView";
import type { LocalMark } from "../RemindersView";
import { ActivityPhone } from "./ActivityPhone";
import { CalendarPhone } from "./CalendarPhone";
import { MemoryPhone } from "./MemoryPhone";
import { RecommendationsPhone } from "./RecommendationsPhone";
import { RemindersPhone } from "./RemindersPhone";
import { WorkflowsPhone, isSheetTab, type SheetTab, type WorkflowEdits, type WorkflowTrigger } from "./WorkflowsPhone";
import { NO_TRIGGER, triggerFor, triggerReducer } from "./trigger";
import { ChatPhone } from "./ChatPhone";
import { useChat } from "../chat";
import { PhoneAlert, PhoneNotice, PhoneScreen, PhoneSegments, isPhoneTab, type PhoneTab } from "./chrome";

/** What each screen has open, kept per screen rather than as one field: coming
 *  back to Workflows should find the sheet you left open there. */
type OpenBy = Partial<Record<PhoneTab, string | null>>;

export function PhoneHome() {
  const dusk = usePrefersDusk();
  const [tab, setTab] = useState<PhoneTab>("Activity");
  const [open, setOpen] = useState<OpenBy>({});
  // Which of the workflow sheet's four tabs is showing. Held here rather than
  // in the sheet so a feed button naming one — "Trace" — opens it there, and
  // so coming back to Workflows finds the tab you left.
  const [workflowTab, setWorkflowTab] = useState<SheetTab>("Summary");
  // What the ask dock was last used to say, if anything. It is handed to the
  // Chat tab, which starts a conversation with it and sends it — the design's
  // `seed`. Cleared once spent, so switching back to Chat later does not send
  // it a second time.
  const [seed, setSeed] = useState<string | null>(null);

  // A gate answered in the browser settles here, the same bargain the desktop
  // strikes: the entry turns done and the header recounts, and a reload puts
  // the question back. The one exception is below.
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set());
  // Same bargain for a reminder closed or pushed, as on the desktop: nothing
  // writes those yet, so the mark lives here and reverts on reload.
  const [reminderMarks, setReminderMarks] = useState<ReadonlyMap<string, LocalMark>>(() => new Map());
  // A suggestion answered here moves at once and the write follows; a refusal
  // takes the answer back. See `answerRecommendation`.
  const [recommendationStances, setRecommendationStances] = useState<ReadonlyMap<string, LocalStance>>(() => new Map());

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

  const markReminder = (id: string, mark: LocalMark) => setReminderMarks((current) => new Map(current).set(id, mark));

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
        // Both surfaces draw the gate this closed, and neither is polled
        // unless something is running: each has to be asked again.
        setHomeNonce((n) => n + 1);
        setWorkflowsNonce((n) => n + 1);
      })
      .catch((error: unknown) => setWriteError(error instanceof Error ? error.message : String(error)))
      .finally(() => setPendingWrite(null));
  };

  /**
   * Where a button says to go.
   *
   * Every one of the desktop's seven views has a screen here now, so an
   * effect naming any of them is followed: the tab, the thing it names, and
   * — for a workflow — which of the sheet's tabs to open on.
   *
   * Settling is not done here. Which decision an action closes is a fact about
   * the feed, and the feed is two components down; each screen closes what it
   * can see and calls this for the rest.
   */
  const invoke = (action: HomeAction) => {
    const effect = action.effect as { view?: string; id?: string; tab?: string } | null;
    if (!effect || typeof effect.view !== "string" || !isPhoneTab(effect.view)) return;
    const view = effect.view;
    setTab(view);
    setOpen((current) => ({ ...current, [view]: effect.id ?? null }));
    if (view === "Workflows") setWorkflowTab(typeof effect.tab === "string" && isSheetTab(effect.tab) ? effect.tab : "Summary");
  };

  /**
   * Answering a suggestion.
   *
   * The screen moves first and the write follows, as on the desktop. An answer
   * is one tap and the row it moves is right under your thumb, so waiting for
   * the server would show you a button that looks unpressed for as long as
   * the round trip takes. If the write is refused — you answered it on the
   * desktop, or I withdrew it while this screen was open — the row goes back
   * to asking, which is the truth: the next read would put it back anyway.
   * The decision behind it closes too, so the feed stops asking on one
   * screen what you answered on another.
   */
  const answerRecommendation = (id: string, stance: LocalStance, _wasOpen: boolean, action: HomeAction) => {
    setRecommendationStances((current) => new Map(current).set(id, stance));
    if (action.decisionId) resolve(action.decisionId);
    invoke(action);
    writeAnswer(id, stance).catch(() => {
      setRecommendationStances((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    });
  };

  /** Said from another screen: go to Chat and let it start one with this. */
  const ask = (text: string) => {
    setSeed(text);
    setTab("Chat");
  };

  const goto = (next: PhoneTab) => () => setTab(next);

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
        <Calendar
          tab={tab}
          onTab={setTab}
          onAsk={ask}
          openId={openOn("Calendar")}
          onOpen={setOpenOn("Calendar")}
          onInvoke={invoke}
          onReminders={goto("Reminders")}
        />
      ) : null}
      {tab === "Reminders" ? (
        <Reminders
          tab={tab}
          onTab={setTab}
          onAsk={ask}
          openId={openOn("Reminders")}
          onOpen={setOpenOn("Reminders")}
          marks={reminderMarks}
          onMark={markReminder}
          onInvoke={invoke}
          onResolve={resolve}
          onCalendar={goto("Calendar")}
        />
      ) : null}
      {tab === "Things I know" ? (
        <Memory
          tab={tab}
          onTab={setTab}
          onAsk={ask}
          openId={openOn("Things I know")}
          onOpen={setOpenOn("Things I know")}
          onRecommendations={goto("Recommendations")}
        />
      ) : null}
      {tab === "Recommendations" ? (
        <Recommendations
          tab={tab}
          onTab={setTab}
          onAsk={ask}
          openId={openOn("Recommendations")}
          onOpen={setOpenOn("Recommendations")}
          stances={recommendationStances}
          onAnswer={answerRecommendation}
          onMemory={goto("Things I know")}
        />
      ) : null}
      {tab === "Workflows" ? (
        <Workflows
          tab={tab}
          onTab={setTab}
          onAsk={ask}
          nonce={workflowsNonce}
          openSlug={openOn("Workflows")}
          onOpen={setOpenOn("Workflows")}
          sheetTab={workflowTab}
          onSheetTab={setWorkflowTab}
          resolved={resolved}
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
  onReminders,
}: Chrome & {
  openId: string | null;
  onOpen: (id: string | null) => void;
  onInvoke: (action: HomeAction) => void;
  onReminders: () => void;
}) {
  const list = useCalendar("phone");
  const one = useCalendarItem(openId);

  // No disc while a sheet is up: the design draws one or the other, and a
  // disc floating over a sheet sits on its last rows and its buttons.
  return (
    <PhoneScreen meta={list.status === "ready" ? list.data.range : undefined} tab={tab} onTab={onTab} onAsk={openId ? undefined : onAsk}>
      <PhoneSegments
        items={[
          { label: "Week", selected: true, onSelect: () => {} },
          { label: "Reminders", selected: false, onSelect: onReminders },
        ]}
      />
      {list.status === "loading" ? <PhoneNotice label="Reading" text="Laying out your week." /> : null}
      {list.status === "error" ? <PhoneNotice label="No answer" text={`I couldn't read the week — ${list.message}.`} /> : null}
      {list.status === "ready" ? (
        <CalendarPhone calendar={list.data} detail={one} openId={openId} onOpen={onOpen} onInvoke={onInvoke} />
      ) : null}
    </PhoneScreen>
  );
}

function Reminders({
  tab,
  onTab,
  onAsk,
  openId,
  onOpen,
  marks,
  onMark,
  onInvoke,
  onResolve,
  onCalendar,
}: Chrome & {
  openId: string | null;
  onOpen: (id: string | null) => void;
  marks: ReadonlyMap<string, LocalMark>;
  onMark: (id: string, mark: LocalMark) => void;
  onInvoke: (action: HomeAction) => void;
  onResolve: (id: string) => void;
  onCalendar: () => void;
}) {
  const list = useReminders();
  const one = useReminder(openId);
  const due = list.status === "ready" ? list.data.rows.filter((r) => r.group === "Overdue" || r.group === "Today").length : 0;

  // A gate's button closes the gate as well as doing whatever it says, so the
  // Activity feed stops asking about something answered here.
  const settle = (action: HomeAction) => {
    if (one.status === "ready" && one.data.gate && action.effectKind !== "navigate") onResolve(one.data.gate.id);
    onInvoke(action);
  };

  return (
    <PhoneScreen meta={list.status === "ready" ? `${due} due` : undefined} tab={tab} onTab={onTab} onAsk={openId ? undefined : onAsk}>
      <PhoneSegments
        items={[
          { label: "Week", selected: false, onSelect: onCalendar },
          { label: "Reminders", selected: true, onSelect: () => {} },
        ]}
      />
      {list.status === "loading" ? <PhoneNotice label="Reading" text="Listing what I'm holding for you." /> : null}
      {list.status === "error" ? <PhoneNotice label="No answer" text={`I couldn't list them — ${list.message}.`} /> : null}
      {list.status === "ready" ? (
        <RemindersPhone
          reminders={list.data}
          detail={one}
          openId={openId}
          onOpen={onOpen}
          marks={marks}
          onMark={(id, mark) => onMark(id, mark)}
          onInvoke={settle}
        />
      ) : null}
    </PhoneScreen>
  );
}

function Memory({
  tab,
  onTab,
  onAsk,
  openId,
  onOpen,
  onRecommendations,
}: Chrome & { openId: string | null; onOpen: (id: string | null) => void; onRecommendations: () => void }) {
  const list = useKnowledge("phone");
  const one = useKnowledgeObject(openId);
  const facts = list.status === "ready" ? list.data.rows.reduce((sum, row) => sum + row.facts, 0) : 0;

  return (
    <PhoneScreen meta={list.status === "ready" ? `${facts} facts` : undefined} tab={tab} onTab={onTab} onAsk={openId ? undefined : onAsk}>
      <PhoneSegments
        items={[
          { label: "Memories", selected: true, onSelect: () => {} },
          { label: "Suggestions", selected: false, onSelect: onRecommendations },
        ]}
      />
      {list.status === "loading" ? <PhoneNotice label="Reading" text="Going through what I've written down." /> : null}
      {list.status === "error" ? <PhoneNotice label="No answer" text={`I couldn't read the store — ${list.message}.`} /> : null}
      {list.status === "ready" ? <MemoryPhone knowledge={list.data} detail={one} openId={openId} onOpen={onOpen} /> : null}
    </PhoneScreen>
  );
}

function Recommendations({
  tab,
  onTab,
  onAsk,
  openId,
  onOpen,
  stances,
  onAnswer,
  onMemory,
}: Chrome & {
  openId: string | null;
  onOpen: (id: string | null) => void;
  stances: ReadonlyMap<string, LocalStance>;
  onAnswer: (id: string, stance: LocalStance, wasOpen: boolean, action: HomeAction) => void;
  onMemory: () => void;
}) {
  const list = useRecommendations();
  const one = useRecommendation(openId);
  const waiting = list.status === "ready" ? list.data.rows.filter((r) => r.group === "Waiting on you" && !stances.has(r.id)).length : 0;

  return (
    <PhoneScreen meta={list.status === "ready" ? `${waiting} open` : undefined} tab={tab} onTab={onTab} onAsk={openId ? undefined : onAsk}>
      <PhoneSegments
        items={[
          { label: "Memories", selected: false, onSelect: onMemory },
          { label: "Suggestions", selected: true, onSelect: () => {} },
        ]}
      />
      {list.status === "loading" ? <PhoneNotice label="Reading" text="Listing what I'd change about how I work." /> : null}
      {list.status === "error" ? <PhoneNotice label="No answer" text={`I couldn't list them — ${list.message}.`} /> : null}
      {list.status === "ready" ? (
        <RecommendationsPhone recommendations={list.data} detail={one} openId={openId} onOpen={onOpen} stances={stances} onAnswer={onAnswer} />
      ) : null}
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
  sheetTab,
  onSheetTab,
  resolved,
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
  sheetTab: SheetTab;
  onSheetTab: (tab: SheetTab) => void;
  resolved: ReadonlySet<string>;
  pausing: string | null;
  pauseError: string | null;
  writeError: string | null;
  onTogglePause: (slug: string, paused: boolean) => void;
  onInvoke: (action: HomeAction) => void;
  onResolve: (id: string) => void;
  onDeferred: (actionId: string, decisionId: string) => void;
}) {
  // A run started here, and what came of asking — scoped to the workflow it
  // was asked for, and begun clean on every press. See ./trigger.ts for why.
  // Held on this screen, as the desktop holds it on its detail: leaving the
  // tab drops it, and the record — the run itself — is what comes back.
  const [asked, dispatch] = useReducer(triggerReducer, NO_TRIGGER);
  const [ticks, setTicks] = useState(0);
  // The desktop's three edits — stop, rule, permission — share one busy and
  // one refusal, and every one of them is followed by a re-read.
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const reads = nonce + ticks;
  const list = useWorkflows("phone", reads);
  const one = useWorkflow(openSlug, "phone", reads);
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
    ...triggerFor(asked, openSlug),
    onClear: () => {
      if (openSlug) dispatch({ type: "clear", slug: openSlug });
    },
    onRun: (args) => {
      if (!openSlug) return;
      const slug = openSlug;
      dispatch({ type: "asked", slug });
      runWorkflow(slug, args)
        .then((run) => {
          dispatch({ type: "accepted", slug, run });
          setTicks((n) => n + 1);
        })
        .catch((error: unknown) => {
          dispatch({ type: "refused", slug, message: error instanceof Error ? error.message : String(error) });
        });
    },
  };

  const write = (act: () => Promise<unknown>) => {
    setEditing(true);
    setEditError(null);
    act()
      .catch((error: unknown) => setEditError(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        setTicks((n) => n + 1);
        setEditing(false);
      });
  };
  const edits: WorkflowEdits = {
    busy: editing,
    error: editError,
    onStop: () => {
      if (openSlug) write(() => stopWorkflow(openSlug));
    },
    onInstructions: (text) => {
      if (openSlug) write(() => saveInstructions(openSlug, text));
    },
    onPermission: (capability, mode) => {
      if (openSlug) write(() => saveWorkflowPermission(openSlug, capability, mode));
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
          onOpen={(slug) => {
            onOpen(slug);
            if (slug !== openSlug) onSheetTab("Summary");
          }}
          tab={sheetTab}
          onTab={onSheetTab}
          resolved={resolved}
          busy={pausing !== null}
          onTogglePause={onTogglePause}
          onInvoke={settle}
          trigger={trigger}
          edits={edits}
          nonce={reads}
        />
      ) : null}
    </PhoneScreen>
  );
}
