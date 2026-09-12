/** Optional configuration: absence or mistakes must not break internal reminders. */
export interface PushoverConfig {
  enabled: boolean;
  remindersEnabled: boolean;
  appToken: string;
  userKey: string;
  timeoutMs: number;
  invalid: string[];
}

export function loadPushoverConfig(env: Record<string, string | undefined> = process.env): PushoverConfig {
  const invalid: string[] = [];
  for (const name of ["PUSHOVER_ENABLED", "PUSHOVER_REMINDERS_ENABLED"]) {
    if (env[name]?.trim() && !["true", "false"].includes(env[name]!.trim())) invalid.push(name);
  }
  const appToken = env.PUSHOVER_APP_TOKEN?.trim() ?? "";
  const userKey = env.PUSHOVER_USER_KEY?.trim() ?? "";
  for (const [name, value] of [["PUSHOVER_APP_TOKEN", appToken], ["PUSHOVER_USER_KEY", userKey]]) {
    if (value && !/^[A-Za-z0-9]{30}$/.test(value)) invalid.push(name!);
  }
  const timeoutMs = Number(env.PUSHOVER_TIMEOUT_MS?.trim() || 10000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) invalid.push("PUSHOVER_TIMEOUT_MS");
  return { enabled: env.PUSHOVER_ENABLED?.trim() === "true", remindersEnabled: env.PUSHOVER_REMINDERS_ENABLED?.trim() === "true",
    appToken, userKey, timeoutMs, invalid };
}

export function pushoverStatus(config = loadPushoverConfig()) {
  const missing = [!config.appToken && "PUSHOVER_APP_TOKEN", !config.userKey && "PUSHOVER_USER_KEY"].filter(Boolean) as string[];
  const configured = !missing.length && !config.invalid.length;
  return { enabled: config.enabled, configured, ready: config.enabled && configured,
    remindersEnabled: config.remindersEnabled, remindersReady: config.enabled && configured && config.remindersEnabled,
    reason: !config.enabled ? "disabled" : config.invalid.length ? "invalid_configuration" : missing.length ? "missing_configuration" : "ready",
    missing, invalid: config.invalid, recipient: "configured personal account", target: "all active devices", networkValidated: false };
}
