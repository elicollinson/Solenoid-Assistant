
import { Agent } from "../core/rawAgent";
import { createModelRoutes } from "../core/providerFactory";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";

export function createSafetyClassifierAgent(
  config: RuntimeConfig = loadRuntimeConfig(),
): Agent {
  return new Agent({
    name: "safety-classifier",
    routes: createModelRoutes(config),
  });
}

export const injectionRiskClassifier = createSafetyClassifierAgent();
