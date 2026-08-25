
import { Agent } from "../core/rawAgent";
import { createModelRoutes } from "../core/providerFactory";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";

export function createSafetyClassifierAgent(
  config: RuntimeConfig = loadRuntimeConfig(),
): Agent {
  return new Agent({
    name: "safety-classifier",
    routes: createModelRoutes(config),
    // This workflow intentionally receives prompt-injection examples so it
    // can classify them; screening here would prevent it from doing its job.
    promptInjectionScreening: false,
  });
}

export const injectionRiskClassifier = createSafetyClassifierAgent();
