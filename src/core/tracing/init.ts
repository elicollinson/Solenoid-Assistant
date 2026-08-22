// Tracing backend setup. This is the ONE file that knows which OTel/Phoenix
// packages are behind our tracing — swap the backend here and nothing else
// in the codebase changes (everything goes through the global tracer API).
import { register } from "@arizeai/phoenix-otel";
import { loadRuntimeConfig, type RuntimeConfig } from "../config";

let provider: { shutdown(): Promise<void> } | undefined;

export function tracingEnabled(config: RuntimeConfig = loadRuntimeConfig()): boolean {
  return config.phoenix.enabled;
}

// Idempotent. When disabled, register() never runs, so trace.getTracer()
// hands out OTel's no-op tracer and every span helper silently does nothing.
export function initTracing(config: RuntimeConfig = loadRuntimeConfig()): void {
  if (!tracingEnabled(config) || provider) return;
  provider = register({
    projectName: config.phoenix.projectName,
    url: config.phoenix.collectorEndpoint,
    batch: true,
  });
}

// Flush queued spans (batch processor) before process exit.
export async function shutdownTracing(): Promise<void> {
  await provider?.shutdown().catch(() => {});
  provider = undefined;
}
