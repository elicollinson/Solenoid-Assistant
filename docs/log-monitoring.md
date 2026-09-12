# Cross-service log incident monitoring

`log-monitoring` is a scheduled workflow with a dedicated `log-monitor` agent. Every run queries **all records from all services** in the configured VictoriaLogs instance, including info-level records that may explain downstream symptoms. It gives one agent conversation the complete bounded set of service/pattern summaries, counts, first/latest observations and sanitized samples. There is no per-service agent fan-out. The agent can query surrounding context across all services, find open/closed GitHub issues, and create or reuse an incident issue.

Generated issues contain summary, observed impact (or explicit uncertainty), per-service first/latest occurrence and scan-window frequency, representative sanitized snippets, and suggested investigation. Reproduction is explicitly **unknown**: this workflow does not run or verify reproduction steps. Correlation is an inference, not proof of cause. Evidence goes directly into the issue; SQLite holds only operational checkpoints, leases and issue fingerprint mappings, not an evidence registry.

## Configuration and first run

1. Configure `VICTORIALOGS_ENDPOINT` for the existing instance. Local host development defaults to `http://localhost:9428` from the root Docker Compose stack; `deploy/compose.yaml` uses `http://victorialogs:9428`.
2. Set `LOG_MONITOR_GITHUB_REPOSITORY` (default `elicollinson/Solenoid-Assistant`) and `LOG_MONITOR_GITHUB_TOKEN`, a fine-grained repository token with Issues read/write. Do not commit the token. The API host is fixed to `api.github.com`; neither logs nor the agent may choose a repository or destination.
3. Run `bun run db:migrate` and `bun run db:sync-workflows` on the intended database, as for other workflows. The catalog seeds an hourly schedule at minute 0 and `github.write=allow`. Later syncs preserve edited schedules and permission decisions.
4. Start server/worker with the required GitHub, model and safety-service configuration supplied in the same deployment. Monitoring is enabled when `LOG_MONITOR_ENABLED` is unset; the hourly schedule uses `dryRun=false`. No separate enablement deployment is required.
5. An optional `dryRun=true` run previews proposed issue bodies without publishing or advancing progress. It still uses GitHub and the model/safety service, and workflow permissions apply. Pause the workflow or explicitly set `LOG_MONITOR_ENABLED=false` to stop new scans; use the normal run Stop control to cancel an active scan. Preview is available with either enabled setting and is not a deployment gate.

| Setting | Default | Meaning |
| --- | --- | --- |
| `LOG_MONITOR_ENABLED` | `true` (also when unset or empty) | Live scans enabled; only explicit `false` opts out; dry run remains available |
| `LOG_MONITOR_GITHUB_REPOSITORY` | `elicollinson/Solenoid-Assistant` | One operator-configured repository for all monitored services |
| `LOG_MONITOR_GITHUB_TOKEN` | empty | GitHub issue access; required when the agent reads/issues incidents |
| `LOG_MONITOR_LOOKBACK_MINUTES` | `60` | Initial lookback and maximum checkpoint catch-up increment |
| `LOG_MONITOR_OVERLAP_MINUTES` | `5` | Rescan overlap for late arrivals; duplicates reuse issues |
| `LOG_MONITOR_LAG_SECONDS` | `60` | Delay between the scan end and current time |
| `LOG_MONITOR_MAX_ROWS` | `50000` | Maximum records in one scan |
| `LOG_MONITOR_MAX_GROUPS` | `300` | Maximum distinct sanitized evidence patterns in one conversation |
| `LOG_MONITOR_EXPECTED_SERVICES` | empty | Comma-separated service names to report as missing when not observed; never a collection filter |

Cadence is the existing workflow schedule row, configurable through the Workflows surface. Use a supported RRULE such as `FREQ=HOURLY;BYMINUTE=0`. Changing the environment lookback does not change cadence. When catching up after downtime, each completed run advances at most one lookback interval; retrying a failed run retains its exact original time window. Ingestion delayed beyond the overlap is not guaranteed to be observed. A window beyond VictoriaLogs retention may be empty; compare reported observed services with expected services and retention when recovering long outages.

## Mini-cloud

Read-only inspection confirmed `compose/apps/solenoid-assistant.yaml` already sets `VICTORIALOGS_ENDPOINT=http://victorialogs:9428` for the server, worker and seed job, shares the persistent SQLite volume, and joins the observability network. No new log backend is needed.

Mini-cloud's [app definition and deployment runbook](https://github.com/elicollinson/mini-cloud/blob/main/docs/apps/solenoid-assistant.md#log-incident-monitoring) own the nine `SOLENOID_LOG_MONITOR_*` host-to-container mappings for the server, worker and workflow seed job. The companion configuration PR adds these to the shared environment; no additional Compose override is required. Merely setting host variables does not update running containers.

After review, release this application and obtain its published image digest. Land the mini-cloud settings, required encrypted credentials and separate feature-image promotion together for one configuration rollout. Keep the reconciler in observe mode: environment/Compose changes require manual validate → plan → backup → apply → verify. Migrate before seeding the hourly workflow, verify scan results, then adopt the applied configuration as the reconciler anchor. Monitoring is enabled by default; a dry-run preview is optional and needs no second apply. If an older environment contains `SOLENOID_LOG_MONITOR_ENABLED=false`, remove that opt-out in the same reviewed configuration change when activation is intended. See the mini-cloud runbook for commands. These PRs do not deploy, change production secrets, or upgrade an image pin.

The mini-cloud collector configuration has an OTLP logs receiver/exporter to VictoriaLogs. It has **no Docker stdout/filelog receiver**. A container's `json-file` Docker logging driver alone does not ship its logs to VictoriaLogs. Services must emit OTLP, use Solenoid's direct log sink, or have a separately configured collector. Local root Compose likewise creates the log backend but does not collect all container stdout automatically.

## Coverage and bounded collection

The scanner queries only a time range, with no service or severity filter. It recognizes `service`, OTLP `service.name` and common resource/container/Compose/Kubernetes aliases, while retaining records with unidentified metadata as `unknown`. It reports each observed service's record count, absent expected services, unidentified records, and an empty store. This is observed shipper coverage, **not an inventory of deployed services or a health assertion**.

Saturated responses are recursively split into disjoint time windows; counts are not calculated from a global top-N sample. Saturation within one millisecond, invalid records/timestamps, response/row/pattern/request budgets, query failures and incomplete agent reviews all fail without advancing the checkpoint. Increase budgets within model context limits, shorten the lookback for new scans, or address the source of volume. A pending failed window is intentionally retained and does not shrink automatically when settings change. The agent sees representative samples plus exact per-pattern window counts, not every repeated raw line. Context queries are bounded to the fixed scan window.

Live VictoriaLogs inspection on 2026-09-11/12 found `solenoid-server`, `solenoid-worker`, and two historical browser `solenoid-web` records. The operator accepts this Solenoid-only shipper coverage for the initial rollout; Docker stdout collection is unchanged. A current-emitter example is `LOG_MONITOR_EXPECTED_SERVICES=solenoid-server,solenoid-worker`. This reports absence and does not enable collection. The feature image has not been verified deployed; verify its scan results during deployment.

## Safety, duplicate prevention and recovery

Only selected operational fields reach the evidence adapter: message, recognized severity/service metadata, and error/exception/stack fields. Arbitrary structured attributes are dropped. Sensitive lines (credentials, prompts, payloads, request/response bodies and tool arguments), known environment secrets, token forms, emails, IPs, home identities, URLs' credentials/paths/queries, long opaque values and quoted values are redacted before tool outputs reach the model or its traces. Generated prose is sanitized again before publication. The agent uses the normal input/model/tool-output safety screens; any flagged log or issue output aborts the run. `github_create_incident` is a write tool governed by the runner's `github.write` permissions; deny/ask prevents completion and keeps the checkpoint unchanged.

Redaction is deliberately conservative and can remove diagnostic context. It is not a general proof that arbitrary free-form text contains no private information. Upstream services should never log secrets or private payloads; an optional preview can help inspect sanitization for the real log formats. No fabricated incidents were published during validation.

Fingerprints are derived from sanitized service, normalized level and message/error/stack pattern, normalizing numeric values. Correlated evidence groups are linked to one issue. Exact fingerprints reuse open **or closed** issues; related issues can be chosen from the repository listing. Existing issues are reused without reopening, editing their body, or adding repeated comments. New evidence associated with an existing issue is not appended automatically. Semantically similar incidents with changed log wording still depend on the agent finding the existing issue; arbitrary semantic equivalence cannot be guaranteed by the fingerprint.

A SQLite lease serializes scans across server/worker processes sharing the database, with renewal and ownership checks before writes/checkpointing. Before POST, a durable `posting` intent reserves every fingerprint. The full paginated GitHub issue listing (`state=all`, including closed issues, excluding PRs) reconciles issue-body markers without relying on search indexing. A successful POST records the issue mapping immediately; retries reuse it. Keep the database persistent and run one deployment per database/repository scope.

If a POST times out or the process crashes after reserving it, the next scan reuses a matching marker if visible. If no issue is visible, it **does not POST again**: the earlier outcome is ambiguous, so the run fails and retains its checkpoint. To recover, inspect `log_monitor_incidents` rows with `status='posting'` and the repository for the corresponding `<!-- solenoid-log:SCOPE:FINGERPRINT -->` marker. With the workflow paused and no scan running, link the rows to the confirmed issue; only remove reservations after independently confirming no issue was created. Never clear reservations merely because a search result is absent. A crash immediately before sending POST intentionally needs the same reconciliation. Permanent API rejections also remain reserved for explicit inspection.

The initial version favors bounded, complete scans. Future per-service extraction fan-out, if justified by volume, must retain a shared correlation/issue stage: [follow-up #44](https://github.com/elicollinson/Solenoid-Assistant/issues/44).

## Validation

`bun test src/logMonitoring/monitoring.test.ts` uses fixture logs, scripted models, a migrated in-memory SQLite database and a mocked GitHub API. It covers all-service collection, noisy-service splitting, cross-service incident creation, dry-run previews, crash/retry reconciliation, closed-issue deduplication, leases, cancellations, checkpoint recovery, failed-read propagation, redaction, strict NDJSON parsing, actual Agent permission gating and injection aborts. No live incident creation is used.

Protocol references: [VictoriaLogs querying API](https://docs.victoriametrics.com/victorialogs/querying/) and [GitHub issues REST API](https://docs.github.com/en/rest/issues/issues).

## Running from chat

Chat can discover and run `log-monitoring` through `workflows_run({slug: "log-monitoring", args: {dryRun: true}, guidance: "Explain downstream symptoms carefully"})`, then read its state with `workflows_read_run`. Optional guidance reaches the standard Agent as user context for this execution only. It cannot narrow mandatory all-service coverage, omit evidence reviews, bypass permissions, or advance an incomplete checkpoint. See [chat workflow execution](chat-workflow-execution.md).
