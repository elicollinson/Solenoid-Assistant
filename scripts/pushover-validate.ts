#!/usr/bin/env bun
// Operator-only check. Reads configured secrets and never submits a notification.
import { loadPushoverConfig, pushoverStatus } from "../src/pushover/config";

export async function validatePushover(fetchFn: typeof fetch = fetch, env: Record<string, string | undefined> = process.env) {
  const config = loadPushoverConfig(env);
  const local = pushoverStatus(config);
  if (!local.configured) return { valid: false, reason: "Configure the listed environment settings securely", missing: local.missing, invalid: local.invalid };
  try {
    const response = await fetchFn("https://api.pushover.net/1/users/validate.json", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(config.timeoutMs),
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: config.appToken, user: config.userKey }),
    });
    const body = await response.json() as { status?: unknown; devices?: unknown };
    if (response.status !== 200 || body?.status !== 1) return { valid: false, reason: "Pushover rejected validation; check the application token, personal User Key, and active device", httpStatus: response.status };
    return { valid: true, activeDevices: Array.isArray(body.devices) ? body.devices.length : null,
      note: "Recipient accepted by Pushover. No notification sent. Confirm this is your personal User Key, not a group key." };
  } catch { return { valid: false, reason: "Validation unavailable; no notification was sent" }; }
}

if (import.meta.main) {
  const result = await validatePushover();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.valid ? 0 : 1;
}
