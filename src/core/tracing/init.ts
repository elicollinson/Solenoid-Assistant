// Tracing backend setup. This is the ONE file that knows which OTel/Phoenix
// packages are behind our tracing — swap the backend here and nothing else
// in the codebase changes (everything goes through the global tracer API).
import { register } from "@arizeai/phoenix-otel";

let provider: { shutdown(): Promise<void> } | undefined;

export function tracingEnabled(): boolean {
  return (process.env.PHOENIX_TRACING_ENABLED ?? "true") !== "false";
}

// Idempotent. When disabled, register() never runs, so trace.getTracer()
// hands out OTel's no-op tracer and every span helper silently does nothing.
export function initTracing(): void {
  if (!tracingEnabled() || provider) return;
  provider = register({
    projectName: process.env.PHOENIX_PROJECT_NAME ?? "solenoid-assistant",
    url: process.env.PHOENIX_COLLECTOR_ENDPOINT ?? "http://localhost:6006",
    batch: true,
  });
}

// Flush queued spans (batch processor) before process exit.
export async function shutdownTracing(): Promise<void> {
  await provider?.shutdown().catch(() => {});
  provider = undefined;
}
