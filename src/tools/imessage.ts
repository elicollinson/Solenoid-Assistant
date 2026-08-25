import { z } from "zod";
import { defineTool, type AgentTool } from "../core/tools";
import { fetchTrustedMessages } from "../imessage/trusted";

const BASE_DESCRIPTION =
  "Read recent iMessage/SMS messages from the local macOS Messages database (read-only). " +
  "Only messages from known contacts (plus your own) are returned — unknown senders are " +
  "filtered out before this tool responds. Returns messages in chronological order with " +
  "sender, resolved contact name, conversation ID, and UTC timestamp. Sender is an E.164 " +
  "phone number or email, or 'me' for outgoing messages.";

const limitSchema = z
  .number()
  .int()
  .positive()
  .max(500)
  .default(200)
  .describe("Maximum messages to return; keeps the most recent when the window has more (default 200)");

// Shared fetch body: both tool variants funnel through here, differing only in
// how the window was decided (model-chosen vs. caller-enforced).
export interface ReadTrustedMessageWindowParams extends ReadWindow {
  limit?: number;
}

export interface TrustedMessageView {
  sender: string;
  senderName: string | null;
  body: string;
  conversationId: string;
  isFromMe: boolean;
  service: string;
  timestamp: string;
  hasAttachments: boolean;
}

export interface TrustedMessageWindowResult {
  returned: number;
  totalTrustedInWindow: number;
  totalInWindow: number;
  droppedUntrusted: number;
  messages: TrustedMessageView[];
}

export function readTrustedMessageWindow(
  params: ReadTrustedMessageWindowParams = {},
): TrustedMessageWindowResult {
  const end = params.end ?? new Date();
  const start = params.start ?? new Date(end.getTime() - 24 * 3600_000);
  const limit = params.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("iMessage read limit must be an integer between 1 and 500");
  }
  // Trusted-only by design (spec contactsRead §3): there is deliberately no
  // parameter to include unknown senders — an injected prompt must not be
  // able to ask its way past the trust boundary.
  const { messages, totalInWindow, droppedUntrusted } = fetchTrustedMessages({ start, end });
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
}

/** Caller-enforced read window; omitted bounds get the documented defaults
 * (end: now, start: 24 hours before end). */
export interface ReadWindow {
  start?: Date | undefined;
  end?: Date | undefined;
}

/**
 * Build the read_imessages tool, optionally hard-bound to a time window.
 *
 * Without a window the model chooses the range itself (hoursBack or explicit
 * start/end — today's behavior). With one, the returned tool exposes ONLY
 * `limit`: the window lives in a closure, not in the schema, so no tool
 * arguments — model-chosen or prompt-injected — can read outside it. The
 * bounds are resolved once, at construction, so every call within a request
 * sees the identical window.
 */
export function createReadImessagesTool(window?: ReadWindow): AgentTool {
  if (window?.start || window?.end) {
    const end = window.end ?? new Date();
    const start = window.start ?? new Date(end.getTime() - 24 * 3600_000);
    return defineTool({
      name: "read_imessages",
      description:
        BASE_DESCRIPTION +
        ` This tool is bound to the window ${start.toISOString()} to ${end.toISOString()} ` +
        "(inclusive); every call returns messages from that window only.",
      schema: z.object({ limit: limitSchema }),
      execute: ({ limit }) => readTrustedMessageWindow({ start, end, limit }),
    });
  }

  return defineTool({
    name: "read_imessages",
    description: BASE_DESCRIPTION,
    schema: z.object({
      hoursBack: z
        .number()
        .positive()
        .max(24 * 30)
        .default(24)
        .describe("How far back to read, in hours (default 24, max 720). Ignored when start is set."),
      start: z.iso
        .datetime({ offset: true })
        .optional()
        .describe(
          "Window start as an ISO 8601 timestamp, inclusive (e.g. 2026-07-20T00:00:00Z). Overrides hoursBack.",
        ),
      end: z.iso
        .datetime({ offset: true })
        .optional()
        .describe(
          "Window end as an ISO 8601 timestamp, inclusive. Default: now. hoursBack counts back from this.",
        ),
      limit: limitSchema,
    }),
    execute: ({ hoursBack, start, end, limit }) => {
      // Explicit start/end win over hoursBack; without start, hoursBack counts
      // back from end (which itself defaults to now), so "the 24 hours before
      // <end>" works without computing a start. A start after end is rejected
      // by fetchTrustedMessages, which surfaces to the model as a tool error
      // it can self-correct on.
      const endDate = end ? new Date(end) : new Date();
      const startDate = start
        ? new Date(start)
        : new Date(endDate.getTime() - hoursBack * 3600_000);
      return readTrustedMessageWindow({ start: startDate, end: endDate, limit });
    },
  });
}

// Default, unbounded instance for agents that let the model pick the window.
export const readImessagesTool = createReadImessagesTool();
