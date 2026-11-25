import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";
import { AssistantAgent } from "../core/engine";
import { createModelRoutes } from "../core/providerFactory";

export function createSafetyClassifierAgent(
  config: RuntimeConfig = loadRuntimeConfig(),
): AssistantAgent {
  return new AssistantAgent({
    name: "safety-classifier",
    routes: createModelRoutes(config),
    // This workflow intentionally receives prompt-injection examples so it
    // can classify them; screening here would prevent it from doing its job.
    screen: undefined,
  });
}

export const injectionRiskClassifier = createSafetyClassifierAgent();
