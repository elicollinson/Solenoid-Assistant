// Acceptance smoke test against the live chat.db (spec §12). Prints aggregate
// shape only — no message bodies. Run from a terminal that has Full Disk
// Access: `bun run scripts/imessage-smoke.ts`
import { fetchMessages, unixSecondsToAppleNs } from "../src/imessage/reader";

const since = unixSecondsToAppleNs(Date.now() / 1000 - 48 * 3600);
const { messages, newCursor } = fetchMessages(since, { overlapSeconds: 0 });

const fromMe = messages.filter((m) => m.isFromMe).length;
const senders = new Set(messages.map((m) => m.sender));
const badSenders = [...senders].filter((s) => s !== "me" && !s.startsWith("+") && !s.includes("@"));
const groupChats = new Set(
  messages.filter((m) => m.conversationId.startsWith("chat")).map((m) => m.conversationId),
);
const ts = messages.map((m) => m.timestamp.getTime());

console.log({
  last48hCount: messages.length, // expect > 0 on an active account
  fromMe, // expect a mix of true/false
  fromOthers: messages.length - fromMe,
  distinctSenders: senders.size,
  nonE164NonEmailSenders: badSenders.length, // expect 0
  groupChatConversations: groupChats.size, // expect ≥ 1 if any group chatter
  emptyConversationIds: messages.filter((m) => !m.conversationId).length, // expect 0
  emptyBodies: messages.filter((m) => !m.body.trim()).length, // expect 0
  oldest: ts.length ? new Date(Math.min(...ts)).toISOString() : null, // expect recent, not 1970/2001
  newest: ts.length ? new Date(Math.max(...ts)).toISOString() : null,
  longestBodyChars: Math.max(0, ...messages.map((m) => m.body.length)), // >200 exercises the 0x81 path
  newCursorAdvanced: newCursor > since,
});
