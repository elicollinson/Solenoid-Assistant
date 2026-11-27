import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  SOLENOID_METADATA_KEY,
  deriveSessionTitle,
  type CheckpointRecord,
  type CheckpointStore,
  type LoadedSession,
  type ReconciledSession,
  type SaveCheckpointInput,
  type SavedCheckpointMeta,
  type SessionSummary,
} from "@elicollinson/solenoid-engine";
import {
  AlreadySettledError,
  ApprovalNotFoundError,
  type ApprovalChoice,
  type ApprovalExecutionOutcome,
  type ApprovalFact,
  type ApprovalOutcome,
  type ApprovalRecord,
  type ApprovalStatus,
  type ApprovalStore,
  type CreateApprovalInput,
  type SettleApprovalInput,
} from "@elicollinson/solenoid-security";
import { ulid, type Db } from "./index";
import * as s from "./schema";
import { clearSlot, narrate, touch, writePairs, type Tx } from "./mutations/_shared";
import { nextApprovalRef } from "./mutations/chat";

/** Metadata label under `attributes` (`group_slot = 'meta'`) holding lossless approval details. */
export const APPROVAL_META_LABEL = "approval_meta";

export interface StoredApprovalMeta {
  mode: "blocking" | "deferred";
  tool: string;
  capability: string;
  args: unknown;
  argsDigest: string;
  scope?: Record<string, unknown>;
  expiresAt?: string;
  outcome?: ApprovalOutcome | null;
  settledAt?: string;
  execution?: ApprovalExecutionOutcome;
}

type DbLike = Db | Tx;

function toSessionSummary(row: typeof s.chatSessions.$inferSelect): SessionSummary {
  return {
    id: row.id,
    ...(row.parentId ? { parentId: row.parentId } : {}),
    title: row.title,
    status: row.status,
    originDeviceId: row.originDeviceId,
    originDeviceName: row.originDeviceName,
    lastDeviceId: row.lastDeviceId,
    lastDeviceName: row.lastDeviceName,
    lastSeq: row.lastSeq,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCheckpointRecord(row: typeof s.chatCheckpoints.$inferSelect): CheckpointRecord {
  return {
    sessionId: row.sessionId,
    seq: row.seq,
    kind: row.kind,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    committed: Boolean(row.committed),
    turnStartSeq: row.turnStartSeq,
    transcript: row.transcript,
    thread: row.thread,
    ...(row.pending != null ? { pending: row.pending } : {}),
    createdAt: row.createdAt,
  };
}

function extractVoiceMetadata(
  input: Pick<SaveCheckpointInput, "transcript" | "thread">,
): { voiceDetected: boolean; model?: string } {
  let voiceDetected = false;
  let model: string | undefined;

  const inspect = (items: readonly unknown[]) => {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const metadata = (item as { metadata?: unknown }).metadata;
      if (!metadata || typeof metadata !== "object") continue;
      const solenoid = (metadata as Record<string, unknown>)[SOLENOID_METADATA_KEY];
      if (!solenoid || typeof solenoid !== "object") continue;
      const rec = solenoid as { source?: unknown; model?: unknown };
      if (rec.source === "voice") {
        voiceDetected = true;
        if (typeof rec.model === "string" && rec.model.trim()) {
          model = rec.model.trim();
        }
      }
    }
  };

  inspect(input.thread);
  inspect(input.transcript);
  return { voiceDetected, ...(model ? { model } : {}) };
}

/**
 * Drizzle-backed implementation of `solenoid-engine`'s `CheckpointStore` persisted
 * inside `data/solenoid.db` (`STRICT` tables `chat_sessions` & `chat_checkpoints`).
 */
export class DrizzleCheckpointStore implements CheckpointStore {
  constructor(readonly db: Db) {}

  save(input: SaveCheckpointInput): Promise<SavedCheckpointMeta> {
    const nowDate = new Date();
    const now = nowDate.toISOString();

    const meta = this.db.transaction((tx): SavedCheckpointMeta => {
      const existing = tx
        .select({
          lastSeq: s.chatSessions.lastSeq,
          title: s.chatSessions.title,
        })
        .from(s.chatSessions)
        .where(eq(s.chatSessions.id, input.sessionId))
        .get();

      const seq = (existing?.lastSeq ?? 0) + 1;
      const turnStartSeq = input.turnStartSeq ?? seq;
      const title =
        input.title ??
        (existing?.title && existing.title !== "Untitled session"
          ? existing.title
          : deriveSessionTitle(input.transcript));

      tx.insert(s.chatSessions)
        .values({
          id: input.sessionId,
          parentId: input.parentId ?? null,
          title,
          status: input.status,
          originDeviceId: input.device.id,
          originDeviceName: input.device.name,
          lastDeviceId: input.device.id,
          lastDeviceName: input.device.name,
          lastSeq: seq,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: s.chatSessions.id,
          set: {
            title,
            status: input.status,
            lastDeviceId: input.device.id,
            lastDeviceName: input.device.name,
            lastSeq: seq,
            updatedAt: now,
          },
        })
        .run();

      tx.insert(s.chatCheckpoints)
        .values({
          sessionId: input.sessionId,
          seq,
          kind: input.kind,
          deviceId: input.device.id,
          deviceName: input.device.name,
          committed: Boolean(input.committed),
          turnStartSeq,
          transcript: [...input.transcript],
          thread: [...input.thread],
          pending: input.pending ?? null,
          createdAt: now,
        })
        .run();

      // Keep lightweight `conversations` metadata in sync for top-level chat sessions.
      if (!input.parentId) {
        const conv = tx
          .select({
            id: s.conversations.id,
            title: s.conversations.title,
            model: s.conversations.model,
            voiceInvoked: s.conversations.voiceInvoked,
          })
          .from(s.conversations)
          .where(eq(s.conversations.id, input.sessionId))
          .get();

        if (conv) {
          const { voiceDetected, model: voiceModel } = extractVoiceMetadata(input);
          const derivedTitle =
            input.title ?? (title && title !== "Untitled session" ? title : null);

          const patch: Partial<typeof s.conversations.$inferInsert> = {
            lastMessageAt: nowDate,
          };
          if (!conv.title && derivedTitle) {
            patch.title = derivedTitle;
          }
          if (voiceDetected && !conv.voiceInvoked) {
            patch.voiceInvoked = true;
          }
          if (voiceModel && !conv.model) {
            patch.model = voiceModel;
          }

          tx.update(s.conversations)
            .set(patch)
            .where(eq(s.conversations.id, input.sessionId))
            .run();
          touch(tx, input.sessionId, nowDate);
        }
      }

      return { seq, turnStartSeq };
    });

    return Promise.resolve(meta);
  }

  load(sessionIdOrPrefix: string): Promise<LoadedSession | undefined> {
    const key = sessionIdOrPrefix.trim();
    if (!key) return Promise.resolve(undefined);

    let sessionRow = this.db
      .select()
      .from(s.chatSessions)
      .where(eq(s.chatSessions.id, key))
      .get();

    if (!sessionRow) {
      const matches = this.db
        .select()
        .from(s.chatSessions)
        .where(sql`substr(${s.chatSessions.id}, 1, ${key.length}) = ${key}`)
        .orderBy(desc(s.chatSessions.updatedAt), sql`rowid DESC`)
        .limit(2)
        .all();

      if (matches.length > 1) {
        return Promise.reject(
          new Error(
            `Session prefix "${key}" is ambiguous (${matches.map((m) => m.id.slice(0, 8)).join(", ")})`,
          ),
        );
      }
      sessionRow = matches[0];
    }

    if (!sessionRow) return Promise.resolve(undefined);
    return Promise.resolve(this.loadCheckpointForRow(sessionRow));
  }

  loadLatest(): Promise<LoadedSession | undefined> {
    const row = this.db
      .select()
      .from(s.chatSessions)
      .where(isNull(s.chatSessions.parentId))
      .orderBy(desc(s.chatSessions.updatedAt), sql`rowid DESC`)
      .limit(1)
      .get();

    if (!row) return Promise.resolve(undefined);
    return Promise.resolve(this.loadCheckpointForRow(row));
  }

  private loadCheckpointForRow(
    sessionRow: typeof s.chatSessions.$inferSelect,
  ): LoadedSession | undefined {
    const cpRow = this.db
      .select()
      .from(s.chatCheckpoints)
      .where(eq(s.chatCheckpoints.sessionId, sessionRow.id))
      .orderBy(desc(s.chatCheckpoints.seq))
      .limit(1)
      .get();

    if (!cpRow) return undefined;
    return {
      session: toSessionSummary(sessionRow),
      checkpoint: toCheckpointRecord(cpRow),
    };
  }

  list(limit = 20): Promise<SessionSummary[]> {
    const rows = this.db
      .select()
      .from(s.chatSessions)
      .where(isNull(s.chatSessions.parentId))
      .orderBy(desc(s.chatSessions.updatedAt), sql`rowid DESC`)
      .limit(limit)
      .all();

    return Promise.resolve(rows.map(toSessionSummary));
  }

  renameDevice(deviceId: string, newName: string, oldName?: string): Promise<number> {
    const trimmed = newName.trim();
    const prev = oldName?.trim() || null;

    const affected = this.db.transaction((tx): number => {
      const originCond = prev
        ? or(eq(s.chatSessions.originDeviceId, deviceId), eq(s.chatSessions.originDeviceName, prev))
        : eq(s.chatSessions.originDeviceId, deviceId);
      const lastCond = prev
        ? or(eq(s.chatSessions.lastDeviceId, deviceId), eq(s.chatSessions.lastDeviceName, prev))
        : eq(s.chatSessions.lastDeviceId, deviceId);
      const cpCond = prev
        ? or(eq(s.chatCheckpoints.deviceId, deviceId), eq(s.chatCheckpoints.deviceName, prev))
        : eq(s.chatCheckpoints.deviceId, deviceId);

      const countRow = tx
        .select({ n: sql<number>`count(*)` })
        .from(s.chatSessions)
        .where(or(originCond, lastCond))
        .get();

      tx.update(s.chatSessions)
        .set({ originDeviceName: trimmed })
        .where(originCond)
        .run();

      tx.update(s.chatSessions)
        .set({ lastDeviceName: trimmed })
        .where(lastCond)
        .run();

      tx.update(s.chatCheckpoints)
        .set({ deviceName: trimmed })
        .where(cpCond)
        .run();

      return countRow?.n ?? 0;
    });

    return Promise.resolve(affected);
  }

  reconcileOrphaned(): Promise<ReconciledSession[]> {
    const now = new Date().toISOString();

    const reconciled = this.db.transaction((tx): ReconciledSession[] => {
      const running = tx
        .select({ id: s.chatSessions.id, status: s.chatSessions.status })
        .from(s.chatSessions)
        .where(eq(s.chatSessions.status, "running"))
        .all();

      const results: ReconciledSession[] = [];
      for (const row of running) {
        const latest = tx
          .select({ committed: s.chatCheckpoints.committed })
          .from(s.chatCheckpoints)
          .where(eq(s.chatCheckpoints.sessionId, row.id))
          .orderBy(desc(s.chatCheckpoints.seq))
          .limit(1)
          .get();

        const committed = Boolean(latest?.committed);
        const newStatus = committed ? "failed" : "idle";
        const reason = committed
          ? "Session was left running after a crash with committed work that may have executed; marked failed to avoid replaying side effects."
          : "Session was left running after an interruption before any write committed; safely marked idle.";

        tx.update(s.chatSessions)
          .set({ status: newStatus, updatedAt: now })
          .where(eq(s.chatSessions.id, row.id))
          .run();

        results.push({
          sessionId: row.id,
          previousStatus: row.status,
          newStatus,
          committed,
          reason,
        });
      }

      return results;
    });

    return Promise.resolve(reconciled);
  }

  delete(sessionId: string): Promise<void> {
    this.db.delete(s.chatSessions).where(eq(s.chatSessions.id, sessionId)).run();
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// DrizzleApprovalStore
// ---------------------------------------------------------------------------

export function parseApprovalMeta(raw: string | undefined | null): StoredApprovalMeta | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as StoredApprovalMeta;
  } catch {
    return undefined;
  }
}

function readApprovalMeta(conn: DbLike, decisionId: string): StoredApprovalMeta | undefined {
  const row = conn
    .select({ value: s.attributes.value })
    .from(s.attributes)
    .where(
      and(
        eq(s.attributes.subjectId, decisionId),
        eq(s.attributes.groupSlot, "meta"),
        eq(s.attributes.label, APPROVAL_META_LABEL),
      ),
    )
    .get();
  return parseApprovalMeta(row?.value);
}

function writeApprovalMeta(tx: Tx, decisionId: string, meta: StoredApprovalMeta): void {
  const encoded = JSON.stringify(meta);
  const existing = tx
    .select({ id: s.attributes.id })
    .from(s.attributes)
    .where(
      and(
        eq(s.attributes.subjectId, decisionId),
        eq(s.attributes.groupSlot, "meta"),
        eq(s.attributes.label, APPROVAL_META_LABEL),
      ),
    )
    .get();

  if (existing) {
    tx.update(s.attributes)
      .set({ value: encoded })
      .where(eq(s.attributes.id, existing.id))
      .run();
    return;
  }

  const maxOrd = tx
    .select({ ordinal: s.attributes.ordinal })
    .from(s.attributes)
    .where(and(eq(s.attributes.subjectId, decisionId), eq(s.attributes.groupSlot, "meta")))
    .orderBy(desc(s.attributes.ordinal))
    .limit(1)
    .get();

  tx.insert(s.attributes)
    .values({
      id: ulid(),
      subjectId: decisionId,
      groupSlot: "meta",
      ordinal: (maxOrd?.ordinal ?? 0) + 1,
      label: APPROVAL_META_LABEL,
      value: encoded,
    })
    .run();
}

function resolveStatusAndOutcome(
  decision: typeof s.decisions.$inferSelect,
  meta: StoredApprovalMeta | undefined,
  choices: readonly ApprovalChoice[],
): { status: ApprovalStatus; outcome: ApprovalOutcome | null } {
  if (decision.state === "open") {
    return { status: "open", outcome: null };
  }
  if (decision.state === "expired") {
    return { status: "expired", outcome: "expired" };
  }
  if (decision.state === "superseded") {
    return { status: "superseded", outcome: null };
  }
  if (decision.state === "dismissed") {
    return { status: "declined", outcome: "declined" };
  }
  // decision.state === "resolved"
  if (meta?.outcome) {
    return { status: meta.outcome, outcome: meta.outcome };
  }
  const chosen = decision.chosenActionId
    ? choices.find((c) => c.id === decision.chosenActionId)
    : undefined;
  const inferred: ApprovalOutcome = chosen?.approves ? "approved" : "declined";
  return { status: inferred, outcome: inferred };
}

function loadApprovalRecord(conn: DbLike, approvalId: string): ApprovalRecord | undefined {
  const decision = conn
    .select()
    .from(s.decisions)
    .where(eq(s.decisions.id, approvalId))
    .get();
  if (!decision) return undefined;

  const actionRows = conn
    .select()
    .from(s.actions)
    .where(eq(s.actions.decisionId, approvalId))
    .orderBy(asc(s.actions.ordinal))
    .all();

  const attrs = conn
    .select({
      groupSlot: s.attributes.groupSlot,
      label: s.attributes.label,
      value: s.attributes.value,
      ordinal: s.attributes.ordinal,
    })
    .from(s.attributes)
    .where(eq(s.attributes.subjectId, approvalId))
    .orderBy(asc(s.attributes.ordinal))
    .all();

  const proseRows = conn
    .select({
      slot: s.narratives.slot,
      text: s.narratives.text,
      ordinal: s.narratives.ordinal,
    })
    .from(s.narratives)
    .where(eq(s.narratives.subjectId, approvalId))
    .orderBy(asc(s.narratives.ordinal))
    .all();

  const ref = attrs.find((a) => a.groupSlot === "meta" && a.label === "ref")?.value ?? "";
  const meta = parseApprovalMeta(
    attrs.find((a) => a.groupSlot === "meta" && a.label === APPROVAL_META_LABEL)?.value,
  );
  const facts: ApprovalFact[] = attrs
    .filter((a) => a.groupSlot === "effect")
    .map((a) => [a.label, a.value] as const);

  const choices: ApprovalChoice[] = actionRows.map((row) => {
    const effect = row.effect as { approves?: unknown };
    return {
      id: row.id,
      label: row.label,
      stance: row.stance,
      approves: effect.approves === true || row.effectKind === "tool_call",
    };
  });

  const firstToolAction = actionRows.find(
    (a) => typeof (a.effect as { tool?: unknown }).tool === "string",
  );
  const firstEffect = (firstToolAction?.effect ?? {}) as {
    tool?: unknown;
    args?: unknown;
    argsDigest?: unknown;
    capability?: unknown;
  };

  const holdLines = proseRows.filter((p) => p.slot === "restraint").map((p) => p.text);
  const outcomeLines = proseRows.filter((p) => p.slot === "outcome").map((p) => p.text);

  const { status, outcome } = resolveStatusAndOutcome(decision, meta, choices);
  const mode = meta?.mode ?? (decision.blocking ? "blocking" : "deferred");
  const expiresAt = meta?.expiresAt ?? decision.dueAt?.toISOString();
  const settledAt = meta?.settledAt ?? decision.resolvedAt?.toISOString();

  return {
    id: decision.id,
    ref,
    mode,
    status,
    tool: meta?.tool ?? (typeof firstEffect.tool === "string" ? firstEffect.tool : ""),
    capability:
      meta?.capability ?? (typeof firstEffect.capability === "string" ? firstEffect.capability : ""),
    args: meta !== undefined ? meta.args : firstEffect.args,
    argsDigest:
      meta?.argsDigest ?? (typeof firstEffect.argsDigest === "string" ? firstEffect.argsDigest : ""),
    title: decision.title,
    why: decision.body ?? null,
    hold: holdLines.length ? holdLines.join(" ") : null,
    facts,
    choices,
    chosenId: decision.chosenActionId ?? null,
    outcome,
    settledNote: outcomeLines.length ? outcomeLines.join(" ") : null,
    ...(meta?.execution !== undefined ? { execution: meta.execution } : {}),
    ...(meta?.scope !== undefined ? { scope: meta.scope } : {}),
    createdAt: decision.openedAt.toISOString(),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(settledAt !== undefined ? { settledAt } : {}),
  };
}

function resolveEntityId(tx: Tx, candidate: unknown): string | null {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const exists = tx
    .select({ id: s.entities.id })
    .from(s.entities)
    .where(eq(s.entities.id, candidate))
    .get();
  return exists ? candidate : null;
}

function resolveWorkflowId(tx: Tx, candidate: unknown): string | null {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const exists = tx
    .select({ id: s.workflows.id })
    .from(s.workflows)
    .where(eq(s.workflows.id, candidate))
    .get();
  return exists ? candidate : null;
}

function resolveRunId(tx: Tx, candidate: unknown): string | null {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const exists = tx
    .select({ id: s.workflowRuns.id })
    .from(s.workflowRuns)
    .where(eq(s.workflowRuns.id, candidate))
    .get();
  return exists ? candidate : null;
}

/**
 * Drizzle-backed implementation of `solenoid-security`'s `ApprovalStore`, persisting
 * blocking and deferred approvals into `decisions`, `actions`, and `activity_items`
 * so Chat, Activity feed, and nav rail waiting counts stay strictly in sync.
 */
export class DrizzleApprovalStore implements ApprovalStore {
  constructor(readonly db: Db) {}

  create(input: CreateApprovalInput): ApprovalRecord {
    const now = new Date();
    return this.db.transaction((tx): ApprovalRecord => {
      const decisionId = ulid(now.getTime());
      const subjectId =
        resolveEntityId(tx, input.scope?.conversationId) ??
        resolveEntityId(tx, input.scope?.runId) ??
        resolveEntityId(tx, input.scope?.subjectId);
      const ref = nextApprovalRef(tx, now);

      tx.insert(s.entities)
        .values({ id: decisionId, kind: "decision", createdAt: now, updatedAt: now })
        .run();

      tx.insert(s.decisions)
        .values({
          id: decisionId,
          subjectId,
          title: input.title,
          ...(input.why ? { body: input.why } : {}),
          state: "open",
          blocking: input.mode === "blocking",
          openedAt: now,
          ...(input.expiresAt ? { dueAt: new Date(input.expiresAt) } : {}),
        })
        .run();

      writePairs(tx, decisionId, "effect", input.facts);
      if (input.hold?.trim()) {
        narrate(tx, decisionId, "restraint", input.hold.trim(), now);
      }

      const meta: StoredApprovalMeta = {
        mode: input.mode,
        tool: input.tool,
        capability: input.capability,
        args: input.args,
        argsDigest: input.argsDigest,
        ...(input.scope !== undefined ? { scope: { ...input.scope } } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        outcome: null,
      };

      tx.insert(s.attributes)
        .values([
          {
            id: ulid(now.getTime()),
            subjectId: decisionId,
            groupSlot: "meta",
            ordinal: 0,
            label: "ref",
            value: ref,
          },
          {
            id: ulid(now.getTime()),
            subjectId: decisionId,
            groupSlot: "meta",
            ordinal: 1,
            label: APPROVAL_META_LABEL,
            value: JSON.stringify(meta),
          },
        ])
        .run();

      let actionSubjectId = decisionId;

      if (input.mode === "deferred") {
        const activityId = ulid(now.getTime());
        const workflowId = resolveWorkflowId(tx, input.scope?.workflowId);
        const runId = resolveRunId(tx, input.scope?.runId);

        tx.insert(s.entities)
          .values({ id: activityId, kind: "activity_item", createdAt: now, updatedAt: now })
          .run();

        tx.insert(s.activityItems)
          .values({
            id: activityId,
            occurredAt: now,
            state: "attention",
            title: input.title,
            badge: input.capability,
            prominence: "prominent",
            framed: true,
            sourceId: subjectId,
            ...(workflowId ? { workflowId } : {}),
            ...(runId ? { runId } : {}),
            decisionId,
          })
          .run();

        const accountText = input.why?.trim() || input.hold?.trim() || input.title;
        if (accountText) {
          narrate(tx, activityId, "account", accountText, now);
        }

        // Actions hang off the activity_item so loadHome() renders live buttons on the card.
        actionSubjectId = activityId;
      }

      const choices: ApprovalChoice[] = input.choices.map((choice, ordinal) => {
        const choiceId = choice.id || ulid(now.getTime());
        const isDeferredApprove = input.mode === "deferred" && choice.approves;

        tx.insert(s.actions)
          .values({
            id: choiceId,
            subjectId: actionSubjectId,
            decisionId,
            ordinal,
            label: choice.label,
            stance: choice.stance,
            effectKind: isDeferredApprove ? "tool_call" : "resolve",
            effect: isDeferredApprove
              ? {
                  tool: input.tool,
                  args: input.args,
                  approves: true,
                  argsDigest: input.argsDigest,
                  capability: input.capability,
                }
              : {
                  approves: choice.approves,
                  tool: input.tool,
                  argsDigest: input.argsDigest,
                  capability: input.capability,
                },
            destructive: choice.stance === "danger",
            createdAt: now,
          })
          .run();

        return {
          id: choiceId,
          label: choice.label,
          stance: choice.stance,
          approves: choice.approves,
        };
      });

      return {
        id: decisionId,
        ref,
        mode: input.mode,
        status: "open",
        tool: input.tool,
        capability: input.capability,
        args: input.args,
        argsDigest: input.argsDigest,
        title: input.title,
        why: input.why,
        hold: input.hold,
        facts: [...input.facts],
        choices,
        chosenId: null,
        outcome: null,
        settledNote: null,
        ...(input.scope !== undefined ? { scope: { ...input.scope } } : {}),
        createdAt: now.toISOString(),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      };
    });
  }

  get(approvalId: string): ApprovalRecord | undefined {
    return loadApprovalRecord(this.db, approvalId);
  }

  findByChoiceId(choiceId: string): { record: ApprovalRecord; choice: ApprovalChoice } | undefined {
    const actionRow = this.db
      .select({ decisionId: s.actions.decisionId })
      .from(s.actions)
      .where(eq(s.actions.id, choiceId))
      .get();

    if (!actionRow?.decisionId) return undefined;
    const record = loadApprovalRecord(this.db, actionRow.decisionId);
    if (!record) return undefined;

    const choice = record.choices.find((c) => c.id === choiceId);
    if (!choice) return undefined;
    return { record, choice };
  }

  settle(input: SettleApprovalInput): ApprovalRecord {
    const settleAt = input.now ?? new Date();

    return this.db.transaction((tx): ApprovalRecord => {
      const decision = tx
        .select()
        .from(s.decisions)
        .where(eq(s.decisions.id, input.approvalId))
        .get();

      if (!decision) {
        throw new ApprovalNotFoundError(input.approvalId);
      }

      if (decision.state !== "open") {
        const existingRecord = loadApprovalRecord(tx, input.approvalId);
        throw new AlreadySettledError(
          decision.id,
          existingRecord?.status ?? (decision.state === "expired" ? "expired" : "declined"),
        );
      }

      const nextState = input.outcome === "expired" ? "expired" : "resolved";
      const resolvedBy = input.outcome === "expired" ? "timeout" : "user";

      tx.update(s.decisions)
        .set({
          state: nextState,
          resolvedAt: settleAt,
          resolvedBy,
          chosenActionId: input.chosenId ?? null,
        })
        .where(and(eq(s.decisions.id, input.approvalId), eq(s.decisions.state, "open")))
        .run();

      if (input.chosenId) {
        tx.update(s.actions)
          .set({
            invokedAt: settleAt,
            invokedBy: "user",
            invokeState: "ok",
          })
          .where(eq(s.actions.id, input.chosenId))
          .run();
      }

      if (input.settledNote?.trim()) {
        clearSlot(tx, input.approvalId, "outcome");
        narrate(tx, input.approvalId, "outcome", input.settledNote.trim(), settleAt, 0);
      }

      const existingMeta = readApprovalMeta(tx, input.approvalId);
      if (existingMeta) {
        writeApprovalMeta(tx, input.approvalId, {
          ...existingMeta,
          outcome: input.outcome,
          settledAt: settleAt.toISOString(),
        });
      }

      tx.update(s.activityItems)
        .set({
          state: input.outcome === "approved" ? "done" : "idle",
          prominence: "quiet",
          framed: false,
        })
        .where(eq(s.activityItems.decisionId, input.approvalId))
        .run();

      touch(tx, input.approvalId, settleAt);

      const updated = loadApprovalRecord(tx, input.approvalId);
      if (!updated) throw new ApprovalNotFoundError(input.approvalId);
      return updated;
    });
  }

  recordExecution(
    approvalId: string,
    execution: ApprovalExecutionOutcome,
    note?: string,
  ): ApprovalRecord {
    const now = new Date();

    return this.db.transaction((tx): ApprovalRecord => {
      const decision = tx
        .select()
        .from(s.decisions)
        .where(eq(s.decisions.id, approvalId))
        .get();

      if (!decision) {
        throw new ApprovalNotFoundError(approvalId);
      }

      const trimmedNote = note?.trim();
      if (trimmedNote) {
        const lastOutcome = tx
          .select({ ordinal: s.narratives.ordinal })
          .from(s.narratives)
          .where(and(eq(s.narratives.subjectId, approvalId), eq(s.narratives.slot, "outcome")))
          .orderBy(desc(s.narratives.ordinal))
          .limit(1)
          .get();

        narrate(tx, approvalId, "outcome", trimmedNote, now, (lastOutcome?.ordinal ?? -1) + 1);
      }

      const existingMeta = readApprovalMeta(tx, approvalId);
      if (existingMeta) {
        writeApprovalMeta(tx, approvalId, {
          ...existingMeta,
          execution: { ...execution },
        });
      }

      if (decision.chosenActionId) {
        tx.update(s.actions)
          .set({
            invokeState: execution.status === "failed" ? "failed" : "ok",
            invokeResult: execution as unknown as Record<string, unknown>,
            invokeError: execution.error ?? null,
          })
          .where(eq(s.actions.id, decision.chosenActionId))
          .run();
      }

      tx.update(s.activityItems)
        .set({
          state: execution.status === "failed" ? "failed" : "done",
          prominence: "quiet",
          framed: false,
        })
        .where(eq(s.activityItems.decisionId, approvalId))
        .run();

      touch(tx, approvalId, now);

      const updated = loadApprovalRecord(tx, approvalId);
      if (!updated) throw new ApprovalNotFoundError(approvalId);
      return updated;
    });
  }
}
