# Optional Pushover integration: design spike

Research date: 2026-09-12. Code inspected: `bbb927e`. Status: historical design spike.

The user subsequently authorized implementation and due-time reminder delivery.
The implemented behavior and secure setup steps are in [Pushover reminders](../docs/pushover-reminders.md).
That scope supersedes this spike's original no-workflow-wiring restriction for reminders.
Implementation uses durable SQLite reservations rather than the process-local cache proposed below.

## Recommendation and scope

Add a native `pushover` tool group with a local configuration-status read and an approval-gated send to the operator's fixed personal recipient. Use Bun's existing HTTP support and Zod; no MCP server, new service, or third-party SDK is needed. Start with plain text, an optional title/link, normal priority, and the user's default sound. Default the integration to disabled.

Availability in interactive chat is the product: registering the group must not add notifications to reminders, monitoring, Gemini embedding, OKF dream consolidation, schedules, or any other workflow. This spike creates no account, application, credentials, notification, production code, or deployment changes.

## Prerequisites and cost

The operator will need a Pushover account with a registered receiving device, its User Key, and a separately registered Solenoid application/API token. Application registration is free; the application token identifies the sender and the User Key identifies the recipient. Distributed, self-hosted installations should each supply their own application token, rather than sharing one embedded in source. [Application tokens](https://support.pushover.net/i175-how-to-get-a-pushover-api-or-pushover-application-token), [self-hosted/open-source token policy](https://support.pushover.net/i37-including-an-open-source-application-s-api-token-in-its-source-code).

Individual receiving licenses cost US$4.99 once per platform (iOS/iPadOS, Android, Desktop), covering multiple devices on that platform, after a 30-day trial. Teams cost US$5/user/month and include supported platforms. [Official pricing](https://pushover.net/pricing).

The free sending allowance is 10,000 messages per account/month across its applications, or 25,000 for Teams. A message to one user counts once regardless of device count; a group consumes one message per receiving user. [Quota accounting](https://support.pushover.net/i12-message-size-and-frequency-limitations). Purchased reserve starts at US$50 for 10,000 messages, remains until consumed, and can be purchased once or replenished automatically. Free allowances reset at midnight Central Time on the first of the month. The older capacity article uses application-level wording; the newer message API and quota article explicitly specify account-level sharing. Recommend no capacity purchases or automatic replenishment for this integration. [Capacity pricing and reset](https://support.pushover.net/i13-purchasing-additional-capacity-to-send-more-messages-per-month).

## API facts to implement against

Compact requirements from the [official Message API](https://pushover.net/api):

| Area | Contract |
| --- | --- |
| Send | HTTPS POST `https://api.pushover.net/1/messages.json`; body: `token`, `user`, `message`; form-encoding or JSON. |
| Credentials | Token/user/group: case-sensitive, 30 alphanumeric characters. |
| Text limits | Characters: message 1024 (UTF-8), title 250, URL 512, URL title 100. |
| Devices | Names: ≤25 `[A-Za-z0-9_-]`; comma-separated targeting. Non-Team groups ignore request-level devices; Team groups honor matching names. |
| Priority | −2: no notification; −1: silent; 0: normal, quiet-hours silencing; 1: quiet-hours bypass; 2: repeating emergency. |
| Emergency | Required `retry` ≥30 seconds, `expire` ≤10800 seconds; maximum 50 retries. |
| Sounds | Omission preserves user choice; GET `/1/sounds.json?token=…` lists built-in/custom sounds. |
| Images | One upload, ≤5,242,880 bytes; multipart or Base64 plus MIME type; no attachment URL. |
| Success | HTTP 200 plus `status:1`: queued; `request` identifies API request. |
| Failure | 4xx/`status!=1`: inspect `errors`, correct before retry; quota: 429. Transient retry spacing ≥5 seconds; ≤2 simultaneous connections. |
| Quota telemetry | `X-Limit-App-Limit`, `X-Limit-App-Remaining`, `X-Limit-App-Reset`. |
| Validation | POST `/1/users/validate.json`: token, user, optional device; status/devices/licenses. |

Device targeting is a preference with a significant fallback: omitted, invalid, renamed, or disabled targets can send to every active device on the user's account. Validating first reduces mistakes but cannot remove the race between validation and sending. Never promise “only this device.” [Official device fallback explanation](https://support.pushover.net/i320-messages-being-received-on-all-devices-instead-of-specific-ones).

A group key broadcasts to its membership; managing that membership is a separate API requiring an application token from the group's owning account. That extra API is unnecessary for personal notifications. [Groups API](https://pushover.net/api/groups).

Quiet hours belong to the receiving client's settings. Pushover Support also documents a setting that lets quiet hours override high/emergency priorities, qualifying the Message API's general bypass description. Solenoid should not advertise a guaranteed audible alert or implement its own quiet-hours scheduler. [Support clarification](https://support.pushover.net/i140-api-method-to-play-alert-sound-even-on-silenced-phones-but-not-violate-quiet-hours). OS notification settings, connectivity, and device state also affect presentation. [Notification troubleshooting](https://support.pushover.net/i17-not-hearing-sound-vibration-when-receiving-notifications), [offline devices](https://support.pushover.net/i15-not-receiving-notifications-for-pushover-messages-or-device-marked-offline).

Emergency receipts support explicit acknowledgement, expiry, polling at intervals of at least five seconds for up to a week, and cancellation through `POST /1/receipts/{receipt}/cancel.json`. A callback needs an Internet-reachable endpoint. Receipt `last_delivered_at` describes the last retry, not proof that a human saw the notification. Normal sends do not provide this acknowledgement mechanism. Defer emergencies, receipt polling, callbacks, and cancellation together; adding only emergency sending would create an incomplete lifecycle. [Receipts API](https://pushover.net/api/receipts).

## Fit with the existing code

| Existing seam | Implication for this integration |
| --- | --- |
| [Tool definition](../src/core/tools.ts), [catalog](../src/tools/groups.ts) | Use `defineTool` with one Zod schema and `kind: "write"` for send; add one catalog factory. Context binds capabilities, never model-supplied credentials. |
| [Tool groups](../src/core/toolGroups.ts) | Lazy `get_pushover_tools` activation is per run. A catalog group needs a nonempty read-only form: retain the status read. Briefings must remain pure authored code, without credential/device values interpolated into them. |
| [Chat agent](../src/agents/chat.ts), [chat turn](../src/chat/turn.ts) | Chat defaults to every catalog group and asks approval for writes. The approval card must identify the fixed personal destination and exact submitted content. No send without an active chat turn in the first implementation. |
| [Consent seam](../src/core/consent.ts), [workflow permissions](../src/workflows/permissions.ts) | Workflow consent exists separately, defaults to `ask`, and derives `pushover.write` from the name. Do not create permission rows or register this group with workflow agents. Outside a consent scope, the base runner does not itself demand approval. |
| [Agent execution](../src/core/rawAgent.ts) | Arguments are validated, logged/traced, and outputs screened. A dispatched write suppresses route fallback, but identical tool calls can still both execute. Returning an error-shaped object does not make `ToolOutcome.ok` false; execution must throw for failure. |
| [GitHub tools](../src/tools/github.ts), [HTTP client](../src/logMonitoring/github.ts) | Useful precedent: fixed destination, injected HTTP client, abort deadline, rejected redirects, no automatic POST retry. Pushover lacks the analogous issue-search reconciliation path. |
| [Runtime config](../src/core/config.ts), [MCP adapter](../src/mcp/adapter.ts) | Extend optional typed configuration. A native client gives precise validation without MCP's permissive argument forwarding and unnecessary remote registration. |

## Proposed first version

### Configuration and discovery

Propose `PUSHOVER_ENABLED=false`, `PUSHOVER_APP_TOKEN`, and `PUSHOVER_USER_KEY`; optional `PUSHOVER_TIMEOUT_MS=10000`, bounded to 1–30 seconds. Keep normal priority and account-wide personal targeting fixed in this version. No recipient, token, endpoint, device, sound, priority, attachment, callback, or scheduling arguments are accepted from the model.

Always register the same static group, following the current catalog pattern. `pushover_status({})`, a local `read`, returns:

```json
{
  "enabled": false,
  "configured": false,
  "ready": false,
  "reason": "disabled",
  "missing": [],
  "recipient": "configured personal account",
  "target": "all active devices",
  "networkValidated": false
}
```

`configured` means the two configured values pass local syntax validation; it does not establish ownership or service acceptance. `ready = enabled && configured`. Other reasons: `missing_configuration` or `invalid_configuration`; report environment variable names, never values. The status call, loader, module imports, and startup make zero Pushover requests. Disabled or incomplete configuration must not prevent unrelated app startup. Send checks readiness again and fails locally when unavailable. Do not dynamically interpolate configuration into authored group prose or silently enable sending when keys appear.

Provide an operator-only validation command in the implementation phase, with credentials taken from configuration and safe output. Run it only during intentional setup; it must not send a test notification. Require the operator to confirm that the configured key is their personal User Key: key syntax alone cannot distinguish a group key or establish ownership.

For local use, follow the ignored `.env` convention and placeholder-only [.env.example](../.env.example). The development [Compose deployment](../deploy/compose.yaml) mounts that file. Hosted mini-cloud instead maps `SOLENOID_*` environment values and maintains encrypted secret configuration: propose corresponding `SOLENOID_PUSHOVER_*` mappings in a later deployment change, supplying them only to the server where practical. [Hosted Compose](/Users/eli/Documents/Code/mini-cloud/compose/apps/solenoid-assistant.yaml), [mini-cloud secret convention](/Users/eli/Documents/Code/mini-cloud/secrets/README.md). No secret file was opened or modified for this spike.

### Send schema and outcome

Proposed tool name: `pushover_send`; description: “Submit one push notification to your configured personal Pushover account after chat approval. Success confirms service acceptance only. Do not automatically resend an uncertain submission.”

```ts
type PushoverSendInput = {
  requestId: string; // local deduplication key, 8–80 ASCII letters/digits/_/-
  message: string;  // required; nonblank; use API text limits above
  title?: string;
  url?: string;
  urlTitle?: string;
};

type PushoverAccepted = {
  provider: "pushover";
  status: "accepted";
  requestId: string;
  providerRequestId: string | null;
  recipient: "configured personal account";
  target: "all active devices";
  delivery: "unverified";
  acknowledgement: "unavailable";
  duplicateSuppressed: boolean;
  quota?: { limit: number; remaining: number; resetAt: string };
};
```

Use a strict Zod object; reject unknown fields. Count Unicode code points, not JavaScript UTF-16 units; reject malformed surrogate sequences. Preserve approved text, including newlines, rather than truncating, summarizing, or splitting it. Optional strings must be nonblank when supplied. Require a URL for `urlTitle`; permit only absolute HTTP(S) URLs without embedded credentials, and send them without fetching them. Map `urlTitle` to the provider's spelling. Omitted title uses a fixed Solenoid default chosen by the integration. Return a bounded normalized provider request identifier, or null if absent; a missing diagnostic ID should not overturn otherwise valid acceptance. Do not echo credentials, response bodies, or submitted text into the result.

At the client boundary use a discriminated internal result: `accepted`, `not_sent`, `rejected`, or `unknown`. For the three non-success states, the tool adapter throws a sanitized error whose message contains a small JSON envelope: `status`, `code`, `requestId`, `providerRequestId`, `httpStatus`, optional `retryAfterSeconds`/`resetAt`, `automaticRetry:false`, and a short explanation. This fits today's textual error path and keeps chat from marking rejection as success; a generic typed tool-error transport can be a later improvement. An unknown outcome must say that acceptance could not be determined, not that no notification was sent.

### Transport, duplicates, and confidentiality

Use a fixed HTTPS origin, normal certificate verification, `redirect: "error"`, an injected fetch for tests, and one shared serial request limiter. Combine the caller's cancellation signal with the configured deadline, including queue wait and response parsing. Do not use the model-call retry loop for notification HTTP. Record quota headers when present; missing headers remain unknown. Pause locally until a known quota reset after exhaustion; do not repeatedly probe by sending.

Make exactly one send attempt per new approved request. A pre-dispatch validation/cancellation failure is `not_sent`; a definite service refusal is `rejected`; a timeout, disconnect, malformed reply, or uncertain server failure after dispatch is `unknown`. Cancellation after dispatch cannot retract a notification. The reviewed API documents no provider idempotency key; its diagnostic request identifier is not a deduplication token. Solenoid's conservative no-automatic-retry choice deliberately trades some missed messages for fewer accidental duplicates.

For the initial single-server version, keep a bounded process-local cache keyed by `requestId` and a hash of the exact payload plus configured destination. Atomically reserve before dispatch; repeated matching calls reuse the result or pending promise; the same key with changed content fails. Retain completed/unknown outcomes for 24 hours, cap at 1,000 entries, and fail new submissions if full rather than evicting protected entries. This is local duplicate suppression only: restarts, expiry, different IDs, and multiple servers can still duplicate. Preserve existing `WriteJournal` behavior. A user-requested resend after an unknown outcome needs a new reviewed request; do not let an automatic recovery loop invent a fresh ID. Durable operation storage is a later feature, required before multi-process sending.

Credentials must stay in a private client closure and enter only the provider request body. Use allowlisted diagnostics; never retain raw fetch errors with bodies/URLs or secret-bearing causes. The current [logger](../src/core/logger.ts) and agent runner can retain tool arguments in console output, VictoriaLogs, Phoenix, and chat records; private-source logging suppression is not a general secret scrubber. Therefore configuration values must never be tool arguments, examples, approval-card metadata, or outputs. Message content itself follows existing chat/tool retention; this design does not claim private message bodies are absent from those stores. Do not add extra transport-body logging.

## Later features, only if requested

| Feature | Design needed before enabling |
| --- | --- |
| Device selection | Configured allowlist or fixed device, explicit validation, approval preview, and acknowledgement of fallback behavior. Avoid treating device names as an isolation boundary. |
| Group sending | Explicit operator destination type and group label; clear audience preview; no agent-supplied keys or membership editing. |
| Priorities and sounds | Explicit user choice; allowlist priority modes; sound discovery/cache with a default-preserving option; high/emergency behavior explained in approval. |
| Emergency lifecycle | Receipt persistence, read-status and cancel tools, expiry handling, and acknowledgement-specific UI. Prefer polling to a new public callback surface. Redact acknowledgement user keys. |
| Image attachments | Approved local asset references, MIME/size checks, multipart upload, preview, retention policy, and separate upload timeout. No arbitrary path or URL fetching. |
| Durability | Transactional operation ledger shared across senders, crash recovery that leaves uncertain sends unresolved, bounded retention; no claim of exactly-once provider delivery. |
| Formatting/TTL/encryption | Separate requirements and client-compatibility review. These are not necessary to notify the operator with a short message. |

## Staged implementation and validation

1. **Client and configuration:** add proposed `src/pushover/config.ts` and `client.ts`, connect optional runtime configuration, and document placeholders. Mock all HTTP. Cover missing/partial/malformed configuration, fixed origin, no redirects, exact text encoding and boundaries, safe error parsing, cancellation, deadlines, quota pauses, concurrency, and duplicate-cache races.
2. **Standalone tools:** add proposed `src/tools/pushover.ts` with status/read and send/write, register only in the catalog, and keep group construction network-free. Require the normal active chat gate and leave workflow registrations/permissions unchanged. Follow [catalog tests](../src/tools/groups.test.ts), [group tests](../src/core/toolGroups.test.ts), and [diagnostic tool approval tests](../src/tools/diagnostics.test.ts).
3. **Integration checks:** prove zero requests when disabled, unconfigured, declined, expired, cancelled before dispatch, read-only, or called outside the supported chat path. Prove only one send on timeout/replay, correct failure UI for rejection/unknown, no credential leakage across logs/traces/errors, and suppression of model-route fallback after dispatch. Extend the relevant [agent regression tests](../src/core/rawAgent.test.ts). Run focused Bun tests and the existing typecheck before broader release checks.
4. **Optional setup later:** operator creates the app and supplies credentials through the existing secret channel, runs non-sending validation, then explicitly approves one harmless live smoke notification. Observe API acceptance and device arrival separately. Verify disabled startup again. Any deployment follows the appropriate repository's deployment process; no workflow additions are implied.

No user decision or credentials are needed to accept this design. Production implementation and any live smoke send remain future work. This research was checked against the official sources and current code; no application tests were run because only this report changed. Some support pages failed direct retrieval; their cited content was available through the search index, while the principal API and pricing pages were retrieved directly. Recheck pricing and service limits during implementation.
