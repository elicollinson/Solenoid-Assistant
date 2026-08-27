// The read and write ends of the log store that the browser talks to.
//
//   GET  /api/runs/:runId/logs   what a run said, out of VictoriaLogs
//   POST /api/logs               what the browser said, into VictoriaLogs
//
// The read is the one that matters: the Logs tab in the Workflows detail pane
// draws this, so the store is the source of a run's log rather than a copy of
// it. It falls back to the run record when the store is off or unreachable,
// and says which of the two it answered with — a thinner log passing silently
// for the full one is worse than an empty pane.
import { Elysia, t } from "elysia";
import { loadRuntimeConfig } from "../../core/config";
import { ingestLogRecord, log, type LogRecord } from "../../core/logger";
import { LogQueryError, queryRunLogs, logQueryEnabled } from "../../core/logging/query";
import { getDb, type Db } from "../../db";
import { loadRunLogs } from "../../db/queries/workflows";
import { logStamp } from "../../db/queries/_format";
import * as s from "../../db/schema";
import { eq } from "drizzle-orm";
import type { WorkflowLogLevel, WorkflowLogLine, WorkflowRunLogsPayload } from "../../shared/workflows";

/**
 * "06:12:04.221", the stamp the log stream draws.
 *
 * The same formatter the run record's own lines go through, deliberately: the
 * two sources answer the same pane, and a log that jumps eight hours when the
 * store goes down is a log nobody can read a sequence out of.
 */
function clockOf(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "--:--:--.---" : logStamp(at);
}

export function createLogRoutes(resolveDb: () => Db = getDb) {
  return new Elysia({ name: "routes.logs" })
    .get(
      "/api/runs/:runId/logs",
      async ({ params, query, set }): Promise<WorkflowRunLogsPayload | { error: string }> => {
        const db = resolveDb();
        const [run] = db
          .select({ id: s.workflowRuns.id, startedAt: s.workflowRuns.startedAt })
          .from(s.workflowRuns)
          .where(eq(s.workflowRuns.id, params.runId))
          .limit(1)
          .all();
        if (!run) {
          set.status = 404;
          return { error: `No run with id ${params.runId}` };
        }

        const fallback = (note: string | null): WorkflowRunLogsPayload => ({
          runId: run.id,
          source: "database",
          note,
          lines: loadRunLogs(db, run.id),
        });

        const config = loadRuntimeConfig();
        if (!logQueryEnabled(config)) {
          return fallback("VICTORIALOGS_ENABLED is false — showing the run record's own lines.");
        }

        try {
          const stored = await queryRunLogs(run.id, {
            config,
            ...(run.startedAt ? { since: run.startedAt } : {}),
            ...(query.limit ? { limit: query.limit } : {}),
          });
          // An empty answer is not the same as a failed one, but for a run
          // that has lines on the record it means the store never got them —
          // it was down while the run went, or started after it. Show what
          // there is rather than an empty pane.
          if (stored.length === 0) {
            const kept = loadRunLogs(db, run.id);
            if (kept.length > 0) {
              return { runId: run.id, source: "database", note: "Nothing in the log store for this run yet.", lines: kept };
            }
          }
          const lines: WorkflowLogLine[] = stored.map((line) => ({
            t: clockOf(line.at),
            level: line.level as WorkflowLogLevel,
            text: line.message,
            component: line.component,
            service: line.service,
          }));
          return { runId: run.id, source: "victorialogs", note: null, lines };
        } catch (error) {
          // Never a failed request: the log pane is a read, and a log store
          // that is down is not a reason for the screen to break.
          const why = error instanceof LogQueryError ? error.message : String(error);
          log.warn("Could not read run logs from VictoriaLogs — falling back to the run record", {
            run_id: run.id,
            error: why,
          });
          return fallback(`${why}. Showing the run record's own lines instead.`);
        }
      },
      {
        params: t.Object({ runId: t.String() }),
        query: t.Object({ limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20_000 })) }),
        detail: { summary: "Everything logged under one run id, from the log store where there is one" },
      },
    )
    .post(
      "/api/logs",
      ({ body, set }) => {
        // Same store, own `service`, so the browser's own errors are findable
        // next to the request that caused them rather than only in a console
        // nobody had open. Capped, because this endpoint has no auth in front
        // of it and neither does anything else here.
        for (const entry of body.entries.slice(0, 100)) {
          const record: LogRecord = {
            timestamp: entry.timestamp ?? new Date().toISOString(),
            level: entry.level,
            service: "solenoid-web",
            component: entry.component ?? "browser",
            message: entry.message.slice(0, 4_000),
            ...(entry.trace_id ? { trace_id: entry.trace_id } : {}),
            ...(entry.span_id ? { span_id: entry.span_id } : {}),
            ...(entry.request_id ? { request_id: entry.request_id } : {}),
            ...(entry.session_id ? { session_id: entry.session_id } : {}),
            ...(entry.path ? { path: entry.path } : {}),
          };
          ingestLogRecord(record);
        }
        set.status = 202;
        return { accepted: Math.min(body.entries.length, 100) };
      },
      {
        body: t.Object({
          entries: t.Array(
            t.Object({
              timestamp: t.Optional(t.String({ maxLength: 40 })),
              level: t.Union([
                t.Literal("debug"),
                t.Literal("info"),
                t.Literal("ok"),
                t.Literal("warn"),
                t.Literal("error"),
              ]),
              message: t.String({ maxLength: 4_000 }),
              component: t.Optional(t.String({ maxLength: 64 })),
              trace_id: t.Optional(t.String({ maxLength: 64 })),
              span_id: t.Optional(t.String({ maxLength: 64 })),
              request_id: t.Optional(t.String({ maxLength: 128 })),
              session_id: t.Optional(t.String({ maxLength: 128 })),
              path: t.Optional(t.String({ maxLength: 512 })),
            }),
            { maxItems: 100 },
          ),
        }),
        detail: { summary: "Accept structured log records from the browser app into the same store" },
        response: { 202: t.Object({ accepted: t.Number() }) },
      },
    );
}
