// One conversation stack for texts, email threads and chats with the agent.
//
// The design renders kind:"thread" (a text from Fenwick Heating) and
// kind:"chat" (direct chat with the agent) with an identical message shape,
// and an email is a thread with headers. Three parallel stacks would triple
// the search, evidence and pinning code for no gain. A workflow run's
// transcript is also a conversation, channel = 'agent_chat'.
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { SAFETY_STATE, TRUST_STATE, inList, json, ts, tsReq } from "./_shared";
import { entityId } from "./entities";
import { participants } from "./people";

export const CHANNEL = ["imessage", "sms", "email", "agent_chat", "call", "other"] as const;
export type Channel = (typeof CHANNEL)[number];

export const conversations = sqliteTable("conversations", {
  id: entityId(),
  channel: text({ enum: CHANNEL }).notNull(),
  /** chat_identifier for iMessage, threadId for Gmail. */
  externalId: text(),
  title: text(),
  subject: text(),
  /** "Fenwick Heating · +44 7700 900412" */
  counterpartyLabel: text(),
  isGroup: integer({ mode: "boolean" }).notNull().default(false),
  startedAt: ts(),
  lastMessageAt: ts(),
  messageCount: integer().notNull().default(0),
  unreadCount: integer().notNull().default(0),
  trustState: text({ enum: TRUST_STATE }).notNull().default("unknown"),
  safetyState: text({ enum: SAFETY_STATE }).notNull().default("unscreened"),
  archivedAt: ts(),
}, (t) => [
  check("conversations_channel_check", inList(t.channel, CHANNEL)),
  check("conversations_trust_check", inList(t.trustState, TRUST_STATE)),
  check("conversations_safety_check", inList(t.safetyState, SAFETY_STATE)),
  uniqueIndex("conversations_external").on(t.channel, t.externalId),
  index("conversations_recent").on(t.lastMessageAt),
]);

export const PARTICIPANT_ROLE = ["me", "them", "agent", "cc", "bcc", "organizer"] as const;

export const conversationParticipants = sqliteTable("conversation_participants", {
  conversationId: text().notNull().references(() => conversations.id, { onDelete: "cascade" }),
  participantId: text().notNull().references(() => participants.id, { onDelete: "cascade" }),
  role: text({ enum: PARTICIPANT_ROLE }).notNull().default("them"),
}, (t) => [
  check("conversation_participants_role_check", inList(t.role, PARTICIPANT_ROLE)),
  primaryKey({ columns: [t.conversationId, t.participantId, t.role] }),
]);

export const DIRECTION = ["inbound", "outbound", "system"] as const;
export const BODY_FORMAT = ["text", "html", "markdown"] as const;

export const messages = sqliteTable("messages", {
  id: entityId(),
  conversationId: text().notNull().references(() => conversations.id, { onDelete: "cascade" }),
  /** message.guid from chat.db — the dedup key across overlapping reads. */
  externalId: text(),
  seq: integer().notNull(),
  senderId: text().references(() => participants.id, { onDelete: "set null" }),
  direction: text({ enum: DIRECTION }).notNull(),
  sentAt: tsReq(),
  body: text().notNull().default(""),
  bodyFormat: text({ enum: BODY_FORMAT }).notNull().default("text"),
  service: text(),
  hasAttachments: integer({ mode: "boolean" }).notNull().default(false),
  replyToId: text().references((): AnySQLiteColumn => messages.id, { onDelete: "set null" }),
  /** A draft the agent wrote and is holding for you. */
  isDraft: integer({ mode: "boolean" }).notNull().default(false),
  draftedByRunId: text(),
  sentBy: text({ enum: ["user", "agent"] as const }),
  safetyState: text({ enum: SAFETY_STATE }).notNull().default("unscreened"),
  redactedAt: ts(),
}, (t) => [
  check("messages_direction_check", inList(t.direction, DIRECTION)),
  check("messages_body_format_check", inList(t.bodyFormat, BODY_FORMAT)),
  check("messages_safety_check", inList(t.safetyState, SAFETY_STATE)),
  uniqueIndex("messages_external").on(t.conversationId, t.externalId),
  index("messages_conversation_seq").on(t.conversationId, t.seq),
  index("messages_sent_at").on(t.sentAt),
  index("messages_draft").on(t.conversationId).where(sql`${t.isDraft} = 1`),
]);

/** 1:1 extension. Only rows whose conversation.channel = 'email'. */
export const emailMessages = sqliteTable("email_messages", {
  messageId: text().primaryKey().references(() => messages.id, { onDelete: "cascade" }),
  rfcMessageId: text(),
  inReplyTo: text(),
  referencesHdr: text(),
  fromAddr: text().notNull(),
  toAddrs: json<string[]>().notNull().default(sql`'[]'`),
  ccAddrs: json<string[]>().notNull().default(sql`'[]'`),
  bccAddrs: json<string[]>().notNull().default(sql`'[]'`),
  subject: text(),
  snippet: text(),
  /** The "> ..." block, kept apart so a pin never lands in quoted text. */
  quotedText: text(),
  provider: text(),
  providerId: text(),
  labels: json<string[]>().notNull().default(sql`'[]'`),
});

export const attachments = sqliteTable("attachments", {
  id: entityId(),
  messageId: text().notNull().references(() => messages.id, { onDelete: "cascade" }),
  filename: text().notNull(),
  mimeType: text(),
  sizeBytes: integer(),
  /** On disk, outside the database. */
  path: text(),
  sha256: text(),
  /** Set when the attachment is an image we analysed as a screenshot. */
  screenshotId: text(),
  extractedText: text(),
}, (t) => [index("attachments_message").on(t.messageId)]);
