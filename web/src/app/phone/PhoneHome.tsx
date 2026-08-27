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
import { useState } from "react";
import { usePrefersDusk } from "../frame";
import {
  useCalendar,
  useCalendarItem,
  useKnowledge,
  useKnowledgeObject,
  useHome,
  useWorkflow,
  useWorkflows,
  type HomeAction,
  type HomePayload,
} from "../api";
import { pendingDecisionFor, withoutResolved } from "../settle";
import { ActivityPhone } from "./ActivityPhone";
import { CalendarPhone } from "./CalendarPhone";
import { MemoryPhone } from "./MemoryPhone";
import { WorkflowsPhone } from "./WorkflowsPhone";
import { PhoneNotice, PhoneScreen, type PhoneTab } from "./chrome";

/** What each screen has open, kept per screen rather than as one field: coming
 *  back to Workflows should find the sheet you left open there. */
type OpenBy = Partial<Record<PhoneTab, string | null>>;

export function PhoneHome() {
  const dusk = usePrefersDusk();
  const [tab, setTab] = useState<PhoneTab>("Activity");
  const [open, setOpen] = useState<OpenBy>({});

  // Nothing writes to the database yet, so settling something settles it here:
  // the same bargain the desktop strikes, and the same two sets holding it.
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set());
  const [pausedLocally, setPausedLocally] = useState<ReadonlySet<string>>(() => new Set());

  const openOn = (screen: PhoneTab) => open[screen] ?? null;
  const setOpenOn = (screen: PhoneTab) => (id: string | null) => setOpen((current) => ({ ...current, [screen]: id }));

  const togglePause = (slug: string) =>
    setPausedLocally((current) => {
      const next = new Set(current);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });

  const resolve = (decisionId: string) => setResolved((current) => new Set(current).add(decisionId));

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

  return (
    <div data-theme={dusk ? "dusk" : undefined} style={{ display: "contents" }}>
      {tab === "Activity" ? (
        <Activity tab={tab} onTab={setTab} resolved={resolved} onInvoke={invoke} onResolve={resolve} />
      ) : null}
      {tab === "Calendar" ? (
        <Calendar tab={tab} onTab={setTab} openId={openOn("Calendar")} onOpen={setOpenOn("Calendar")} onInvoke={invoke} />
      ) : null}
      {tab === "Things I know" ? (
        <Memory tab={tab} onTab={setTab} openId={openOn("Things I know")} onOpen={setOpenOn("Things I know")} />
      ) : null}
      {tab === "Workflows" ? (
        <Workflows
          tab={tab}
          onTab={setTab}
          openSlug={openOn("Workflows")}
          onOpen={setOpenOn("Workflows")}
          pausedLocally={pausedLocally}
          onTogglePause={togglePause}
          onInvoke={invoke}
          onResolve={resolve}
        />
      ) : null}
    </div>
  );
}

const isTab = (view: string): view is PhoneTab =>
  view === "Activity" || view === "Calendar" || view === "Things I know" || view === "Workflows";

type Chrome = { tab: PhoneTab; onTab: (tab: PhoneTab) => void };

function Activity({
  tab,
  onTab,
  resolved,
  onInvoke,
  onResolve,
}: Chrome & { resolved: ReadonlySet<string>; onInvoke: (action: HomeAction) => void; onResolve: (id: string) => void }) {
  const home = useHome("phone");
  const shown: HomePayload | null = home.status === "ready" ? withoutResolved(home.data, resolved) : null;

  // A gate answered in the feed has to drop out of the header's count as well
  // as out of the entry, or the two halves of the screen disagree about what is
  // still waiting. The lookup needs the payload, which is why it is here.
  const settle = (action: HomeAction) => {
    const decisionId = home.status === "ready" ? pendingDecisionFor(home.data, action.id) : null;
    if (decisionId) onResolve(decisionId);
    onInvoke(action);
  };

  return (
    <PhoneScreen meta={home.status === "ready" ? home.data.rail.agent.line : undefined} tab={tab} onTab={onTab}>
      {home.status === "loading" ? <PhoneNotice label="Reading" text="Fetching what I did overnight." /> : null}
      {home.status === "error" ? (
        <PhoneNotice
          label="No answer"
          text={`I couldn't reach the API — ${home.message}. Start it with \`bun run start:server\`, and seed it with \`bun run db:seed\` if you haven't yet.`}
        />
      ) : null}
      {shown ? <ActivityPhone home={shown} resolved={resolved} onInvoke={settle} /> : null}
    </PhoneScreen>
  );
}

function Calendar({
  tab,
  onTab,
  openId,
  onOpen,
  onInvoke,
}: Chrome & { openId: string | null; onOpen: (id: string | null) => void; onInvoke: (action: HomeAction) => void }) {
  const list = useCalendar("phone");
  const one = useCalendarItem(openId);

  return (
    <PhoneScreen meta={list.status === "ready" ? list.data.range : undefined} tab={tab} onTab={onTab}>
      {list.status === "loading" ? <PhoneNotice label="Reading" text="Laying out your week." /> : null}
      {list.status === "error" ? <PhoneNotice label="No answer" text={`I couldn't read the week — ${list.message}.`} /> : null}
      {list.status === "ready" ? (
        <CalendarPhone calendar={list.data} detail={one} openId={openId} onOpen={onOpen} onInvoke={onInvoke} />
      ) : null}
    </PhoneScreen>
  );
}

function Memory({ tab, onTab, openId, onOpen }: Chrome & { openId: string | null; onOpen: (id: string | null) => void }) {
  const list = useKnowledge("phone");
  const one = useKnowledgeObject(openId);
  const facts = list.status === "ready" ? list.data.rows.reduce((sum, row) => sum + row.facts, 0) : 0;

  return (
    <PhoneScreen meta={list.status === "ready" ? `${facts} facts` : undefined} tab={tab} onTab={onTab}>
      {list.status === "loading" ? <PhoneNotice label="Reading" text="Going through what I've written down." /> : null}
      {list.status === "error" ? <PhoneNotice label="No answer" text={`I couldn't read the store — ${list.message}.`} /> : null}
      {list.status === "ready" ? <MemoryPhone knowledge={list.data} detail={one} openId={openId} onOpen={onOpen} /> : null}
    </PhoneScreen>
  );
}

function Workflows({
  tab,
  onTab,
  openSlug,
  onOpen,
  pausedLocally,
  onTogglePause,
  onInvoke,
  onResolve,
}: Chrome & {
  openSlug: string | null;
  onOpen: (slug: string | null) => void;
  pausedLocally: ReadonlySet<string>;
  onTogglePause: (slug: string) => void;
  onInvoke: (action: HomeAction) => void;
  onResolve: (id: string) => void;
}) {
  const list = useWorkflows("phone");
  const one = useWorkflow(openSlug, "phone");
  const count = list.status === "ready" ? list.data.rows.length : 0;

  // A gate's button closes the gate as well as doing whatever it says, so the
  // Activity feed stops asking about something answered here.
  const settle = (action: HomeAction) => {
    if (one.status === "ready" && one.data.gate) onResolve(one.data.gate.id);
    onInvoke(action);
  };

  return (
    <PhoneScreen meta={list.status === "ready" ? `${count} workflows` : undefined} tab={tab} onTab={onTab}>
      {list.status === "loading" ? <PhoneNotice label="Reading" text="Listing everything I run." /> : null}
      {list.status === "error" ? <PhoneNotice label="No answer" text={`I couldn't list them — ${list.message}.`} /> : null}
      {list.status === "ready" ? (
        <WorkflowsPhone
          workflows={list.data}
          detail={one}
          openSlug={openSlug}
          onOpen={onOpen}
          pausedLocally={pausedLocally}
          onTogglePause={onTogglePause}
          onInvoke={settle}
        />
      ) : null}
    </PhoneScreen>
  );
}
