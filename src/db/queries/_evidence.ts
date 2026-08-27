// What the agent read before it acted, for any subject that cites anything.
//
// Shared for the same reason ./_format.ts is: two surfaces must agree. A
// reminder and a recommendation cite the same artifacts out of the same
// tables, and a second copy of "which shape is this source" is a second place
// for it to be wrong.
//
// The types are named for reminders because that is the surface that needed
// them first. Evidence has one shape across the product.
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../index";
import * as s from "../schema";
import type { ReminderEvidence, ReminderEvidenceKind, ReminderEvidenceTurn } from "../../shared/reminders";
import { clock, stampLong, stampYear } from "./_format";

/**
 * What the agent read before it acted.
 *
 * The link says which source and why; the source says what it is. Three
 * shapes come back — a conversation, a capture, a fetched page — and the
 * viewer draws each one the way that kind is actually read.
 */
export function evidenceFor(db: Db, subjectId: string, now: Date): ReminderEvidence[] {
  const links = db
    .select()
    .from(s.evidenceLinks)
    .where(eq(s.evidenceLinks.subjectId, subjectId))
    .orderBy(asc(s.evidenceLinks.ordinal))
    .all();
  if (links.length === 0) return [];

  const out: ReminderEvidence[] = [];
  for (const link of links) {
    const item =
      conversationEvidence(db, link.sourceId, link.pinQuote, now) ??
      screenshotEvidence(db, link.sourceId, now) ??
      articleEvidence(db, link.sourceId, link.pinQuote, now);
    // The citation names the source; the source's own name is the fallback.
    if (item) out.push({ ...item, id: link.id, title: link.title ?? item.title, why: link.why ?? undefined });
  }
  return out;
}

type Unlinked = Omit<ReminderEvidence, "id" | "why">;

/** "3 messages · 1 pinned", "2 regions", "540 words". */
const support = (parts: readonly (string | null)[]) => parts.filter(Boolean).join(" · ") || undefined;

function conversationEvidence(db: Db, id: string, pin: string | null, now: Date): Unlinked | null {
  const [conversation] = db.select().from(s.conversations).where(eq(s.conversations.id, id)).limit(1).all();
  if (!conversation) return null;

  const messages = db.select().from(s.messages).where(eq(s.messages.conversationId, id)).orderBy(asc(s.messages.seq)).all();
  const kind: ReminderEvidenceKind =
    conversation.channel === "agent_chat" ? "chat" : conversation.channel === "email" ? "email" : "thread";

  // Who I was talking to, and which side of it you were on.
  const them = db
    .select({ participant: s.participants })
    .from(s.conversationParticipants)
    .innerJoin(s.participants, eq(s.participants.id, s.conversationParticipants.participantId))
    .where(and(eq(s.conversationParticipants.conversationId, id), eq(s.conversationParticipants.role, "them")))
    .all()
    .map((r) => r.participant)[0];

  const handle = them
    ? db.select().from(s.participantHandles).where(and(eq(s.participantHandles.participantId, them.id), eq(s.participantHandles.kind, "phone"))).limit(1).all()[0]
    : undefined;

  const outbound = messages.length > 0 && messages.every((m) => m.direction === "outbound");
  const who =
    kind === "chat"
      ? "direct chat with me"
      : !them
        ? (conversation.counterpartyLabel ?? "a conversation")
        : outbound
          ? `you to ${them.displayName}`
          : handle
            ? `${them.displayName} · ${handle.value}`
            : them.displayName;

  const ref = conversation.externalId ? `${kind === "chat" ? "chat" : "thread"}/${conversation.externalId}` : undefined;

  if (kind === "email") {
    const [mail] = messages;
    if (!mail) return null;
    const [headers] = db.select().from(s.emailMessages).where(eq(s.emailMessages.messageId, mail.id)).limit(1).all();
    const body = mail.body.split("\n\n");
    const files = db.select().from(s.attachments).where(eq(s.attachments.messageId, mail.id)).all();
    const pinned = pin ? body.indexOf(pin) : -1;
    return {
      kind,
      title: conversation.title ?? headers?.subject ?? "An email",
      who: mail.isDraft ? `drafted by me for ${them?.displayName ?? "them"}` : who,
      when: stampLong(mail.sentAt, now),
      support: support([mail.isDraft ? "held as a draft" : null, files.length ? `${files.length} attached` : null]),
      ref,
      email: {
        from: headers?.fromAddr ?? "",
        to: (headers?.toAddrs ?? []).join(", "),
        date: stampYear(mail.sentAt),
        subject: headers?.subject ?? "",
        body,
        ...(headers?.quotedText ? { quoted: headers.quotedText.split("\n") } : {}),
        ...(files.length ? { attachments: files.map((f) => `${f.filename} · ${kb(f.sizeBytes)}`) } : {}),
        ...(pinned >= 0 ? { pinned } : {}),
      },
    };
  }

  const turns: ReminderEvidenceTurn[] = messages.map((m) => ({
    from: m.sentBy === "user" ? "you" : m.sentBy === "agent" ? "agent" : "them",
    name: m.sentBy === "user" ? "You" : m.sentBy === "agent" ? "Solenoid" : (them?.displayName ?? "Them"),
    t: clock(m.sentAt),
    text: m.body,
    pinned: pin != null && m.body === pin,
  }));

  return {
    kind,
    title: conversation.title ?? "A conversation",
    who,
    when: stampLong(conversation.lastMessageAt ?? conversation.startedAt ?? now, now),
    support: support([`${turns.length} message${turns.length === 1 ? "" : "s"}`, turns.some((t) => t.pinned) ? "1 pinned" : null]),
    ref,
    messages: turns,
  };
}

function screenshotEvidence(db: Db, id: string, now: Date): Unlinked | null {
  const [shot] = db.select().from(s.screenshots).where(eq(s.screenshots.id, id)).limit(1).all();
  if (!shot) return null;

  // The analysis the agent actually saw, not whatever OCR says today.
  const [analysis] = db
    .select()
    .from(s.screenshotAnalyses)
    .where(and(eq(s.screenshotAnalyses.screenshotId, id), eq(s.screenshotAnalyses.isCurrent, true)))
    .limit(1)
    .all();
  const regions = analysis
    ? db.select().from(s.screenshotRegions).where(eq(s.screenshotRegions.analysisId, analysis.id)).orderBy(asc(s.screenshotRegions.ordinal)).all()
    : [];

  const [run] = shot.capturedInRunId
    ? db.select({ ordinal: s.workflowRuns.ordinal }).from(s.workflowRuns).where(eq(s.workflowRuns.id, shot.capturedInRunId)).limit(1).all()
    : [];

  return {
    kind: "screenshot",
    title: analysis?.summary ?? shot.originalFilename,
    who: shot.captureContext ?? (shot.capturedBy === "agent" ? "captured by me" : "captured by you"),
    when: stampLong(shot.capturedAt, now),
    support: support([`${regions.length} region${regions.length === 1 ? "" : "s"}`, analysis?.ocrText ? "text read" : null]),
    ref: run ? `run ${run.ordinal}` : `shot/${shot.originalFilename.replace(/\.[^.]+$/, "")}`,
    shot: {
      file: shot.originalFilename,
      dims: `${shot.width ?? "?"} × ${shot.height ?? "?"}`,
      regions: regions.map((r) => ({ label: r.label, note: r.note })),
      ...(analysis?.ocrText ? { text: analysis.ocrText } : {}),
    },
  };
}

function articleEvidence(db: Db, id: string, pin: string | null, now: Date): Unlinked | null {
  const [doc] = db.select().from(s.webDocuments).where(eq(s.webDocuments.id, id)).limit(1).all();
  if (!doc) return null;
  const body = doc.bodyText.split("\n\n");
  const pinned = pin ? body.indexOf(pin) : -1;
  return {
    kind: "article",
    title: doc.headline ?? doc.url,
    who: doc.siteLabel ?? doc.url,
    when: stampLong(doc.retrievedAt, now),
    support: support([doc.wordCount ? `${doc.wordCount} words` : null]),
    ref: "web",
    article: {
      url: doc.url,
      retrieved: stampLong(doc.retrievedAt, now),
      words: doc.wordCount ?? body.join(" ").split(/\s+/).length,
      headline: doc.headline ?? doc.url,
      ...(doc.byline ? { byline: doc.byline } : {}),
      body,
      ...(pinned >= 0 ? { pinned } : {}),
    },
  };
}

/** "84 KB" — attachment sizes are read, not audited. */
function kb(bytes: number | null): string {
  if (bytes == null) return "size unknown";
  return `${Math.round(bytes / 1024)} KB`;
}
