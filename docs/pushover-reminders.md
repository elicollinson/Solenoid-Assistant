# Pushover notifications for reminders

Pushover is optional and off by default. With both enablement settings on, the existing Solenoid worker submits a push when an open, dated reminder becomes due. The reminder's title is the notification body. This is a due-time alert, not a confirmation when the reminder is created. No LLM call or second approval happens at delivery time.

## Secure setup

1. Install a Pushover client, sign in, and register the receiving device. Confirm your personal **User Key** on the [Pushover dashboard](https://pushover.net/). Receiving licenses are US$4.99 once per platform after a 30-day trial. [Official pricing](https://pushover.net/pricing).
2. Register a personal application named **Solenoid Assistant** to obtain its **API token**. Application registration is free. Each self-hosted installation supplies its own token. [Application token setup](https://support.pushover.net/i175-how-to-get-a-pushover-api-or-pushover-application-token).
3. Put `PUSHOVER_APP_TOKEN` and `PUSHOVER_USER_KEY` in Solenoid's ignored `.env` through your local editor, or in the deployment's encrypted secret store. Use your personal User Key; a group key has the same syntax and would notify other people. Never paste keys into chat, source code, issue/PR text, shell command arguments, or a notification. The Settings database stores secret metadata, not secret values; this integration reads its values from the runtime environment.
4. While enablement remains off, run `bun run check:pushover`. This checks the configured token/recipient against Pushover without sending a notification. It reports validation status and device count, never the keys or device names.
5. Review existing open, dated reminders: overdue reminders will catch up when enabled. Set these non-secret values in the same configuration:

   ```dotenv
   PUSHOVER_ENABLED=true
   PUSHOVER_REMINDERS_ENABLED=true
   PUSHOVER_TIMEOUT_MS=10000
   ```

6. After the code is deployed through your normal process, apply migrations with `bun run db:migrate`, then restart both server and worker with the updated configuration. `bun start` starts both for local use. A server without a worker can accept reminders but cannot deliver due pushes. **This change does not deploy or restart production.**

`PUSHOVER_ENABLED` enables the optional direct tool. `PUSHOVER_REMINDERS_ENABLED` is separate standing authorization for scheduled reminder pushes. Both must be true for reminders. Missing or invalid configuration disables sending without preventing reminder creation or the rest of the app from starting. Configuration is read from the process environment; changing the `.env` file requires a process restart.

The development Compose setup mounts `.env`, so the same settings apply. The hosted **mini-cloud** deployment instead needs environment mappings for **both server and worker** in its Solenoid Compose definition before deployment:

| Container setting | Encrypted mini-cloud input |
| --- | --- |
| `PUSHOVER_ENABLED` | `SOLENOID_PUSHOVER_ENABLED` (default `false`) |
| `PUSHOVER_REMINDERS_ENABLED` | `SOLENOID_PUSHOVER_REMINDERS_ENABLED` (default `false`) |
| `PUSHOVER_APP_TOKEN` | `SOLENOID_PUSHOVER_APP_TOKEN` |
| `PUSHOVER_USER_KEY` | `SOLENOID_PUSHOVER_USER_KEY` |
| `PUSHOVER_TIMEOUT_MS` | `SOLENOID_PUSHOVER_TIMEOUT_MS` (default `10000`) |

Those hosted mappings, encrypted values, and deployment belong to a subsequent mini-cloud change; this assistant PR does not alter that repository or grant deployment approval.

## Verification

Ask Solenoid: “Check Pushover setup.” The optional `get_pushover_tools` group contains `pushover_status`; this read is local and cannot send anything. `ready` means the direct tool is configured, and `remindersReady` also requires scheduled delivery to be enabled. It does not prove device arrival.

For an explicitly identified live smoke test after setup, ask: “Set a reminder called ‘Pushover reminder delivery test’ for two minutes from now.” Approve the normal reminder creation. Keep the worker running and verify that nothing is sent immediately. At its due time, check the receiving device and the reminder's **Push** status/history separately. The worker polls every five seconds and processes one due occurrence at a time; backlog and request latency can delay delivery. Complete or dismiss the test reminder afterward.

For cancellation, create another test reminder for a future time and dismiss it before it is due. For rescheduling, move a future test reminder later and verify there is no send at the old time. These actions cancel pending sends; an attempt already marked “Submitting” cannot be recalled.

## Reminder lifecycle

- **Due/overdue:** the SQLite reminder row remains the schedule. On worker restart or enablement, open dated reminders without a settled delivery catch up, oldest first. There is no age cutoff that silently discards an internal reminder. Review old fixtures or unwanted reminders before first enablement.
- **Undated:** “Someday” produces no push. Adding a due time schedules one. Removing it cancels pending delivery.
- **All day/timezones:** `dueAt` is an absolute stored instant, including the offset chosen at creation. `allDay` changes presentation, not the delivery clock. Choose the desired clock time explicitly, including for all-day reminders. Existing `snoozedUntil`, if later, delays the push.
- **Edits:** wording changes use the latest title at dispatch but do not resend an already submitted reminder. Changing `dueAt` or `snoozedUntil` cancels pending delivery and creates a new occurrence, including moving away and back to a previously used time. Closing or deleting cancels pending delivery. An in-flight send can still arrive after an edit/close.
- **Completion:** push acceptance never completes, dismisses, or removes a reminder. Errors also leave internal reminders intact. A later snooze is a new requested alert.
- **Recurrence:** this change does not invent a recurrence engine. The existing reminder tools are one-shot; an unused stored recurrence rule does not create additional occurrences.

The existing create/revise/complete/dismiss approval and workflow-consent paths are retained. Enabling scheduled pushes authorizes notification of reminders created through those paths; there is no separate `pushover.write` decision when due. No unrelated workflow receives new tools, schedules, or permissions.

## Outcomes and retries

The [Pushover Message API](https://pushover.net/api) returns service acceptance, which is not a delivery or read receipt. This integration sends normal-priority text with the account's default sound to all active devices. It does not request emergency priority or override quiet hours. Personal keys and destinations are configuration-only.

SQLite records an occurrence before the external request. Multiple workers and direct chat sends share a single active reservation. Accepted occurrences are not automatically sent again, even across restarts. A crash after reservation, timeout, lost connection, malformed success response, or uncertain server failure becomes **unknown** and is not automatically retried. A crash between reservation and HTTP can therefore lose a push; the reminder remains visible. Exactly-once delivery cannot be guaranteed without a provider idempotency contract.

A definite quota rejection is safe to retry after its reset timestamp, or after an hour if no usable timestamp is available. The cooldown is shared across chat and workers. Other definitive rejections remain visible and do not loop. Disabled/missing configuration and pre-dispatch cancellation leave scheduled occurrences pending. Fix setup and deliberately reschedule an uncertain/rejected reminder if another attempt is wanted, taking account of possible prior delivery. Wording changes alone do not retry.

The provider's free sending quota is shared across an account's applications: 10,000/month for individuals, 25,000 for Teams. This implementation does not purchase capacity. [Quota details](https://support.pushover.net/i12-message-size-and-frequency-limitations).

The **Push** metadata and history on reminder details distinguish pending, submitting, accepted, rejected, and unknown. The notification copy of a very long title is shortened to fit; the stored reminder is preserved. Credentials, full transport bodies, and raw provider errors are excluded from diagnostics. Explicit tool message arguments follow the app's existing chat/log retention. The queue stores operation metadata and hashes, not message bodies or credential values; keep database backups to preserve duplicate protection. Restoring an old database backup can replay operations absent from that backup.

## Optional direct tool

`pushover_send` accepts `requestId`, `message`, optional `title`, `url`, and `urlTitle`. It requires the interactive chat approval path; there are no model-supplied tokens, recipients, priorities, devices, or attachments. Reusing an accepted `requestId` with identical content returns the previous acceptance without a new request. Reusing it with different content fails. Unknown attempts must not be retried automatically with a fresh ID. This direct tool does not replace reminder scheduling.

## Validation and PR integration

Tests use temporary SQLite databases and mocked HTTP, including due-time boundaries, overdue catch-up, edits/cancellation, two connections, durable duplicate handling, ambiguous failures, quota reset, Unicode limits, secret-safe errors, and chat approval. Run `bun test src/pushover/pushover.test.ts` and `bun run typecheck`; broader reminder/catalog/schema regressions are part of PR validation.

Migration `0011_pushover_reminders` adds operational tables, schedule-maintenance triggers, and a backfill for existing open dated reminders. It follows Collections' reserved `0009`/`0010`, and precedes Gemini search's `0012`. This independent PR branches from `0008`; before merging successive PRs, regenerate the combined Drizzle snapshot chain and reconcile the migration journal in that order. Preserve the hand-written triggers/backfill when regenerating. Do not apply later migrations to a shared database before earlier ones: Drizzle's journal timestamps determine which work is already applied.

The [original cited design spike](../docs/pushover-integration-design.md) records API research and optional later features. The user's subsequent reminder request superseded its initial design-only/no-workflow-wiring scope for reminder delivery.
