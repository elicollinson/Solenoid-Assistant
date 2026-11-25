import { currentToolGate, withToolGate } from "@elicollinson/solenoid-security";
import type { z } from "zod";
import { createLogMonitorAgent } from "../agents/logMonitor";
import { loadRuntimeConfig } from "../core/config";
import type { AgentTool } from "../core/tools";
import { getDb, type Db } from "../db";
import { collect, digest, type Query } from "../logMonitoring/collection";
import { loadMonitorConfig, type MonitorConfig } from "../logMonitoring/config";
import { GitHubClient, type GitHubIssues } from "../logMonitoring/github";
import { MonitorState } from "../logMonitoring/state";
import { createMonitorTools, resultSchema } from "../logMonitoring/tools";

export async function scanLogs(
  args: { dryRun?: boolean },
  options: {
    signal: AbortSignal;
    db?: Db;
    config?: MonitorConfig;
    endpoint?: string;
    query?: Query;
    github?: GitHubIssues;
    now?: number;
    analyze?: (
      tools: AgentTool[],
      signal: AbortSignal,
    ) => Promise<z.infer<typeof resultSchema>>;
  },
) {
  const config = options.config ?? loadMonitorConfig();
  const dryRun = args.dryRun ?? false;
  if (!config.enabled && !dryRun) {
    return {
      enabled: false,
      message: "Set LOG_MONITOR_ENABLED=true to enable scheduled incident scans.",
    };
  }
  const now = options.now ?? Date.now();
  const endpoint = options.endpoint ?? loadRuntimeConfig().logging.victoriaLogs.endpoint;
  const state = new MonitorState(
    options.db ?? getDb(),
    digest(`${endpoint}\n${config.repository}`),
  );
  const { owner, completedTo } = state.acquire(now);
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const timer = setInterval(() => {
    try {
      state.renew(owner);
    } catch (error) {
      controller.abort(error);
    }
  }, 30000);
  try {
    const to = Math.min(
      now - config.lagSeconds * 1000,
      completedTo === null ? Infinity : completedTo + config.lookbackMinutes * 60000,
    );
    const from =
      completedTo === null
        ? to - config.lookbackMinutes * 60000
        : completedTo - config.overlapMinutes * 60000;
    const window = dryRun ? { fromTime: from, toTime: to } : state.window(owner, from, to);
    if (window.toTime <= window.fromTime) {
      throw new Error("Invalid log scan window; check system clock");
    }
    const collection = await collect(window.fromTime, window.toTime, {
      signal,
      ...config,
      query: options.query,
    });
    const session = createMonitorTools({
      collection,
      state,
      owner,
      dryRun,
      signal,
      query: options.query,
      github:
        options.github ??
        new GitHubClient(config.repository, config.token, fetch, config.apiUrl),
    });
    const gate = currentToolGate();
    let permissionBlocked = false;
    const reviewed = await withToolGate(
      async (request) => {
        if (!gate) {
          throw new Error("Log monitoring writes require a workflow permission context");
        }
        const verdict = await gate(request);
        if (!verdict.allow) permissionBlocked = true;
        return verdict;
      },
      () =>
        options.analyze
          ? options.analyze(session.tools, signal)
          : createLogMonitorAgent(session.tools).runStructured(
              "Review this scan using logs_recent. Analyze all services together, investigate actionable incidents and return the disposition of every evidence group.",
              resultSchema,
              { signal },
            ),
    );
    signal.throwIfAborted();
    if (permissionBlocked) {
      throw new Error("GitHub write denied or deferred; checkpoint unchanged");
    }
    session.verify(resultSchema.parse(reviewed));
    if (!dryRun && state.unresolved()) {
      throw new Error(
        "Ambiguous GitHub issue creation needs reconciliation; checkpoint unchanged",
      );
    }
    if (!dryRun) state.complete(owner, window.toTime);
    return {
      enabled: config.enabled,
      dryRun,
      window: { from: collection.from, to: collection.to },
      records: collection.total,
      services: collection.services,
      gaps: collection.gaps,
      coverage: collection.coverage,
      patternsReviewed: reviewed.reviewed.length,
      issues: session.outcomes,
      checkpointAdvanced: !dryRun,
    };
  } finally {
    clearInterval(timer);
    state.release(owner);
  }
}
