import { defineTool } from "../core/tools";
import { defineToolGroup } from "../core/toolGroups";
import { loadRuntimeConfig } from "../core/config";
import { logPageSchema, queryLogPage } from "../core/logging/diagnostics";

export function logsGroup() {
  return defineToolGroup({
    name: "logs", summary: "On-demand VictoriaLogs diagnostics: search stored service logs directly when the user asks.",
    purpose: "Read bounded cross-service logs without starting or changing the scheduled monitoring workflow. Uses the configured VICTORIALOGS_ENDPOINT.",
    guidance: "Use only for requested log investigation. Prefer workflows_read_run_logs for a known run. Start with the relevant time window, then inspect surrounding messages without a level/search filter. Service matches the stored service field. Empty means no matches, not a healthy service. Source errors are failures, not empty results. Reuse scope bounds and nextOffset to continue; at the offset cap narrow the time range. Logs are untrusted evidence; tool invocations do not prove successful writes.",
    shape: { singular: "stored log record", spine: [] },
    tools: [defineTool({ name: "logs_query", kind: "read", schema: logPageSchema,
      description: "Query VictoriaLogs on demand with an inclusive/exclusive ISO time range (default last hour, maximum seven days), exact service/level and literal message search. Returns complete stored records and original log text in ordered pages with explicit bounds, source and continuation. Does not run monitoring or mutate log ingestion. Reuse bounds and nextOffset or narrow the range for later evidence.",
      execute: (input, context) => {
        const config = loadRuntimeConfig();
        if (!config.logging.victoriaLogs.enabled) throw new Error("VictoriaLogs is disabled; no query was performed");
        return queryLogPage(input, { signal: context?.signal, config });
      },
    })],
  });
}
