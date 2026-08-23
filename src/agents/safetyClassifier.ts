
import { Agent } from "../core/rawAgent";
import { createChatProvider } from "../core/providerFactory";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";

export function createSafetyClassifierAgent(
  config: RuntimeConfig = loadRuntimeConfig(),
): Agent {
  return new Agent({
    name: "safety-classifier",
    client: createChatProvider(config),
    model: config.model,
  });
}

export const injectionRiskClassifier = createSafetyClassifierAgent();
