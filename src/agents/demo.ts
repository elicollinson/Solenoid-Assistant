
import { Agent } from "../core/rawAgent";
import { createGraderReviewer } from "./graderReviewer";
import { weatherTool, calculateTool } from "../tools/demo";
import { createChatProvider } from "../core/providerFactory";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";

export function createDemoAgent(config: RuntimeConfig = loadRuntimeConfig()): Agent {
  return new Agent({
    name: "demo-agent",
    client: createChatProvider(config),
    model: config.model,
    tools: [weatherTool, calculateTool],
  });
}

export function createWeatherAgent(
  config: RuntimeConfig = loadRuntimeConfig(),
): Agent {
  const client = createChatProvider(config);
  return new Agent({
    name: "weather-generator-grader",
    client,
    model: config.model,
    tools: [weatherTool, calculateTool],
    reviewers: [createGraderReviewer({ client, model: config.model })],
  });
}

export const weatherAgent = createWeatherAgent();
