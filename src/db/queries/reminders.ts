// The Reminders surface: the list, and everything behind one row.
//
// The design's fixtures store the bucket ("Overdue"), the when ("Thu 09:00")
// and the header's count as display strings. All three are properties of the
// due date read against the clock, so all three are computed here — a stored
// "Today" is wrong by morning, and a stored "two are overdue" is wrong the
// moment one of them isn't.
//
// What is not derivable is the agent's writing: the account, the why on each
// piece of evidence, the trail, and the pairs it wrote that count things the
// database holds no rows for. Those are read as written.
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../index";
import * as s from "../schema";
import type {
  ReminderDetailPayload,
  ReminderGate,
  ReminderGroup,
  ReminderHistoryLine,
  ReminderMeta,
  ReminderRow,
  RemindersPayload,
} from "../../shared/reminders";
import type { HomeState } from "../../shared/home";
import { capitalise, daysAway, dueStamp, spell, stampLong } from "./_format";
import { surfaceNote } from "./_surface";
import { evidenceFor } from "./_evidence";

export type * from "../../shared/reminders";

/** Fails to compile if the schema ever widens what a reminder may be. */
export type ReminderStateIsCovered = (typeof s.REMINDER_STATE)[number] extends HomeState | "cancelled" ? true : never;

/** The order the list draws them in. */
const GROUPS: readonly ReminderGroup[] = ["Overdue", "Today", "This week", "Later", "Someday", "Closed"];

type Reminder = typeof s.reminders.$inferSelect;

/**
 * Which bucket a reminder falls in.
 *
 * Closed wins over everything: something you finished is not overdue, however
 * long ago it was due. After that it is only ever a comparison against now.
 */
function groupFor(r: Reminder, now: Date): ReminderGroup {
  if (r.state === "done" || r.state === "cancelled" || r.completedAt) return "Closed";
  if (!r.dueAt) return "Someday";
  if (r.dueAt.getTime() < now.getTime()) return "Overdue";
  const away = daysAway(r.dueAt, now);
  if (away === 0) return "Today";
  return away <= 6 ? "This week" : "Later";
}

/** A reminder has five states and a status mark has five, but "cancelled" is
 *  not one of them: something you called off shows as quiet, not as failed. */
function markFor(r: Reminder): HomeState {
  return r.state === "cancelled" ? "idle" : r.state;
}

function rowFor(r: Reminder, note: string, gated: boolean, now: Date): ReminderRow {
  return {
    id: r.id,
    title: r.title,
    note,
    state: markFor(r),
    group: groupFor(r, now),
    when: dueStamp(r.dueAt, now),
    source: r.originLabel ?? "set by me",
    gated,
  };
}

/** The one line each row shows, keyed by reminder. */
function blurbs(db: Db): Map<string, string> {
  const bySubject = new Map<string, string>();
  for (const n of db.select().from(s.narratives).where(eq(s.narratives.slot, "blurb")).all()) {
    bySubject.set(n.subjectId, n.text);
  }
  return bySubject;
}

/** Which reminders have a decision genuinely open on them. */
function gatedIds(db: Db): Set<string> {
  return new Set(
    db
      .select({ id: s.decisions.subjectId })
      .from(s.decisions)
      .where(eq(s.decisions.state, "open"))
      .all()
      .flatMap((d) => (d.id ? [d.id] : [])),
  );
}

export function loadReminders(db: Db, now: Date = new Date()): RemindersPayload {
  const note = blurbs(db);
  const gated = gatedIds(db);

  const rows = db
    .select()
    .from(s.reminders)
    .all()
    .map((r) => ({ row: rowFor(r, note.get(r.id) ?? "", gated.has(r.id), now), rank: rankOf(r) }))
    .sort((a, b) => GROUPS.indexOf(a.row.group) - GROUPS.indexOf(b.row.group) || a.rank - b.rank)
    .map((r) => r.row);

  return { lede: [surfaceNote(db, "reminders"), overdueClause(rows)].filter(Boolean).join(" "), rows };
}

/**
 * Where a reminder sits inside its bucket.
 *
 * Anything with a date is ordered by when it is coming; anything without one
 * is ordered by when it was last touched, newest first, because "someday" has
 * no order of its own and the freshest thing is the one you remember.
 */
function rankOf(r: Reminder): number {
  if (r.completedAt) return -(r.completedAt.getTime());
  if (r.dueAt) return r.dueAt.getTime();
  return -(r.setAt.getTime());
}

/** The clause the design writes about how late you are. Counted, then said. */
function overdueClause(rows: readonly ReminderRow[]): string {
  const late = rows.filter((r) => r.group === "Overdue").length;
  if (late === 0) return "Nothing is overdue.";
  if (late === 1) return "One of them is past when you asked to hear about it.";
  return `${capitalise(spell(late))} of them are past when you asked to hear about them.`;
}

export function loadReminder(db: Db, id: string, now: Date = new Date()): ReminderDetailPayload | null {
  const [reminder] = db.select().from(s.reminders).where(eq(s.reminders.id, id)).limit(1).all();
  if (!reminder) return null;

  const [gateRow] = reminder.decisionId
    ? db.select().from(s.decisions).where(and(eq(s.decisions.id, reminder.decisionId), eq(s.decisions.state, "open"))).limit(1).all()
    : [];

  const actions = db
    .select()
    .from(s.actions)
    .where(eq(s.actions.subjectId, reminder.id))
    .orderBy(asc(s.actions.ordinal))
    .all()
    .map((a) => ({ id: a.id, label: a.label, stance: a.stance, effectKind: a.effectKind, effect: a.effect }));

  const gate: ReminderGate | null = gateRow
    ? { id: gateRow.id, title: gateRow.title, body: gateRow.body, actions: actions.filter((a) => a.id) }
    : null;

  const [blurb] = db
    .select({ text: s.narratives.text })
    .from(s.narratives)
    .where(and(eq(s.narratives.subjectId, reminder.id), eq(s.narratives.slot, "blurb")))
    .limit(1)
    .all();

  const prose = db
    .select({ text: s.narratives.text })
    .from(s.narratives)
    .where(and(eq(s.narratives.subjectId, reminder.id), eq(s.narratives.slot, "account")))
    .orderBy(asc(s.narratives.ordinal))
    .all()
    .map((n) => n.text);

  const [instruction] = reminder.instructionId
    ? db.select({ text: s.workflowInstructions.text }).from(s.workflowInstructions).where(eq(s.workflowInstructions.id, reminder.instructionId)).limit(1).all()
    : [];

  const history: ReminderHistoryLine[] = db
    .select()
    .from(s.subjectEvents)
    .where(eq(s.subjectEvents.subjectId, reminder.id))
    .orderBy(asc(s.subjectEvents.at))
    .all()
    .map((e) => ({ t: stampLong(e.at, now), text: e.text }));

  return {
    ...rowFor(reminder, blurb?.text ?? "", gate != null, now),
    prose,
    meta: metaFor(db, reminder, now),
    history,
    instruction: instruction?.text ?? null,
    gate,
    // A gate's buttons belong to the gate; only a reminder without one offers
    // its actions loose, and then they read as affordances rather than a duty.
    actions: gate ? [] : actions,
    evidence: evidenceFor(db, reminder.id, now),
  };
}

/**
 * The pairs under "This reminder".
 *
 * Who set it, when it is due or when it closed, what it came from and what it
 * is holding up are all facts the row already carries, so they are derived.
 * Everything after them counts something the database has no rows for — two
 * invoices, two offered slots, £84 — and is read as the agent wrote it.
 */
function metaFor(db: Db, r: Reminder, now: Date): ReminderMeta[] {
  const meta: ReminderMeta[] = [
    { label: "Set by", value: `${r.setBy === "agent" ? "me" : "you"} · ${stampLong(r.setAt, now)}` },
  ];
  if (r.completedAt) meta.push({ label: "Closed", value: stampLong(r.completedAt, now) });
  else meta.push({ label: "Due", value: r.dueAt ? stampLong(r.dueAt, now) : "No date" });
  if (r.originLabel) meta.push({ label: "Source", value: r.originLabel.replace(/^from /, "") });

  for (const link of db.select().from(s.links).where(eq(s.links.fromId, r.id)).orderBy(asc(s.links.rel)).all()) {
    const [workflow] = db.select({ name: s.workflows.name }).from(s.workflows).where(eq(s.workflows.id, link.toId)).limit(1).all();
    if (workflow) meta.push({ label: link.rel === "blocks" ? "Blocks" : "About", value: workflow.name });
  }

  for (const pair of db
    .select()
    .from(s.attributes)
    .where(and(eq(s.attributes.subjectId, r.id), eq(s.attributes.groupSlot, "meta")))
    .orderBy(asc(s.attributes.ordinal))
    .all()) {
    meta.push({ label: pair.label, value: pair.value });
  }
  return meta;
}

