// Everything the home surface draws, in one read.
//
// The design's fixtures store display strings — "Activity 12", "Two need a word
// from you", "11:00  Marta, 30 min". Almost all of those are derivable, and a
// stored count is wrong by morning, so they are computed here. What is *not*
// derivable is the agent's own prose, and that comes out of `narratives` and
// `surface_notes` exactly as it was written.
import { and, asc, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "../index";
import * as s from "../schema";
import type { HomePayload, HomeAction, HomeFeedItem, HomeSection, HomeStance, HomeToolCall } from "../../shared/home";
import { capitalise, clock, dayKey, dayLabel, duration, localHour, spell } from "./_format";
import type { Surface } from "../../shared/surface";
import { surfaceDayNote } from "./_surface";

export type * from "../../shared/home";

/**
 * The wire types spell their unions out so the browser can compile against
 * them without Bun. These two lines fail to compile if the schema ever widens
 * a vocabulary the payload has already committed to.
 */
export type StanceIsCovered = (typeof s.ACTION_STANCE)[number] extends HomeStance ? true : never;
export type StateIsCovered = (typeof s.STATE)[number] extends HomePayload["sections"][number]["items"][number]["state"] ? true : never;

/** The design groups the feed by day, and calls today's early entries
 *  "this morning" rather than "today". */
function sectionLabel(occurredAt: Date, now: Date): string {
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000));
  const key = dayKey(occurredAt);
  if (key === today) return localHour(occurredAt) < 12 ? "This morning" : "Today";
  if (key === yesterday) return "Yesterday";
  return dayLabel(occurredAt);
}

export function loadHome(db: Db, now: Date = new Date(), surface: Surface = "desktop"): HomePayload {
  // ── the feed ──────────────────────────────────────────────────────────
  const items = db
    .select()
    .from(s.activityItems)
    .where(isNull(s.activityItems.dismissedAt))
    .orderBy(desc(s.activityItems.occurredAt))
    .all();

  const ids = items.map((i) => i.id);
  const accounts = new Map<string, string>();
  const actionsBySubject = new Map<string, HomeAction[]>();
  const callsByRun = new Map<string, HomeToolCall[]>();

  // Buttons are read whether or not the feed has anything in it: the aside's
  // "worth a look" card is a recommendation, and its two words hang off the
  // recommendation rather than off a feed row. Reading these inside the guard
  // below meant a morning with no activity drew that card with nothing to press.
  for (const a of db.select().from(s.actions).orderBy(asc(s.actions.ordinal)).all()) {
    const list = actionsBySubject.get(a.subjectId) ?? [];
    list.push({ id: a.id, label: a.label, stance: a.stance, effectKind: a.effectKind, effect: a.effect });
    actionsBySubject.set(a.subjectId, list);
  }

  // These two are only ever read through a feed row, so an empty feed skips them.
  if (ids.length) {
    for (const n of db.select().from(s.narratives).where(eq(s.narratives.slot, "account")).all()) {
      accounts.set(n.subjectId, n.text);
    }
    for (const step of db
      .select()
      .from(s.runSteps)
      .where(eq(s.runSteps.isTool, true))
      .orderBy(asc(s.runSteps.runId), asc(s.runSteps.ordinal))
      .all()) {
      const list = callsByRun.get(step.runId) ?? [];
      list.push({ name: step.name, arg: step.detail, duration: duration(step.durationMs) });
      callsByRun.set(step.runId, list);
    }
  }

  const sections: HomeSection[] = [];
  for (const item of items) {
    const entry: HomeFeedItem = {
      id: item.id,
      state: item.state,
      title: item.title,
      badge: item.badge,
      // A running item is dated from when it started, not when it will end.
      time: item.state === "running" ? `since ${clock(item.occurredAt)}` : clock(item.occurredAt),
      framed: item.framed,
      prominent: item.prominence === "prominent",
      account: accounts.get(item.id) ?? null,
      toolSummary: item.toolSummary,
      toolCalls: item.runId ? (callsByRun.get(item.runId) ?? []) : [],
      progress:
        item.progressValue != null && item.progressTotal != null
          ? { value: item.progressValue, total: item.progressTotal }
          : null,
      decisionId: item.decisionId,
      actions: actionsBySubject.get(item.id) ?? [],
    };
    const label = sectionLabel(item.occurredAt, now);
    const last = sections.at(-1);
    if (last && last.label === label) last.items.push(entry);
    else sections.push({ label, items: [entry] });
  }

  // ── what is waiting on you ────────────────────────────────────────────
  // A recommendation is also an open decision, but the design gives it its own
  // place in the aside, so it is filtered out here rather than listed twice.
  const waiting = db
    .select({ id: s.vNeedsYou.decisionId, title: s.vNeedsYou.title })
    .from(s.vNeedsYou)
    .where(or(isNull(s.vNeedsYou.subjectKind), ne(s.vNeedsYou.subjectKind, "recommendation")))
    .all();

  // ── next up ───────────────────────────────────────────────────────────
  const upcoming: { at: Date; what: string }[] = [];
  for (const c of db
    .select()
    .from(s.calendarItems)
    .where(gt(s.calendarItems.startsAt, now))
    .orderBy(asc(s.calendarItems.startsAt))
    .limit(6)
    .all()) {
    upcoming.push({ at: c.startsAt, what: c.metaLabel ? `${c.title}, ${c.metaLabel}` : c.title });
  }
  // Scheduled runs are not materialised as calendar rows — that would fork the
  // schedule — so the next firing is read straight off the schedule.
  for (const row of db
    .select({ nextRunAt: s.workflowSchedules.nextRunAt, name: s.workflows.name })
    .from(s.workflowSchedules)
    .innerJoin(s.workflows, eq(s.workflows.id, s.workflowSchedules.workflowId))
    .where(and(eq(s.workflowSchedules.enabled, true), gt(s.workflowSchedules.nextRunAt, now)))
    .orderBy(asc(s.workflowSchedules.nextRunAt))
    .limit(6)
    .all()) {
    if (row.nextRunAt) upcoming.push({ at: row.nextRunAt, what: `${row.name} runs` });
  }
  const nextUp = upcoming
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, 3)
    .map((u) => ({ time: clock(u.at), what: u.what }));

  // ── worth a look ──────────────────────────────────────────────────────
  const [rec] = db
    .select({ id: s.recommendations.id, body: s.decisions.body, title: s.recommendations.title })
    .from(s.recommendations)
    .leftJoin(s.decisions, eq(s.decisions.id, s.recommendations.decisionId))
    .where(eq(s.recommendations.status, "proposed"))
    .orderBy(desc(s.recommendations.formedAt))
    .limit(1)
    .all();

  const worthALook = rec
    ? { id: rec.id, body: rec.body ?? rec.title, actions: actionsBySubject.get(rec.id) ?? [] }
    : null;

  // ── the rail ──────────────────────────────────────────────────────────
  const count = (query: { all: () => { n: number }[] }) => query.all()[0]?.n ?? 0;

  const activityCount = count(
    db.select({ n: sql<number>`count(*)` }).from(s.activityItems).where(isNull(s.activityItems.dismissedAt)),
  );
  // Overdue or due today, and not closed out. A stored "Today" is wrong by
  // morning, so the bucket is a comparison rather than a column.
  const endOfToday = new Date(now.getTime());
  const remindersDue = db
    .select({ dueAt: s.reminders.dueAt })
    .from(s.reminders)
    .where(and(ne(s.reminders.state, "done"), ne(s.reminders.state, "cancelled")))
    .all()
    .filter((r) => r.dueAt != null && dayKey(r.dueAt) <= dayKey(endOfToday)).length;

  const workflowCount = count(db.select({ n: sql<number>`count(*)` }).from(s.workflows));
  const running = count(
    db.select({ n: sql<number>`count(*)` }).from(s.workflowRuns).where(eq(s.workflowRuns.state, "running")),
  );

  // What the agent has asked you in the chat and is still holding a run on.
  // Blocking, specifically: a suggestion waiting in the feed is not the same
  // as a turn that has stopped mid-sentence and cannot go on without you.
  const chatWaiting = count(
    db
      .select({ n: sql<number>`count(*)` })
      .from(s.decisions)
      .innerJoin(s.conversations, eq(s.conversations.id, s.decisions.subjectId))
      .where(
        and(
          eq(s.decisions.state, "open"),
          eq(s.decisions.blocking, true),
          eq(s.conversations.channel, "agent_chat"),
        ),
      ),
  );

  const unsettled = count(
    db
      .select({ n: sql<number>`count(*)` })
      .from(s.okfConflicts)
      .where(sql`${s.okfConflicts.resolvedAt} is null`),
  );

  const unanswered = count(
    db.select({ n: sql<number>`count(*)` }).from(s.recommendations).where(eq(s.recommendations.status, "proposed")),
  );

  const rail: HomePayload["rail"] = {
    groups: [
      {
        label: "Today",
        items: [
          // First, because it is the one destination you go to rather than are
          // sent to. Amber when it has stopped and is waiting on you.
          { label: "Chat", count: chatWaiting || null, dot: chatWaiting ? "amber" : null },
          { label: "Activity", count: activityCount || null, dot: null },
          { label: "Calendar", count: null, dot: null },
          { label: "Reminders", count: remindersDue || null, dot: null },
        ],
      },
      {
        label: "Memory",
        items: [
          // Not how much I hold — how much of it I couldn't settle. The rail
          // counts what wants you, and 314 memories want nothing.
          { label: "Things I know", count: unsettled || null, dot: unsettled ? "amber" : null },
          // Not how many I hold — how many I am still asking about. Something
          // you already answered is not a number the rail should keep showing.
          { label: "Recommendations", count: unanswered || null, dot: null },
        ],
      },
      {
        label: "Automation",
        items: [{ label: "Workflows", count: workflowCount || null, dot: running ? "green" : null }],
      },
    ],
    agent: {
      running,
      line: running === 0 ? "Nothing running" : `Working on ${spell(running)} thing${running === 1 ? "" : "s"}`,
    },
  };

  // ── the header ────────────────────────────────────────────────────────
  const [nameRow] = db
    .select({ value: s.settings.value })
    .from(s.settings)
    .where(eq(s.settings.key, "user.displayName"))
    .all();
  const name = typeof nameRow?.value === "string" ? nameRow.value : null;
  const overnight = surfaceDayNote(db, "home", dayKey(now), "line", surface);

  const hour = localHour(now);
  const partOfDay = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const needsClause =
    waiting.length === 0
      ? "Nothing needs you right now."
      : `${capitalise(spell(waiting.length))} need${waiting.length === 1 ? "s" : ""} a word from you before I go further.`;

  return {
    header: {
      greeting: name ? `${partOfDay}, ${name}` : partOfDay,
      lede: [overnight, needsClause].filter(Boolean).join(" "),
    },
    rail,
    sections,
    aside: { waiting, nextUp, worthALook },
  };
}
