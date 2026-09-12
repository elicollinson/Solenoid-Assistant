import { z } from "zod";

const integer = (fallback: number, max: number) => z.coerce.number().int().min(1).max(max).default(fallback);
const schema = z.object({
  enabled: z.boolean(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  token: z.string(),
  lookbackMinutes: integer(60, 10080),
  overlapMinutes: integer(5, 1440),
  lagSeconds: integer(60, 3600),
  maxRows: integer(50000, 500000),
  maxGroups: integer(300, 2000),
  expectedServices: z.array(z.string()),
});
export type MonitorConfig = z.infer<typeof schema>;
export function loadMonitorConfig(env = process.env): MonitorConfig {
  return schema.parse({
    enabled: env.LOG_MONITOR_ENABLED !== "false",
    repository: env.LOG_MONITOR_GITHUB_REPOSITORY || "elicollinson/Solenoid-Assistant",
    token: env.LOG_MONITOR_GITHUB_TOKEN || "",
    lookbackMinutes: env.LOG_MONITOR_LOOKBACK_MINUTES || undefined,
    overlapMinutes: env.LOG_MONITOR_OVERLAP_MINUTES || undefined,
    lagSeconds: env.LOG_MONITOR_LAG_SECONDS || undefined,
    maxRows: env.LOG_MONITOR_MAX_ROWS || undefined,
    maxGroups: env.LOG_MONITOR_MAX_GROUPS || undefined,
    expectedServices: (env.LOG_MONITOR_EXPECTED_SERVICES || "").split(",").map(s => s.trim()).filter(Boolean),
  });
}
