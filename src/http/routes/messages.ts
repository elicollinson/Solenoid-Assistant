import { Elysia, t } from "elysia";
import { extractMessages } from "../../workflows/messageExtraction";

interface MessageContext {
  query: { start?: string; end?: string };
  set: { status?: number | string };
}

const messageHandler = async ({ query, set }: MessageContext) => {
  const start = query.start ? new Date(query.start) : undefined;
  const end = query.end ? new Date(query.end) : undefined;
  if (start && Number.isNaN(start.getTime())) {
    set.status = 400;
    return { error: `Invalid start: "${query.start}" is not a parseable date/time` };
  }
  if (end && Number.isNaN(end.getTime())) {
    set.status = 400;
    return { error: `Invalid end: "${query.end}" is not a parseable date/time` };
  }
  if (start && end && start >= end) {
    set.status = 400;
    return {
      error: `Invalid range: start (${start.toISOString()}) must be before end (${end.toISOString()})`,
    };
  }
  try {
    return await extractMessages({ start, end });
  } catch (error) {
    set.status = 502;
    return { error: error instanceof Error ? error.message : "Agent call failed" };
  }
};

const messageContract = {
  detail: {
    summary:
      "Extract action items from iMessage conversations within an optional date range",
  },
  query: t.Object({
    start: t.Optional(t.String({ description: "Inclusive window start" })),
    end: t.Optional(t.String({ description: "Inclusive window end" })),
  }),
  response: {
    200: t.Object({
      actionItems: t.Array(t.String()),
      conversationSummaries: t.Array(t.String()),
      memoryContext: t.Array(t.String()),
      okfUpdate: t.Unknown(),
    }),
    400: t.Object({ error: t.String() }),
    502: t.Object({ error: t.String() }),
  },
};

export const messageRoutes = new Elysia({ name: "routes.messages" })
  .get("/message-extraction", messageHandler, messageContract)
  .get("/messageExtraction", messageHandler, {
    ...messageContract,
    detail: {
      ...messageContract.detail,
      deprecated: true,
      summary: "Legacy alias for /message-extraction",
    },
  });
