import { z } from "zod";
import { defineTool } from "../core/tools";

export const getTimeTool = defineTool({
  name: "get_time",
  description:
    "Get the current date and time. Returns UTC in the same ISO 8601 format as read_imessages " +
    "timestamps (directly comparable as strings), plus the local timezone and day of week. " +
    "Use this to anchor relative expressions like 'today', 'last night', or 'this morning' " +
    "before choosing an hoursBack window for read_imessages.",
  schema: z.object({}),
  execute: () => {
    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      // Matches Message.timestamp.toISOString() — lexicographic comparison works.
      utcIso: now.toISOString(),
      timeZone,
      local: now.toLocaleString("en-US", {
        timeZone,
        dateStyle: "full",
        timeStyle: "long",
      }),
      unixSeconds: Math.floor(now.getTime() / 1000),
    };
  },
});
