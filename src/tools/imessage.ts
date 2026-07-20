import { z } from "zod";
import { defineTool } from "../core/tools";
import { fetchMessages, unixSecondsToAppleNs } from "../imessage/reader";

export const readImessagesTool = defineTool({
  name: "read_imessages",
  description:
    "Read recent iMessage/SMS messages from the local macOS Messages database (read-only). " +
    "Returns messages in chronological order with sender, conversation ID, and UTC timestamp. " +
    "Sender is an E.164 phone number or email, or 'me' for outgoing messages.",
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
    const since = unixSecondsToAppleNs(Date.now() / 1000 - hoursBack * 3600);
    // The window start already is the cursor here (not a persisted high-water
    // mark), so the 60s late-arrival overlap would just blur the requested range.
    const { messages } = fetchMessages(since, { overlapSeconds: 0 });
    const recent = messages.slice(-limit);
    return {
      returned: recent.length,
      totalInWindow: messages.length,
      messages: recent.map((m) => ({
        sender: m.sender,
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
