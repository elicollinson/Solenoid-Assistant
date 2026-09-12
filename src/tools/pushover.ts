import { z } from "zod";
import { defineTool } from "../core/tools";
import { defineToolGroup } from "../core/toolGroups";
import { currentTurn } from "../chat/turn";
import { messageSchema } from "../pushover/client";
import { pushoverStatus } from "../pushover/config";
import { sendPush } from "../pushover/delivery";
import type { ToolGroupContext } from "./groups";

export function pushoverGroup(context: ToolGroupContext) {
  return defineToolGroup({
    name: "pushover", title: "Push notifications",
    summary: "Optional push notifications to your configured personal Pushover account, with local setup status.",
    purpose: "Pushover is an optional personal notification channel. Configuration is supplied by the operator, never by tool arguments. The local setup status is available even when disabled.",
    guidance: "Service acceptance does not prove device arrival or acknowledgement. Sending requires chat approval; an uncertain submission must never be automatically repeated. When reminder delivery is enabled separately, setting a dated reminder authorizes its scheduled push without another approval at due time. Use the reminder's history to check submission outcomes.",
    shape: { singular: "push notification", spine: [] },
    tools: [
      defineTool({ name: "pushover_status", kind: "read", description: "Check local Pushover configuration and reminder enablement without network access. Shows missing setting names, never credentials. Ready means configured locally, not delivery verified.",
        schema: z.strictObject({}), execute: () => pushoverStatus() }),
      defineTool({ name: "pushover_send", kind: "write", description: "Submit one push to your configured personal account on all active devices after chat approval. Submits message/title/link as reviewed. Returns service acceptance, not delivery or read confirmation. Reuse requestId for the same attempt; never automatically invent a new ID after an unknown outcome.",
        schema: messageSchema.safeExtend({ requestId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).describe("Unique ID for this intended notification. Reuse for a repeated call with identical text.") }),
        execute: async ({ requestId, ...message }, call) => {
          if (!currentTurn()) throw new Error("Direct push sending requires the interactive chat approval path; no notification was sent.");
          return sendPush(context.db, requestId, message, { signal: call?.signal });
        } }),
    ],
  });
}
