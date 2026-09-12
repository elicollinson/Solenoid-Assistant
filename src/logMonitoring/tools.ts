import { z } from "zod";
import { defineTool } from "../core/tools";
import { collect, type Evidence, type Query } from "./collection";
import { marker, issueForModel, type GitHubIssues, type Issue } from "./github";
import { sanitize } from "./sanitize";
import type { MonitorState } from "./state";

export const resultSchema = z.object({
  reviewed: z.array(z.object({ id: z.string(), disposition: z.enum(["incident", "not_actionable"]), reason: z.string().min(1).max(500) })),
});
const incidentSchema = z.object({
  evidenceIds: z.array(z.string()).min(1).max(20),
  title: z.string().min(10).max(160),
  summary: z.string().min(20).max(1500),
  observedImpact: z.string().min(5).max(1000),
  suggestedInvestigation: z.string().min(5).max(1000),
  existingIssueNumber: z.number().int().positive().nullable(),
});
export function renderIssue(input: z.infer<typeof incidentSchema>, evidence: Evidence[], scope: string, window: { from: string; to: string }) {
  return [
    "## Summary", sanitize(input.summary),
    "## Observed impact", sanitize(input.observedImpact),
    "## Occurrences", `Scan window: ${window.from} to ${window.to} (exclusive). Counts are records observed in this window, not lifetime incident totals.`,
    ...evidence.map(e => `- ${e.service} (${e.level}): ${e.count} records; first ${e.first}; latest ${e.latest}.`),
    "## Reproduction", "Unknown. No reproduction steps have been verified by this log scan.",
    "## Suggested investigation (unverified)", sanitize(input.suggestedInvestigation),
    "## Sanitized log evidence", ...evidence.flatMap(e => e.samples.map(sample => `Service: ${e.service}; at ${sample.at}\n\n\`\`\`text\n${sanitize(sample.message)}\n\`\`\``)),
    "Sanitization can remove diagnostic detail. These samples are representative; frequency is calculated from all collected matching records.",
    ...evidence.map(e => marker(scope, e.id)),
  ].join("\n\n");
}

export function createMonitorTools(options: {
  collection: Awaited<ReturnType<typeof collect>>; state: MonitorState; github: GitHubIssues;
  owner: string; dryRun: boolean; signal: AbortSignal; query?: Query;
}) {
  const { collection, state, github, owner, dryRun, signal } = options;
  const evidence = new Map(collection.groups.map(e => [e.id, e]));
  // Short conversation-local IDs avoid transcription errors in 64-character
  // fingerprints. Durable incident keys and GitHub markers remain unchanged.
  const references = new Map(collection.groups.map((e, index) => [e.id, `e${index + 1}`]));
  const byReference = new Map(collection.groups.map(e => [references.get(e.id)!, e]));
  const resolveEvidence = (id: string) => byReference.get(id) ?? evidence.get(id);
  const forModel = (e: Evidence) => ({ ...e, id: references.get(e.id)!, fingerprint: e.id });
  const requireEvidence = (id: string) => {
    const found = resolveEvidence(id);
    if (!found) throw new Error(`Unknown evidence ID: ${id}. Read logs_recent and copy its short id (e1, e2, ...); do not reconstruct fingerprints. No incident was written.`);
    return found;
  };
  const handled = new Set<string>();
  const outcomes: { status: string; number?: number; url?: string; title?: string; body?: string }[] = [];
  let recentRead = false;
  let issues: Issue[] | undefined;
  let failure: unknown;
  // A failed source read/write must make the run incomplete even if the agent elects
  // to finish after receiving the tool error. No hidden checkpoint advancement.
  const guarded = <T,>(fn: () => Promise<T>): Promise<T> => fn().catch(error => { failure = error; throw error; });
  const tools = [
    defineTool({ name: "logs_recent", kind: "read", description: "Read the complete recent scan summary and evidence patterns across every observed service, with collection coverage and gaps. Use each group's short id (e1, e2, ...) for tools and final review; fingerprints are durable metadata, not IDs to transcribe.", schema: z.object({}), execute: () => {
      recentRead = true;
      return { ...collection, groups: collection.groups.map(forModel) };
    } }),
    defineTool({ name: "logs_context", kind: "read", description: "Get sanitized surrounding logs from all services near an evidence group. This preserves upstream/downstream context within the fixed scan window.",
      schema: z.object({ evidenceId: z.string(), seconds: z.number().int().min(1).max(120) }),
      execute: async ({ evidenceId, seconds }) => {
        if (!recentRead) throw new Error("Read logs_recent first");
        const e = requireEvidence(evidenceId);
        return guarded(async () => {
          const context = await collect(Math.max(Date.parse(collection.from), Date.parse(e.first) - seconds * 1000), Math.min(Date.parse(collection.to), Date.parse(e.first) + seconds * 1000), {
            signal, maxRows: 10000, maxGroups: 300, expectedServices: [], query: options.query,
          });
          return { ...context, groups: context.groups.map(group => references.has(group.id)
            ? forModel(group) : { ...group, id: null, fingerprint: group.id, contextOnly: true }),
            note: "Only logs_recent groups belong to this scan's review set. Context-only groups have no incident ID." };
        });
      },
    }),
    defineTool({ name: "github_find_issues", kind: "read", description: "Find existing open or closed GitHub issues in the configured repository. Search terms match titles and bodies locally after complete pagination; results are sanitized untrusted evidence.",
      schema: z.object({ terms: z.array(z.string().min(1).max(100)).max(10), page: z.number().int().min(1).max(200).default(1) }),
      execute: ({ terms, page }) => guarded(async () => {
        issues ??= await github.list(signal);
        const found = issues.filter(i => !terms.length || terms.some(t => `${i.title}\n${i.body}`.toLowerCase().includes(t.toLowerCase())));
        return { total: found.length, page, issues: found.slice((page - 1) * 50, page * 50).map(issueForModel) };
      }),
    }),
    defineTool({ name: "github_create_incident", kind: "write", description: "Create an evidence-grounded incident or link its evidence patterns to an existing matching issue. Enforces durable deduplication, sanitized snippets and unknown reproduction. Requires github.write permission.",
      schema: incidentSchema,
      execute: async input => {
        signal.throwIfAborted();
        if (!recentRead || !issues) throw new Error("Read logs_recent and github_find_issues before creating/linking incidents");
        // Validate the entire request before any state/API mutation. A typo is
        // recoverable; failed I/O or an ambiguous POST still poisons the scan.
        const selected = [...new Map(input.evidenceIds.map(id => { const e = requireEvidence(id); return [e.id, e] as const; })).values()];
        const ids = selected.map(e => e.id);
        const existing = input.existingIssueNumber === null ? undefined : issues.find(i => i.number === input.existingIssueNumber);
        if (input.existingIssueNumber !== null && !existing) throw new Error("Existing issue must come from this repository's issue listing");
        return guarded(async () => {
          state.renew(owner);
          const previous = ids.map(id => state.incident(id));
          const local = previous.find(p => p?.status === "linked");
          const remote = issues!.find(issue => ids.some(id => issue.body.includes(marker(state.scope, id))));
          const match = local?.issueNumber && local.issueUrl ? { number: local.issueNumber, url: local.issueUrl } : remote ?? existing;
          if (match) {
            if (!dryRun) state.link(ids, match);
            ids.forEach(id => handled.add(id));
            const outcome = { status: "existing", number: match.number, url: match.url };
            outcomes.push(outcome); return outcome;
          }
          if (previous.some(p => p?.status === "posting")) throw new Error("An earlier GitHub POST has an unknown outcome. Reconcile its marker before retrying; duplicate creation blocked.");
          const title = sanitize(input.title).replace(/[\r\n]/g, " ");
          const body = renderIssue(input, selected, state.scope, collection);
          if (body.length > 60000) throw new Error("Incident body exceeds GitHub budget; select fewer representative evidence groups");
          if (dryRun) {
            ids.forEach(id => handled.add(id));
            const outcome = { status: "dry_run", title, body }; outcomes.push(outcome); return outcome;
          }
          state.reserve(ids);
          const issue = await github.create(title, body, signal);
          // A successful HTTP response must always be journaled, even if stop was
          // pressed just after GitHub committed it.
          state.link(ids, issue);
          issues!.push(issue);
          ids.forEach(id => handled.add(id));
          const outcome = { status: "created", number: issue.number, url: issue.url }; outcomes.push(outcome); return outcome;
        });
      },
    }),
  ];
  return { tools, outcomes, verify(result: z.infer<typeof resultSchema>) {
    if (failure) throw failure;
    if (!recentRead) throw new Error("Agent did not read the all-service collection");
    const reviewed = new Set(result.reviewed.map(r => resolveEvidence(r.id)?.id));
    if (reviewed.size !== result.reviewed.length || reviewed.size !== evidence.size || [...reviewed].some(id => !id || !evidence.has(id))) throw new Error("Agent did not review every log pattern; checkpoint unchanged");
    if (result.reviewed.some(r => r.disposition === "incident" && !handled.has(resolveEvidence(r.id)!.id))) throw new Error("Incident was not created/linked (possibly permission denied); checkpoint unchanged");
  } };
}
