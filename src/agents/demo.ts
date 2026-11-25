import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";
import { AssistantAgent } from "../core/engine";
import { createModelRoutes } from "../core/providerFactory";
import { createSecurityScreener } from "../safety/modelArmor";
import { calculateTool, weatherTool } from "../tools/demo";
import { createGraderReviewer } from "./graderReviewer";

export function createDemoAgent(
  config: RuntimeConfig = loadRuntimeConfig(),
): AssistantAgent {
  return new AssistantAgent({
    name: "demo-agent",
    routes: createModelRoutes(config),
    tools: [weatherTool, calculateTool],
    screen: createSecurityScreener(config),
  });
}

export function createWeatherAgent(
  config: RuntimeConfig = loadRuntimeConfig(),
): AssistantAgent {
  const routes = createModelRoutes(config);
  const primary = routes[0];
  return new AssistantAgent({
    name: "weather-generator-grader",
    routes,
    tools: [weatherTool, calculateTool],
    screen: createSecurityScreener(config),
    reviewers: [
      createGraderReviewer({
        client: primary.client,
        model: primary.model,
      }),
    ],
  });
}

export const weatherAgent = createWeatherAgent();
