
import { Agent } from "../core/rawAgent";
import { createOllamaClient } from "../core/ollama";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";

export function createSafetyClassifierAgent(
  config: RuntimeConfig = loadRuntimeConfig(),
): Agent {
  return new Agent({
    name: "safety-classifier",
    client: createOllamaClient({}, config),
    model: config.model,
  });
}

export const injectionRiskClassifier = createSafetyClassifierAgent();
