// Durable session and Phase 2 mid-turn checkpoint tables for solenoid-engine.
//
// Stored inside the app's own SQLite database as STRICT tables so chat session
// recovery, voice/text unification, and relational approvals share a single
// ACID database with foreign-key cascading on session delete.
import type { Message } from "@ag-ui/core";
import type { ChatMessage, PendingCheckpointState } from "@elicollinson/solenoid-engine";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { inList, json } from "./_shared";

export const CHAT_SESSION_STATUS = [
  "idle",
  "running",
  "waiting_approval",
  "failed",
  "closed",
] as const;

export const CHAT_CHECKPOINT_KIND = [
  "turn_start",
  "step_assistant",
  "step_tools",
  "interrupt",
  "turn_end",
] as const;

export const chatSessions = sqliteTable("chat_sessions", {
  id: text().primaryKey(),
  parentId: text(),
  title: text().notNull(),
  status: text({ enum: CHAT_SESSION_STATUS }).notNull(),
  originDeviceId: text().notNull(),
  originDeviceName: text().notNull(),
  lastDeviceId: text().notNull(),
  lastDeviceName: text().notNull(),
  lastSeq: integer().notNull().default(0),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
}, (t) => [
  check("chat_sessions_status_check", inList(t.status, CHAT_SESSION_STATUS)),
  index("chat_sessions_parent_updated").on(t.parentId, t.updatedAt),
  index("chat_sessions_origin_device").on(t.originDeviceId),
  index("chat_sessions_last_device").on(t.lastDeviceId),
  index("chat_sessions_status").on(t.status),
]);

export const chatCheckpoints = sqliteTable("chat_checkpoints", {
  sessionId: text().notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
  seq: integer().notNull(),
  kind: text({ enum: CHAT_CHECKPOINT_KIND }).notNull(),
  deviceId: text().notNull(),
  deviceName: text().notNull(),
  committed: integer({ mode: "boolean" }).notNull().default(false),
  turnStartSeq: integer().notNull(),
  transcript: json<ChatMessage[]>().notNull(),
  thread: json<Message[]>().notNull(),
  pending: json<PendingCheckpointState | Record<string, unknown>>(),
  createdAt: text().notNull(),
}, (t) => [
  primaryKey({ columns: [t.sessionId, t.seq] }),
  check("chat_checkpoints_kind_check", inList(t.kind, CHAT_CHECKPOINT_KIND)),
  index("chat_checkpoints_device").on(t.deviceId),
]);
