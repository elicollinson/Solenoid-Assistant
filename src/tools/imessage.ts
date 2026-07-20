import { z } from "zod";
import { defineTool } from "../core/tools";
import { fetchTrustedMessages } from "../imessage/trusted";

export const readImessagesTool = defineTool({
  name: "read_imessages",
  description:
    "Read recent iMessage/SMS messages from the local macOS Messages database (read-only). " +
    "Only messages from known contacts (plus your own) are returned — unknown senders are " +
    "filtered out before this tool responds. Returns messages in chronological order with " +
    "sender, resolved contact name, conversation ID, and UTC timestamp. Sender is an E.164 " +
    "phone number or email, or 'me' for outgoing messages.",
  schema: z.object({
    hoursBack: z
      .number()
      .positive()
      .max(24 * 30)
      .default(24)
      .describe("How far back to read, in hours (default 24, max 720)"),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .default(50)
      .describe("Maximum messages to return; keeps the most recent when the window has more (default 50)"),
  }),
  execute: ({ hoursBack, limit }) => {
    // Trusted-only by design (spec contactsRead §3): there is deliberately no
    // parameter to include unknown senders — an injected prompt must not be
    // able to ask its way past the trust boundary.
    const { messages, totalInWindow, droppedUntrusted } = fetchTrustedMessages({
      start: new Date(Date.now() - hoursBack * 3600_000),
    });
    const recent = messages.slice(-limit);
    return {
      returned: recent.length,
      totalTrustedInWindow: messages.length,
      totalInWindow,
      droppedUntrusted,
      messages: recent.map((m) => ({
        sender: m.sender,
        senderName: m.senderName,
        body: m.body,
        conversationId: m.conversationId,
        isFromMe: m.isFromMe,
        service: m.service,
        timestamp: m.timestamp.toISOString(),
        hasAttachments: m.hasAttachments,
      })),
    };
  },
});
