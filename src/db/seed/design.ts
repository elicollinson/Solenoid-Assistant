// Load the design's content into SQLite.
//
// The write order is the one the schema demands and the tests document:
// an entity row first, then anything the domain row points at, then the domain
// row. Foreign keys are not deferrable, so a reminder that names a decision
// needs that decision to already exist.
//
// Idempotent by deletion: every seeded row belongs to one of the tables cleared
// at the top, and `entities` cascades into the rest. Re-running rebuilds the
// projection rather than doubling it.
import { inArray, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "../index";
import { ulid } from "../ids";
import * as s from "../schema";
import { ACTIVITY, OVERNIGHT_LEDE, RECOMMENDATIONS_LEDE, REMINDERS, WORKFLOWS } from "./fixtures";
import { CALENDAR, CALENDAR_RESTRAINT, WEEKDAYS, type Clock, type DayAnchor } from "./calendar";
import { REMINDER_DETAIL, type EvidenceFixture } from "./reminders";
import {
  PHONE_CALENDAR_DAYS,
  PHONE_CALENDAR_RESTRAINT,
  PHONE_KNOWLEDGE_LINE,
  PHONE_KNOWLEDGE_RESTRAINT,
  PHONE_OVERNIGHT_LEDE,
  PHONE_WORKFLOWS_LINE,
  PHONE_WORKFLOWS_RESTRAINT,
  PHONE_WORKFLOW_LEDE,
  PHONE_WORKFLOW_SHEET,
} from "./phone";
import { WORKFLOW_RUNS, type RunFixture, type RunStart, type TraceFixture } from "./runs";
import { localDateKey, localTime, localWeekday } from "./time";
// A display formatter, used where the seed writes a display string: "offered
// Aug 22" is a pair the agent wrote, but the date in it has to move with the
// anchor or it is three days ago only on the day the seed happened to run.
import { shortDay } from "../queries/_format";

/** The handle a transaction callback receives — a Db without `$client`. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface SeedResult {
  workflows: number;
  runs: number;
  runSteps: number;
  activityItems: number;
  reminders: number;
  calendar: number;
  decisions: number;
  actions: number;
  evidence: number;
  sources: number;
}

/**
 * Wipe everything the seed owns. `entities` cascades into the domain tables,
 * so the standalone tables are the only ones that need naming.
 *
 * The exception is the OKF projection. Its rows are entities too, so an
 * unqualified `delete from entities` cascades straight through okf_objects and
 * okf_fields and takes "Things I know" with it — the store on disk is untouched
 * but the screen reads empty until someone thinks to re-index. The seed never
 * writes those rows, so it has no business deleting them.
 */
function clear(tx: Tx): void {
  // The ids the projection owns. Three of the deletes below have to step around
  // them, because subject_events and links carry OKF rows as well as seeded ones.
  const okfIds = tx
    .select({ id: s.entities.id })
    .from(s.entities)
    .where(inArray(s.entities.kind, [...s.OKF_ENTITY_KIND]));

  tx.delete(s.actions).run();
  tx.delete(s.narratives).run();
  // The reindexer writes one `okf_log` event per line of an object's chronology.
  tx.delete(s.subjectEvents).where(notInArray(s.subjectEvents.subjectId, okfIds)).run();
  // Its links are backlinks between two OKF objects; anything with one end
  // outside the store was written here and goes.
  tx.delete(s.links)
    .where(or(notInArray(s.links.fromId, okfIds), notInArray(s.links.toId, okfIds)))
    .run();
  tx.delete(s.evidenceLinks).run();
  tx.delete(s.attributes).run();
  tx.delete(s.runLogs).run();
  tx.delete(s.runEffects).run();
  tx.delete(s.workflowSchedules).run();
  tx.delete(s.workflowInstructions).run();
  tx.delete(s.workflowVersions).run();
  tx.delete(s.surfaceNotes).run();
  tx.delete(s.entities).where(notInArray(s.entities.kind, [...s.OKF_ENTITY_KIND])).run();
  tx.delete(s.settings).run();
}

export function seedDesignFixtures(db: Db, options: { now?: Date } = {}): SeedResult {
  const now = options.now ?? new Date();
  const at = (o: { dayOffset: number; hour: number; minute: number }) => localTime(now, o.dayOffset, o.hour, o.minute);
  const started = (start: RunStart) =>
    "minutesAgo" in start ? new Date(now.getTime() - start.minutesAgo * 60_000) : at(start);

  return db.transaction((t) => {
    clear(t);

    /** Mint an entity and return its id. Every citable row starts here. */
    const entity = (kind: s.EntityKind, createdAt: Date = now): string => {
      const id = ulid(createdAt.getTime());
      t.insert(s.entities).values({ id, kind, createdAt, updatedAt: now }).run();
      return id;
    };

    // `surface` defaults to "any" — one copy that reads the same on either
    // frame, which is what almost everything the agent writes is. The phone
    // slots below are the exception, and they say so.
    const narrate = (
      subjectId: string,
      slot: (typeof s.NARRATIVE_SLOT)[number],
      text: string,
      generatedAt: Date = now,
      ordinal = 0,
      surface: (typeof s.SURFACE)[number] = "any",
    ) => t.insert(s.narratives).values({ id: ulid(), subjectId, slot, surface, text, ordinal, generatedAt }).run();

    let actionCount = 0;
    const addActions = (
      subjectId: string,
      decisionId: string | null,
      list: readonly { label: string; stance: string; effectKind: string; effect?: Record<string, unknown> }[],
    ) => {
      list.forEach((a, i) => {
        t.insert(s.actions)
          .values({
            id: ulid(),
            subjectId,
            decisionId,
            ordinal: i,
            label: a.label,
            stance: a.stance as (typeof s.ACTION_STANCE)[number],
            effectKind: a.effectKind as (typeof s.ACTION_EFFECT_KIND)[number],
            effect: a.effect ?? {},
            destructive: a.stance === "danger",
            createdAt: now,
          })
          .run();
        actionCount += 1;
      });
    };

    // Two identities, minted once: every run transcript is a conversation
    // between the same two parties.
    const you = entity("participant");
    t.insert(s.participants).values({ id: you, kind: "self", displayName: "You", trustState: "trusted", createdAt: now }).run();
    const agent = entity("participant");
    t.insert(s.participants).values({ id: agent, kind: "agent", displayName: "Solenoid", trustState: "trusted", createdAt: now }).run();

    /** The run transcript, as a conversation in the same stack as mail and texts. */
    function seedTranscript(title: string, turns: readonly { who: "you" | "agent"; text: string }[], startedAt: Date): string {
      const id = entity("conversation", startedAt);
      // A minute apart is a placeholder: the design's turns carry no clock.
      const sentAt = (i: number) => new Date(startedAt.getTime() + i * 60_000);
      t.insert(s.conversations)
        .values({
          id,
          channel: "agent_chat",
          title,
          isGroup: false,
          startedAt,
          lastMessageAt: sentAt(turns.length - 1),
          messageCount: turns.length,
          trustState: "trusted",
          safetyState: "clean",
        })
        .run();
      for (const role of ["me", "agent"] as const) {
        t.insert(s.conversationParticipants)
          .values({ conversationId: id, participantId: role === "me" ? you : agent, role })
          .run();
      }
      turns.forEach((turn, i) => {
        const messageId = entity("message", sentAt(i));
        t.insert(s.messages)
          .values({
            id: messageId,
            conversationId: id,
            seq: i,
            senderId: turn.who === "you" ? you : agent,
            direction: turn.who === "you" ? "outbound" : "inbound",
            sentAt: sentAt(i),
            body: turn.text,
            sentBy: turn.who === "you" ? "user" : "agent",
            safetyState: "clean",
          })
          .run();
      });
      return id;
    }

    /**
     * The trace, flattened depth-first with one ordinal for the whole run.
     *
     * The unique index is (run, parent, ordinal), so a per-parent counter would
     * satisfy it — but then the feed's collapsed tool calls, which order by
     * ordinal alone, would interleave a child of step 2 with a child of step 1.
     * A single counter in document order is what makes the flat read correct.
     */
    let stepCount = 0;
    function seedTrace(runId: string, nodes: readonly TraceFixture[], startedAt: Date): void {
      let ordinal = 0;
      const walk = (list: readonly TraceFixture[], parentId: string | null, depth: number) => {
        for (const node of list) {
          const id = entity("run_step", startedAt);
          t.insert(s.runSteps)
            .values({
              id,
              runId,
              parentId,
              ordinal: ordinal++,
              depth,
              name: node.name,
              detail: node.detail ?? null,
              note: node.note ?? null,
              state: node.state ?? "ok",
              isTool: node.tool === true,
              toolName: node.tool ? node.name : null,
              durationMs: node.durationMs ?? null,
              startedAt,
            })
            .run();
          stepCount += 1;
          if (node.children) walk(node.children, id, depth + 1);
        }
      };
      walk(nodes, null, 0);
    }

    /** "06:12:04.221" on the run's own day. */
    function logInstant(day: { dayOffset: number; hour: number; minute: number }, stamp: string): Date {
      const [hh, mm, rest] = stamp.split(":");
      const [ss, ms] = (rest ?? "0.0").split(".");
      const base = at({ dayOffset: day.dayOffset, hour: Number(hh), minute: Number(mm) });
      return new Date(base.getTime() + Number(ss) * 1000 + Number(ms ?? 0));
    }

    // ── workflows and everything they have ever run ──────────────────────
    const workflowId = new Map<string, string>();
    const runIdByOrdinal = new Map<string, string>();
    let runCount = 0;

    for (const w of WORKFLOWS) {
      const id = entity("workflow");
      const pausedAt = w.pausedDayOffset != null ? localTime(now, w.pausedDayOffset, 9, 0) : null;
      t.insert(s.workflows)
        .values({
          id,
          slug: w.slug,
          name: w.name,
          triggerKind: w.trigger,
          enabled: pausedAt == null,
          pausedAt,
          pausedBy: pausedAt ? "user" : null,
          pauseReason: pausedAt ? "You paused this and didn't say for how long." : null,
          createdAt: now,
        })
        .run();
      workflowId.set(w.slug, id);

      const versionId = ulid();
      t.insert(s.workflowVersions)
        .values({ id: versionId, workflowId: id, version: 1, config: { cadence: w.cadence }, createdAt: now, createdBy: "user" })
        .run();
      t.update(s.workflows).set({ currentVersionId: versionId }).where(sql`${s.workflows.id} = ${id}`).run();

      if (w.rrule) {
        t.insert(s.workflowSchedules)
          .values({
            id: ulid(),
            workflowId: id,
            rrule: w.rrule,
            enabled: pausedAt == null,
            label: w.cadence,
            nextRunAt: w.nextRun && pausedAt == null ? at(w.nextRun) : null,
          })
          .run();
      }

      if (w.instruction) {
        t.insert(s.workflowInstructions)
          .values({ id: ulid(), workflowId: id, text: w.instruction, authoredBy: "user", effectiveFrom: now })
          .run();
      }

      const record = WORKFLOW_RUNS[w.slug];
      if (!record) throw new Error(`workflow ${w.slug} has no run record`);
      narrate(id, "summary", record.summary);
      // The phone's two: one sentence for the row, one for the sheet it opens.
      // Written rather than derived, because shortening the summary above by
      // machine is how a workflow ends up claiming something it did not do.
      const rowLede = PHONE_WORKFLOW_LEDE[w.slug];
      if (rowLede) narrate(id, "lede", rowLede, now, 0, "phone");
      const sheet = PHONE_WORKFLOW_SHEET[w.slug];
      if (sheet) narrate(id, "sheet", sheet, now, 0, "phone");

      // Lifetime tallies. Everything else on this surface is counted at read
      // time; these are history the seed holds no rows for.
      t.insert(s.attributes)
        .values({ id: ulid(), subjectId: id, groupSlot: "stats", ordinal: 0, label: "Runs", value: String(record.runsTotal), valueKind: "count" })
        .run();
      t.insert(s.attributes)
        .values({ id: ulid(), subjectId: id, groupSlot: "stats", ordinal: 1, label: "Clean runs", value: String(record.cleanRuns), valueKind: "count" })
        .run();

      for (const run of record.runs) {
        seedRun(w.slug, id, versionId, run);
        runCount += 1;
      }

      const latest = record.runs[0];
      if (latest) {
        t.update(s.workflows)
          .set({ lastRunId: runIdByOrdinal.get(`${w.slug}/${latest.ordinal}`) })
          .where(sql`${s.workflows.id} = ${id}`)
          .run();
      }
    }

    function seedRun(slug: string, wfId: string, versionId: string, run: RunFixture): void {
      const startedAt = started(run.start);
      const endedAt = run.durationMs == null ? null : new Date(startedAt.getTime() + run.durationMs);

      // The conversation has to exist before the run row that names it.
      const transcriptId = run.transcript?.length
        ? seedTranscript(`${slug} · run ${run.ordinal}`, run.transcript, startedAt)
        : null;

      const runId = entity("workflow_run", startedAt);
      t.insert(s.workflowRuns)
        .values({
          id: runId,
          workflowId: wfId,
          versionId,
          ordinal: run.ordinal,
          trigger: run.trigger,
          triggeredBy: run.trigger === "manual" ? "user" : "system",
          state: run.state,
          stepIndex: run.step.index,
          stepTotal: run.step.total,
          startedAt,
          endedAt,
          durationMs: run.durationMs,
          transcriptConversationId: transcriptId,
        })
        .run();
      runIdByOrdinal.set(`${slug}/${run.ordinal}`, runId);

      if (run.trace) seedTrace(runId, run.trace, startedAt);

      run.effects?.forEach((text, i) => {
        t.insert(s.runEffects).values({ id: ulid(), runId, ordinal: i, text, effectKind: "note" }).run();
      });

      run.prose?.forEach((text, i) => narrate(runId, "summary", text, startedAt, i));

      if (run.logs && !("minutesAgo" in run.start)) {
        const day = run.start;
        run.logs.forEach((line, i) => {
          t.insert(s.runLogs)
            .values({ runId, at: logInstant(day, line.t), seq: i, level: line.level, text: line.text })
            .run();
        });
      }
    }

    // ── the feed ─────────────────────────────────────────────────────────
    let decisionCount = 0;
    for (const item of ACTIVITY) {
      const occurredAt = at(item.at);
      const wfId = workflowId.get(item.workflowSlug);
      if (!wfId) throw new Error(`activity ${item.key} names an unknown workflow ${item.workflowSlug}`);
      const runId = runIdByOrdinal.get(`${item.workflowSlug}/${item.runOrdinal}`);
      if (!runId) throw new Error(`activity ${item.key} names run ${item.runOrdinal} of ${item.workflowSlug}, which is not seeded`);

      const itemId = entity("activity_item", occurredAt);

      // A decision must exist before the row that names it.
      let decisionId: string | null = null;
      if (item.decision) {
        decisionId = entity("decision", occurredAt);
        t.insert(s.decisions)
          .values({
            id: decisionId,
            subjectId: itemId,
            title: item.decision.title,
            body: item.decision.body,
            state: "open",
            blocking: item.decision.blocking,
            openedAt: occurredAt,
          })
          .run();
        decisionCount += 1;
      }

      t.insert(s.activityItems)
        .values({
          id: itemId,
          occurredAt,
          state: item.state,
          title: item.title,
          badge: item.badge ?? null,
          prominence: item.prominent ? "prominent" : "quiet",
          framed: item.framed,
          sourceId: runId,
          workflowId: wfId,
          runId,
          decisionId,
          toolSummary: item.toolSummary ?? null,
          progressValue: item.progress?.value ?? null,
          progressTotal: item.progress?.total ?? null,
        })
        .run();

      narrate(itemId, "account", item.account, occurredAt);
      if (item.actions) addActions(itemId, decisionId, item.actions);
    }

    // ── the artifacts a reminder cites ───────────────────────────────────
    //
    // Every evidence kind lands in a real table: a text, an email and a chat
    // are all conversations, a capture is a screenshot with an analysis and
    // its regions, and an article is a fetched web document. Nothing here is
    // an "evidence row" — evidence is the link, and the link is what carries
    // why the agent kept it.
    const participantByName = new Map<string, string>();
    let sourceCount = 0;
    let evidenceCount = 0;

    /** One identity per counterparty, however many handles they turn up with. */
    function counterparty(who: { name: string; kind: "person" | "org"; phone?: string; email?: string }): string {
      let id = participantByName.get(who.name);
      if (!id) {
        id = entity("participant");
        t.insert(s.participants)
          .values({ id, kind: who.kind, displayName: who.name, trustState: "known", createdAt: now })
          .run();
        participantByName.set(who.name, id);
      }
      for (const [kind, value] of [["phone", who.phone], ["email", who.email]] as const) {
        if (!value) continue;
        t.insert(s.participantHandles)
          .values({ id: ulid(), participantId: id, kind, value, isPrimary: true })
          .onConflictDoNothing()
          .run();
      }
      return id;
    }

    /** A text, an email or a chat with me. One stack, three channels. */
    function seedConversation(e: EvidenceFixture): string {
      const startedAt = at(e.at);
      const id = entity("conversation", startedAt);
      const them = e.counterparty ? counterparty(e.counterparty) : null;
      const turns = e.turns ?? [];
      const lastAt = turns.length ? at(turns[turns.length - 1]!.at) : startedAt;

      t.insert(s.conversations)
        .values({
          id,
          channel: e.kind === "chat" ? "agent_chat" : e.kind === "email" ? "email" : "imessage",
          externalId: e.externalId ?? null,
          title: e.title,
          counterpartyLabel: e.counterpartyLabel ?? null,
          subject: e.email?.subject ?? null,
          isGroup: false,
          startedAt,
          lastMessageAt: lastAt,
          messageCount: e.email ? 1 : turns.length,
          trustState: e.kind === "chat" ? "trusted" : "known",
          safetyState: "clean",
        })
        .run();

      t.insert(s.conversationParticipants).values({ conversationId: id, participantId: you, role: "me" }).run();
      if (e.kind === "chat") {
        t.insert(s.conversationParticipants).values({ conversationId: id, participantId: agent, role: "agent" }).run();
      }
      if (them) t.insert(s.conversationParticipants).values({ conversationId: id, participantId: them, role: "them" }).run();

      if (e.email) {
        const mail = e.email;
        const sentAt = at(e.at);
        const outbound = mail.fromAddr.startsWith("you@");
        const messageId = entity("message", sentAt);
        t.insert(s.messages)
          .values({
            id: messageId,
            conversationId: id,
            seq: 0,
            senderId: outbound ? you : them,
            direction: outbound ? "outbound" : "inbound",
            sentAt,
            body: mail.body.join("\n\n"),
            isDraft: mail.draft === true,
            draftedByRunId: mail.draftedBy ? (runIdByOrdinal.get(`${mail.draftedBy.slug}/${mail.draftedBy.ordinal}`) ?? null) : null,
            sentBy: mail.draft ? "agent" : outbound ? "user" : null,
            hasAttachments: (mail.attachments?.length ?? 0) > 0,
            safetyState: "clean",
          })
          .run();
        t.insert(s.emailMessages)
          .values({
            messageId,
            fromAddr: mail.fromAddr,
            toAddrs: [mail.toAddr],
            subject: mail.subject,
            snippet: mail.body[0] ?? null,
            quotedText: mail.quoted?.join("\n") ?? null,
          })
          .run();
        for (const a of mail.attachments ?? []) {
          const attachmentId = entity("attachment", sentAt);
          t.insert(s.attachments)
            .values({ id: attachmentId, messageId, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes })
            .run();
        }
      }

      turns.forEach((turn, i) => {
        const sentAt = at(turn.at);
        const messageId = entity("message", sentAt);
        t.insert(s.messages)
          .values({
            id: messageId,
            conversationId: id,
            seq: i,
            senderId: turn.who === "you" ? you : turn.who === "agent" ? agent : them,
            direction: turn.who === "you" ? "outbound" : "inbound",
            sentAt,
            body: turn.text,
            sentBy: turn.who === "you" ? "user" : turn.who === "agent" ? "agent" : null,
            safetyState: "clean",
          })
          .run();
      });

      return id;
    }

    /** A capture, the analysis that read it, and the regions that analysis found. */
    function seedScreenshot(e: EvidenceFixture): string {
      const shot = e.shot!;
      const capturedAt = at(e.at);
      const id = entity("screenshot", capturedAt);
      t.insert(s.screenshots)
        .values({
          id,
          originalFilename: shot.file,
          capturedAt,
          addedAt: capturedAt,
          width: shot.width,
          height: shot.height,
          uti: "public.png",
          origin: "agent_capture",
          captureContext: shot.context,
          capturedBy: "agent",
          capturedInRunId: shot.capturedIn ? (runIdByOrdinal.get(`${shot.capturedIn.slug}/${shot.capturedIn.ordinal}`) ?? null) : null,
          safetyState: "clean",
          ingestState: "ingested",
        })
        .run();

      // Versioned: re-running OCR next month must not rewrite what I saw.
      const analysisId = ulid();
      t.insert(s.screenshotAnalyses)
        .values({
          id: analysisId,
          screenshotId: id,
          version: 1,
          isCurrent: true,
          summary: shot.summary,
          ocrText: shot.text ?? null,
          createdAt: capturedAt,
        })
        .run();
      shot.regions.forEach((region, i) => {
        t.insert(s.screenshotRegions)
          .values({ id: ulid(), analysisId, ordinal: i, label: region.label, note: region.note })
          .run();
      });
      return id;
    }

    function seedArticle(e: EvidenceFixture): string {
      const a = e.article!;
      const retrievedAt = at(e.at);
      const id = entity("web_document", retrievedAt);
      t.insert(s.webDocuments)
        .values({
          id,
          url: a.url,
          canonicalUrl: a.url,
          siteLabel: a.site,
          headline: a.headline,
          byline: a.byline ?? null,
          retrievedAt,
          wordCount: a.words,
          bodyText: a.body.join("\n\n"),
          httpStatus: 200,
          safetyState: "clean",
        })
        .run();
      return id;
    }

    /**
     * The link, not the artifact.
     *
     * `why` and the pin both live here rather than on the source, because the
     * same email cited from a reminder and from an OKF field earns a different
     * sentence and a different clause. The pin is the quote itself: a
     * paragraph index breaks the moment a page is re-fetched.
     */
    function seedEvidence(subjectId: string, list: readonly EvidenceFixture[]): void {
      list.forEach((e, i) => {
        const sourceId = e.shot ? seedScreenshot(e) : e.article ? seedArticle(e) : seedConversation(e);
        sourceCount += 1;
        const quote =
          e.email?.pinned != null
            ? (e.email.body[e.email.pinned] ?? null)
            : e.article?.pinned != null
              ? (e.article.body[e.article.pinned] ?? null)
              : (e.turns?.find((turn) => turn.pinned)?.text ?? null);
        t.insert(s.evidenceLinks)
          .values({
            id: ulid(),
            subjectId,
            sourceId,
            ordinal: i,
            title: e.title,
            why: e.why,
            pinKind: quote ? "range" : "whole",
            pinQuote: quote,
            addedBy: "agent",
            addedAt: at(e.at),
          })
          .run();
        evidenceCount += 1;
      });
    }

    // ── reminders ────────────────────────────────────────────────────────
    //
    // Kept by key, because the two boiler windows on the calendar settle the
    // same question this reminder opened. One decision, two rows offering it.
    const reminderDecisionByKey = new Map<string, string>();

    for (const r of REMINDERS) {
      const id = entity("reminder", at(r.setAt));
      const detail = REMINDER_DETAIL[r.key];
      if (!detail) throw new Error(`reminder ${r.key} has no detail record`);

      // The rule this is an instance of. Not scoped to a workflow: "anything
      // that commits money waits for me" is a rule about you, not about a job.
      let instructionId: string | null = null;
      if (detail.instruction) {
        instructionId = ulid();
        t.insert(s.workflowInstructions)
          .values({ id: instructionId, workflowId: null, text: detail.instruction, authoredBy: "user", effectiveFrom: at(r.setAt) })
          .run();
      }

      let decisionId: string | null = null;
      if (r.decision) {
        decisionId = entity("decision");
        t.insert(s.decisions)
          .values({
            id: decisionId,
            subjectId: id,
            title: r.decision.title,
            body: r.decision.body,
            state: "open",
            blocking: false,
            openedAt: now,
            dueAt: r.due ? at(r.due) : null,
          })
          .run();
        decisionCount += 1;
      }

      t.insert(s.reminders)
        .values({
          id,
          title: r.title,
          state: r.state,
          dueAt: r.due ? at(r.due) : null,
          setBy: "agent",
          setAt: at(r.setAt),
          originKind: "manual",
          originLabel: r.originLabel,
          completedAt: r.completed ? at(r.completed) : null,
          completedBy: r.completed ? "user" : null,
          completedReason: r.completed ? r.note : null,
          decisionId,
          instructionId,
        })
        .run();

      // The row's one line and the detail's account are different pieces of
      // writing, so they are different slots rather than the same text twice.
      narrate(id, "blurb", r.note, at(r.setAt));
      detail.prose.forEach((text, i) => narrate(id, "account", text, at(r.setAt), i));

      detail.meta?.forEach((pair, i) => {
        t.insert(s.attributes)
          .values({ id: ulid(), subjectId: id, groupSlot: "meta", ordinal: i, label: pair.label, value: pair.value })
          .run();
      });

      for (const [rel, slug] of [["blocks", detail.blocks], ["about", detail.about]] as const) {
        if (!slug) continue;
        const target = workflowId.get(slug);
        if (!target) throw new Error(`reminder ${r.key} names an unknown workflow ${slug}`);
        t.insert(s.links).values({ id: ulid(), fromId: id, toId: target, rel, createdAt: at(r.setAt), createdBy: "agent" }).run();
      }

      for (const h of detail.history) {
        t.insert(s.subjectEvents)
          .values({ id: ulid(), subjectId: id, at: at(h.at), actor: h.by ?? "agent", eventKind: "note", text: h.text })
          .run();
      }

      if (decisionId) reminderDecisionByKey.set(r.key, decisionId);
      if (detail.actions) addActions(id, decisionId, detail.actions);
      if (detail.evidence) seedEvidence(id, detail.evidence);
    }

    // ── the week ─────────────────────────────────────────────────────────
    //
    // Events and holds only. A run and a reminder on this canvas are
    // projections of rows that already exist, built at query time, so there is
    // nothing to write for them here and no second copy of them to drift.
    const dayOffsetOf = (anchor: DayAnchor): number =>
      "dayOffset" in anchor ? anchor.dayOffset : (WEEKDAYS.indexOf(anchor.weekday) - localWeekday(now) + 7) % 7;
    const clockAt = (anchor: DayAnchor, c: Clock) => localTime(now, dayOffsetOf(anchor), c.hour, c.minute);

    for (const c of CALENDAR) {
      const startsAt = clockAt(c.day, c.start);
      const id = entity("calendar_item", startsAt);
      const holdGroupId = c.hold ? `hold-${c.hold.groupKey}` : null;
      // A hold does not open a question of its own — it is one of the answers
      // to a question the reminder already asked.
      const decisionId = c.hold ? (reminderDecisionByKey.get(c.hold.decisionOf) ?? null) : null;

      t.insert(s.calendarItems)
        .values({
          id,
          kind: c.kind,
          title: c.title,
          metaLabel: c.meta,
          location: c.location ?? null,
          startsAt,
          endsAt: clockAt(c.day, c.end),
          // Nothing is agreed until you pick one, and the column says so.
          status: c.kind === "hold" ? "tentative" : "confirmed",
          provider: "local",
          setBy: c.setBy,
          movedFromAt: c.movedFrom ? clockAt(c.movedFrom, c.start) : null,
          movedBy: c.movedFrom ? "agent" : null,
          movedReason: c.movedReason ?? null,
          holdGroupId,
          decisionId,
        })
        .run();

      if (c.rrule) t.insert(s.calendarRecurrences).values({ itemId: id, rrule: c.rrule }).run();

      if (c.hold && holdGroupId) {
        t.insert(s.calendarHolds)
          .values({
            id,
            holdGroupId,
            offeredById: counterparty({ name: c.hold.offeredBy, kind: "org" }),
            offeredAt: at(c.hold.offered),
            clashNote: c.hold.clashNote,
          })
          .run();
      }

      c.account.forEach((text, i) => narrate(id, "account", text, startsAt, i));

      // Kind, where, who set it, what it moved off and how often it repeats are
      // all read off the row. These are the ones only the agent knows.
      let pairOrdinal = 0;
      for (const [label, value] of c.pairs ?? []) {
        t.insert(s.attributes)
          .values({ id: ulid(), subjectId: id, groupSlot: "meta", ordinal: pairOrdinal++, label, value })
          .run();
      }
      for (const pair of c.datedPairs ?? []) {
        t.insert(s.attributes)
          .values({
            id: ulid(),
            subjectId: id,
            groupSlot: "meta",
            ordinal: pairOrdinal++,
            label: pair.label,
            value: shortDay(localTime(now, pair.dayOffset, 12)),
            valueKind: "timestamp",
          })
          .run();
      }

      if (c.affirm && c.quiet) {
        addActions(id, decisionId, [
          { label: c.affirm, stance: "affirm", effectKind: "custom", effect: { key: c.key } },
          { label: c.quiet, stance: "quiet", effectKind: "custom", effect: { key: c.key } },
        ]);
      }
    }

    // The half of the day's line that is not a count of the day below it.
    t.insert(s.surfaceNotes)
      .values({
        id: ulid(),
        screen: "calendar",
        onDate: localDateKey(now),
        surface: "desktop",
        slot: "restraint",
        text: CALENDAR_RESTRAINT,
        generatedAt: now,
      })
      .run();

    // The phone draws one day rather than the week, so it wants a line about
    // each day instead of one about all seven.
    //
    // Two anchors resolve onto one date whenever an offset lands on a named
    // weekday — offset 2 is Thursday if the seed runs on a Tuesday — and the
    // unique index would refuse the second write. The map is what settles it:
    // the offset-anchored lines go in last and win, because day zero is what
    // the screen opens on and the days after it are read in its terms.
    const phoneDayLine = new Map<string, string>();
    for (const { day, text } of PHONE_CALENDAR_DAYS) {
      if ("weekday" in day) phoneDayLine.set(localDateKey(localTime(now, dayOffsetOf(day), 12)), text);
    }
    for (const { day, text } of PHONE_CALENDAR_DAYS) {
      if ("dayOffset" in day) phoneDayLine.set(localDateKey(localTime(now, day.dayOffset, 12)), text);
    }
    for (const [onDate, text] of phoneDayLine) {
      t.insert(s.surfaceNotes)
        .values({ id: ulid(), screen: "calendar", onDate, surface: "phone", slot: "line", text, generatedAt: now })
        .run();
    }

    // ── standing suggestions ─────────────────────────────────────────────
    //
    // None. The Recommendations surface is written by the agent at runtime
    // through src/db/mutations/recommendations.ts, so the seed leaves the table
    // empty: a suggestion is a claim about work that actually happened, and one
    // transcribed from a design file is a claim about nothing.
    //
    // The screen's lede below is still seeded, because a lede is authored copy
    // about the screen rather than a row on it. With no rows the surface reads
    // "…Nothing is waiting on you right now.", which is true.
    //
    // The Activity aside's "worth a look" card reads the newest proposed
    // recommendation straight off this table (src/db/queries/home.ts), so it
    // draws nothing until the agent forms one. `worthALook` is already nullable
    // and AgentAside already handles the null.


    // ── app copy that is authored, not derived ───────────────────────────
    //
    // The half of each screen's lede that is a sentence rather than a count.
    // These sat in `settings` until the Settings screen arrived and made that
    // table mean "what I run on"; a lede is not something you configure.
    const screenLine = (
      screen: s.Screen,
      text: string,
      onDate: string | null = null,
      surface: "desktop" | "phone" = "desktop",
      slot: (typeof s.SURFACE_NOTE_SLOT)[number] = "line",
    ) =>
      t
        .insert(s.surfaceNotes)
        .values({ id: ulid(), screen, surface, slot, onDate, text, generatedAt: now })
        .run();

    screenLine("home", OVERNIGHT_LEDE, localDateKey(now));
    screenLine("workflows", "Everything I run for you, on a schedule or on demand.");
    screenLine("reminders", "Things I'm holding for you rather than acting on.");
    screenLine("recommendations", RECOMMENDATIONS_LEDE);

    // The phone's own words for the same screens. Only the four the design
    // draws at 390px: Reminders and Recommendations have no phone screen, so
    // writing them a phone line would be writing copy nothing reads.
    //
    // Things I know is the odd one — the desktop counts the store in its
    // opening sentence and the phone does not, so this is the opening only and
    // the clauses about what is unsettled are still counted at read time.
    screenLine("home", PHONE_OVERNIGHT_LEDE, localDateKey(now), "phone");
    screenLine("workflows", PHONE_WORKFLOWS_LINE, null, "phone");
    screenLine("workflows", PHONE_WORKFLOWS_RESTRAINT, null, "phone", "restraint");
    screenLine("knowledge", PHONE_KNOWLEDGE_LINE, null, "phone");
    screenLine("knowledge", PHONE_KNOWLEDGE_RESTRAINT, null, "phone", "restraint");
    screenLine("calendar", PHONE_CALENDAR_RESTRAINT, null, "phone", "restraint");

    t.insert(s.settings)
      .values({ key: "user.displayName", value: "Eli", source: "user", updatedAt: now, updatedBy: "user" })
      .run();

    return {
      workflows: WORKFLOWS.length,
      runs: runCount,
      runSteps: stepCount,
      activityItems: ACTIVITY.length,
      reminders: REMINDERS.length,
      calendar: CALENDAR.length,
      decisions: decisionCount,
      actions: actionCount,
      evidence: evidenceCount,
      sources: sourceCount,
    };
  });
}
