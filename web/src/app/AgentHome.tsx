import { useEffect, useState, type CSSProperties } from "react";
import { MonoLabel } from "../kit";
import { useInstalled, usePhoneFrame } from "./frame";
import { PhoneHome } from "./phone/PhoneHome";
import { ActivityView } from "./ActivityView";
import { AgentAside } from "./AgentAside";
import { AgentRail } from "./AgentRail";
import { CalendarDetail } from "./CalendarDetail";
import { CalendarView } from "./CalendarView";
import { KnowledgeObject } from "./KnowledgeObject";
import { RecommendationDetail } from "./RecommendationDetail";
import { RecommendationsView, type LocalStance } from "./RecommendationsView";
import { ReminderDetail } from "./ReminderDetail";
import { RemindersView, type LocalMark } from "./RemindersView";
import { ThingsIKnowView } from "./ThingsIKnowView";
import { WorkflowDetail, type WorkflowEdits, type WorkflowTrigger } from "./WorkflowDetail";
import { WorkflowsView } from "./WorkflowsView";
import { pendingDecisionFor, withoutResolved } from "./settle";
import {
  useCalendar,
  useCalendarItem,
  useHome,
  useKnowledge,
  useKnowledgeObject,
  answerRecommendation as writeAnswer,
  useRecommendation,
  useRecommendations,
  useReminder,
  useReminders,
  pauseWorkflow,
  runWorkflow,
  saveInstructions,
  stopWorkflow,
  useWorkflow,
  useWorkflows,
  type HomeAction,
  type HomePayload,
  type WorkflowRunAccepted,
} from "./api";

/**
 * The design's frame is 1240×840.
 *
 * Kept at that size where there is room, and allowed to fill a smaller window
 * rather than overflow it — the three columns are what carries the layout, not
 * the exact canvas.
 *
 * Installed as a Mac app it fills instead, for the same reason the phone's does:
 * the border, the corners and the shadow draw a window sitting on a desk, and
 * the OS is already drawing the real one around them.
 */
const frame = (installed: boolean): CSSProperties => ({
  // The border is inside the 1240, not added to it — otherwise the frame is
  // 1242px wide in any window narrower than that and the whole app scrolls
  // sideways by two pixels. The phone frame is built the same way, and the
  // same two pixels were the more obvious bug there.
  boxSizing: "border-box",
  width: installed ? "100%" : "min(1240px, 100vw)",
  height: installed ? "100dvh" : "min(840px, 100dvh)",
  overflow: "hidden",
  display: "grid",
  gridTemplateColumns: "var(--rail-w) 1fr var(--aside-w)",
  background: "var(--surface-app)",
  color: "var(--text-2)",
  border: installed ? "none" : "var(--border-strong)",
  borderRadius: installed ? 0 : "var(--radius-frame)",
  boxShadow: installed ? "none" : "var(--shadow-frame)",
  font: "var(--text-body)",
});

/** Where you are. `slug` names the one thing you opened — a workflow's slug or
 *  a reminder's id — and `tab` only means anything under Workflows. An
 *  action's navigate effect is written in exactly these three fields. */
interface Route {
  view: string;
  slug?: string;
  tab?: string;
  /** Set by Run on the workflow table: open this one with its trigger form
   *  already asking, rather than merely opening it. */
  ask?: boolean;
}

/**
 * Which frame to draw.
 *
 * The one hook above the branch is the whole of the decision, and it has to be
 * above it: the two shells hold different state and read different surfaces, so
 * whichever is not being drawn must not be running its hooks either.
 *
 * The design is explicit that this is a switch and not a reflow. Below roughly
 * 700px the rail becomes a tab bar, the aside is deleted and the cards give way
 * to a timeline — the phone is not the desktop feed at a smaller width, and the
 * copy underneath it is written twice for the same reason.
 */
export function AgentHome() {
  return usePhoneFrame() ? <PhoneHome /> : <DesktopHome />;
}

function DesktopHome() {
  const installed = useInstalled();
  const [theme, setTheme] = useState<"paper" | "dusk">("paper");
  const [route, setRoute] = useState<Route>({ view: "Activity" });
  // Nothing writes to the database yet, so an action that resolves a decision
  // resolves it here: the entry turns done, the aside clears, and the header
  // recounts — the click-through the design specifies, with no side effect.
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set());
  // Same bargain for a reminder closed or pushed from the list. Pausing a
  // workflow is not on this list any more: it is written, so what is on screen
  // is what the schedule and the Run button will actually honour.
  const [reminderMarks, setReminderMarks] = useState<ReadonlyMap<string, LocalMark>>(() => new Map());
  const [recommendationStances, setRecommendationStances] = useState<ReadonlyMap<string, LocalStance>>(() => new Map());
  // How many of the reminders and suggestions the rail was counting have since
  // been answered here. The rail's numbers are the server's; these are what is
  // no longer true about them.
  const [remindersCleared, setRemindersCleared] = useState(0);
  const [recommendationsCleared, setRecommendationsCleared] = useState(0);

  const home = useHome();

  const invoke = (action: HomeAction) => {
    const effect = action.effect as { view?: string; id?: string; tab?: string } | null;
    if (effect && typeof effect.view === "string") {
      setRoute({ view: effect.view, slug: effect.id, tab: effect.tab });
      return;
    }
    const decisionId = home.status === "ready" ? pendingDecisionFor(home.data, action.id) : null;
    if (decisionId) setResolved((current) => new Set(current).add(decisionId));
  };


  const markReminder = (id: string, mark: LocalMark, wasDue: boolean) => {
    if (wasDue && !reminderMarks.has(id)) setRemindersCleared((n) => n + 1);
    setReminderMarks((current) => new Map(current).set(id, mark));
  };

  // Answering a suggestion also closes the decision behind it, because the
  // Activity aside draws one of these as a card: leaving that open would have
  // the agent still asking on one screen what you already answered on another.
  //
  // The screen moves first and the write follows. An answer is one click and
  // the row it moves is right under the cursor, so waiting for the server would
  // show you a button that looks unpressed for as long as the round trip takes.
  // If the write is refused — you answered it in another tab, or I withdrew it
  // while this page was open — the row goes back to asking, which is the truth:
  // the next read would put it back there anyway.
  const answerRecommendation = (id: string, stance: LocalStance, wasOpen: boolean, action: HomeAction) => {
    const counted = wasOpen && !recommendationStances.has(id);
    if (counted) setRecommendationsCleared((n) => n + 1);
    setRecommendationStances((current) => new Map(current).set(id, stance));
    invoke(action);

    writeAnswer(id, stance).catch(() => {
      if (counted) setRecommendationsCleared((n) => Math.max(0, n - 1));
      setRecommendationStances((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    });
  };

  const resolve = (decisionId: string) => setResolved((current) => new Set(current).add(decisionId));

  const toggleTheme = () => setTheme((t) => (t === "paper" ? "dusk" : "paper"));

  return (
    <div data-theme={theme === "dusk" ? "dusk" : undefined} style={frame(installed)}>
      <AgentRail
        rail={
          home.status === "ready"
            ? withoutCleared(
                withoutCleared(withoutResolved(home.data, resolved).rail, "Reminders", remindersCleared),
                "Recommendations",
                recommendationsCleared,
              )
            : EMPTY_RAIL
        }
        selected={route.view}
        onSelect={(view) => setRoute({ view })}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      {home.status === "loading" ? <Notice label="Reading" text="Fetching what I did overnight." /> : null}
      {home.status === "error" ? (
        <Notice
          label="No answer"
          text={`I couldn't reach the API — ${home.message}. Start it with \`bun run start:server\`, and seed it with \`bun run db:seed\` if you haven't yet.`}
        />
      ) : null}

      {home.status === "ready" && route.view === "Activity" ? (
        <Activity home={home.data} resolved={resolved} onInvoke={invoke} />
      ) : null}

      {home.status === "ready" && route.view === "Workflows" ? (
        <Workflows route={route} setRoute={setRoute} onInvoke={invoke} />
      ) : null}

      {home.status === "ready" && route.view === "Reminders" ? (
        <Reminders route={route} setRoute={setRoute} marks={reminderMarks} onMark={markReminder} onInvoke={invoke} onResolve={resolve} />
      ) : null}

      {home.status === "ready" && route.view === "Calendar" ? <Calendar route={route} setRoute={setRoute} onInvoke={invoke} /> : null}

      {home.status === "ready" && route.view === "Things I know" ? <Knowledge route={route} setRoute={setRoute} /> : null}

      {home.status === "ready" && route.view === "Recommendations" ? (
        <Recommendations
          route={route}
          setRoute={setRoute}
          stances={recommendationStances}
          onAnswer={answerRecommendation}
        />
      ) : null}
    </div>
  );
}

/**
 * The feed and the aside are one destination and one recount: a gate closed
 * here has to drop out of the header's sentence and the aside's list together,
 * or the two halves of the same screen disagree about what is still waiting.
 */
function Activity({
  home,
  resolved,
  onInvoke,
}: {
  home: HomePayload;
  resolved: ReadonlySet<string>;
  onInvoke: (action: HomeAction) => void;
}) {
  const shown = withoutResolved(home, resolved);
  return (
    <>
      <ActivityView header={shown.header} sections={shown.sections} resolved={resolved} onInvoke={onInvoke} />
      <AgentAside aside={shown.aside} onInvoke={onInvoke} />
    </>
  );
}

/**
 * The week and one thing on it are one destination.
 *
 * The canvas stays mounted while the aside opens, which is what keeps week/day
 * and which day you were looking at: opening a block is not leaving the screen.
 * And the block you clicked is handed to the aside straight away, so only the
 * account and the pairs wait on the read.
 */
function Calendar({
  route,
  setRoute,
  onInvoke,
}: {
  route: Route;
  setRoute: (route: Route) => void;
  onInvoke: (action: HomeAction) => void;
}) {
  const list = useCalendar();
  const one = useCalendarItem(route.slug ?? null);

  if (list.status === "loading") return <Notice label="Reading" text="Laying out your week." />;
  if (list.status === "error") return <Notice label="No answer" text={`I couldn't read the week — ${list.message}.`} />;

  // The detail payload is a block plus everything behind it, so a thing opened
  // from outside the drawn week still has a header to draw.
  const drawn = route.slug ? list.data.items.find((item) => item.id === route.slug) : undefined;
  const open = drawn ?? (route.slug && one.status === "ready" ? one.data : null);

  return (
    <>
      <CalendarView
        calendar={list.data}
        selected={open?.id ?? null}
        detailOpen={open != null}
        onOpen={(id) => setRoute(id ? { view: "Calendar", slug: id } : { view: "Calendar" })}
      />
      {open ? (
        <CalendarDetail item={open} detail={one} onClose={() => setRoute({ view: "Calendar" })} onInvoke={onInvoke} />
      ) : null}
    </>
  );
}

/** The list and one suggestion are one destination, so they share a fetch seam
 *  rather than each being a branch in the surface above. */
function Recommendations({
  route,
  setRoute,
  stances,
  onAnswer,
}: {
  route: Route;
  setRoute: (route: Route) => void;
  stances: ReadonlyMap<string, LocalStance>;
  onAnswer: (id: string, stance: LocalStance, wasOpen: boolean, action: HomeAction) => void;
}) {
  const list = useRecommendations();
  const one = useRecommendation(route.slug ?? null);

  if (route.slug) {
    if (one.status === "loading") return <Notice label="Reading" text="Opening it." />;
    if (one.status === "error") return <Notice label="No answer" text={`I couldn't open that one — ${one.message}.`} />;
    const recommendation = one.data;
    return (
      <RecommendationDetail
        recommendation={recommendation}
        stance={stances.get(recommendation.id)}
        onAnswer={(stance, wasOpen, action) => onAnswer(recommendation.id, stance, wasOpen, action)}
        onBack={() => setRoute({ view: "Recommendations" })}
      />
    );
  }

  if (list.status === "loading") return <Notice label="Reading" text="Listing what I'd change about how I work." />;
  if (list.status === "error") return <Notice label="No answer" text={`I couldn't list them — ${list.message}.`} />;
  return (
    <RecommendationsView
      recommendations={list.data}
      stances={stances}
      onAnswer={onAnswer}
      onOpen={(id) => setRoute({ view: "Recommendations", slug: id })}
    />
  );
}

/** The store and one memory are one destination, so they share a fetch seam
 *  rather than each being a branch in the surface above. */
function Knowledge({ route, setRoute }: { route: Route; setRoute: (route: Route) => void }) {
  const list = useKnowledge();
  const one = useKnowledgeObject(route.slug ?? null);

  if (route.slug) {
    if (one.status === "loading") return <Notice label="Reading" text="Opening it." />;
    if (one.status === "error") return <Notice label="No answer" text={`I couldn't open that one — ${one.message}.`} />;
    return <KnowledgeObject memory={one.data} onBack={() => setRoute({ view: "Things I know" })} />;
  }

  if (list.status === "loading") return <Notice label="Reading" text="Going through what I've written down." />;
  if (list.status === "error") return <Notice label="No answer" text={`I couldn't read the store — ${list.message}.`} />;
  return <ThingsIKnowView knowledge={list.data} onOpen={(id) => setRoute({ view: "Things I know", slug: id })} />;
}

/** The list and one reminder are one destination, so they share a fetch seam
 *  rather than each being a branch in the surface above. */
function Reminders({
  route,
  setRoute,
  marks,
  onMark,
  onInvoke,
  onResolve,
}: {
  route: Route;
  setRoute: (route: Route) => void;
  marks: ReadonlyMap<string, LocalMark>;
  onMark: (id: string, mark: LocalMark, wasDue: boolean) => void;
  onInvoke: (action: HomeAction) => void;
  onResolve: (decisionId: string) => void;
}) {
  const list = useReminders();
  const one = useReminder(route.slug ?? null);

  if (route.slug) {
    if (one.status === "loading") return <Notice label="Reading" text="Opening it." />;
    if (one.status === "error") return <Notice label="No answer" text={`I couldn't open that one — ${one.message}.`} />;
    const reminder = one.data;
    return (
      <ReminderDetail
        reminder={reminder}
        mark={marks.get(reminder.id)}
        onMark={(mark, wasDue) => onMark(reminder.id, mark, wasDue)}
        onBack={() => setRoute({ view: "Reminders" })}
        // A gate's button closes the gate as well as doing whatever it says,
        // so the aside and the header stop counting it.
        onInvoke={(action) => {
          if (reminder.gate) onResolve(reminder.gate.id);
          onInvoke(action);
        }}
      />
    );
  }

  if (list.status === "loading") return <Notice label="Reading" text="Listing what I'm holding for you." />;
  if (list.status === "error") return <Notice label="No answer" text={`I couldn't list them — ${list.message}.`} />;
  return <RemindersView reminders={list.data} marks={marks} onMark={onMark} onOpen={(id) => setRoute({ view: "Reminders", slug: id })} />;
}

/** The table and one workflow are one destination, so they share a fetch seam
 *  rather than each being a branch in the surface above. */
function Workflows({
  route,
  setRoute,
  onInvoke,
}: {
  route: Route;
  setRoute: (route: Route) => void;
  onInvoke: (action: HomeAction) => void;
}) {
  if (route.slug) return <One route={route} setRoute={setRoute} onInvoke={onInvoke} />;
  return <All setRoute={setRoute} />;
}

/**
 * A write, and the re-read that has to follow it.
 *
 * Every mutation on this surface is the same three lines — mark busy, send it,
 * ask the server what is true now — so they are written once. Nothing is
 * applied optimistically: pausing a workflow decides whether the scheduler will
 * fire it, and a screen that says paused while the server disagrees is worse
 * than one that takes a beat to say it.
 */
function useWrites(): {
  busy: boolean;
  error: string | null;
  reads: number;
  /** Force a re-read without writing — what a timer does. */
  reread: () => void;
  run: (write: () => Promise<unknown>) => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);

  return {
    busy,
    error,
    reads,
    reread: () => setReads((n) => n + 1),
    run: (write) => {
      setBusy(true);
      setError(null);
      write()
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => {
          setReads((n) => n + 1);
          setBusy(false);
        });
    },
  };
}

function All({ setRoute }: { setRoute: (route: Route) => void }) {
  const writes = useWrites();
  // The table is the one place a run someone started elsewhere — the cron
  // worker, a second tab, curl — shows up, so it re-reads on a slow timer.
  // Both counters only ever go up, so their sum is a stable cache key.
  const workflows = useWorkflows("desktop", useTick(TABLE_TICK_MS) + writes.reads);
  if (workflows.status === "loading") return <Notice label="Reading" text="Listing everything I run." />;
  if (workflows.status === "error") return <Notice label="No answer" text={`I couldn't list them — ${workflows.message}.`} />;
  return (
    <WorkflowsView
      workflows={workflows.data}
      busy={writes.busy}
      error={writes.error}
      onTogglePause={(slug, paused) => writes.run(() => pauseWorkflow(slug, paused))}
      onOpen={(slug) => setRoute({ view: "Workflows", slug })}
      onRun={(slug) => setRoute({ view: "Workflows", slug, tab: "Summary", ask: true })}
    />
  );
}

/** How often each surface asks again. The detail is watching something move;
 *  the table is only catching up with what someone else started. */
const RUNNING_TICK_MS = 2000;
const TABLE_TICK_MS = 15000;

function One({
  route,
  setRoute,
  onInvoke,
}: {
  route: Route;
  setRoute: (route: Route) => void;
  onInvoke: (action: HomeAction) => void;
}) {
  const slug = route.slug ?? "";
  // Writing is what has to invalidate: `reads` bumps once per write, and then
  // on a timer for as long as a run is going.
  const writes = useWrites();
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [opened, setOpened] = useState<WorkflowRunAccepted | null>(null);

  const workflow = useWorkflow(slug, "desktop", writes.reads);
  const running = workflow.status === "ready" && workflow.data.state === "running";
  const tick = useTick(running ? RUNNING_TICK_MS : null);

  useEffect(() => {
    if (tick > 0) writes.reread();
  }, [tick]);

  const start = (args: Record<string, string>) => {
    setStarting(true);
    setRefused(null);
    runWorkflow(slug, args)
      .then((accepted) => {
        setOpened(accepted);
        writes.reread();
      })
      .catch((error: unknown) => setRefused(error instanceof Error ? error.message : String(error)))
      .finally(() => setStarting(false));
  };

  if (workflow.status === "loading") return <Notice label="Reading" text="Opening the run." />;
  if (workflow.status === "error") return <Notice label="No answer" text={`I couldn't open ${slug} — ${workflow.message}.`} />;

  const trigger: WorkflowTrigger = {
    pending: starting,
    error: refused,
    started: opened?.label ?? null,
    onRun: start,
    onClear: () => setRefused(null),
  };

  const edits: WorkflowEdits = {
    busy: writes.busy,
    error: writes.error,
    onStop: () => writes.run(() => stopWorkflow(slug)),
    onInstructions: (text) => writes.run(() => saveInstructions(slug, text)),
  };

  return (
    <WorkflowDetail
      // Keyed, so opening a second workflow starts on its own Summary tab with
      // its own form closed rather than inheriting the first one's.
      key={slug}
      workflow={workflow.data}
      tab={route.tab ?? "Summary"}
      onTab={(tab) => setRoute({ ...route, tab, ask: false })}
      paused={workflow.data.paused}
      onTogglePause={() => writes.run(() => pauseWorkflow(slug, !workflow.data.paused))}
      onBack={() => setRoute({ view: "Workflows" })}
      onInvoke={onInvoke}
      trigger={trigger}
      edits={edits}
      askOnOpen={route.ask === true}
      nonce={writes.reads}
    />
  );
}

/**
 * A counter that goes up every `ms`, or never when `ms` is null.
 *
 * The server cannot tell the browser that a run moved, so the browser asks. It
 * is a count rather than a boolean because what reads it is a fetch key: the
 * same value twice would be the same question and would not re-read.
 */
function useTick(ms: number | null): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (ms == null) return;
    const timer = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return tick;
}

const EMPTY_RAIL: HomePayload["rail"] = { groups: [], agent: { line: "Nothing running", running: 0 } };

/** The rail counts what still wants you. Answering one here has to take it off
 *  the count, or the badge goes on claiming something the list no longer shows. */
function withoutCleared(rail: HomePayload["rail"], label: string, cleared: number): HomePayload["rail"] {
  if (cleared === 0) return rail;
  return {
    ...rail,
    groups: rail.groups.map((group) => ({
      ...group,
      items: group.items.map((item) =>
        item.label === label && item.count != null ? { ...item, count: Math.max(0, item.count - cleared) || null } : item,
      ),
    })),
  };
}

function Notice({ label, text }: { label: string; text: string }) {
  return (
    <main style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)", padding: "var(--sp-10)", gridColumn: "2 / span 2" }}>
      <MonoLabel>{label}</MonoLabel>
      <p style={{ margin: 0, font: "var(--text-body)", color: "var(--text-2)", textWrap: "pretty", maxWidth: "var(--measure)" }}>{text}</p>
    </main>
  );
}
