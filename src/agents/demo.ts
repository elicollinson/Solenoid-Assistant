
import { Agent } from "../core/rawAgent";
import { createGraderReviewer } from "./graderReviewer";
import { weatherTool, calculateTool } from "../tools/demo";
import { createModelRoutes } from "../core/providerFactory";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";

export function createDemoAgent(config: RuntimeConfig = loadRuntimeConfig()): Agent {
  return new Agent({
    name: "demo-agent",
    routes: createModelRoutes(config),
    tools: [weatherTool, calculateTool],
  });
}

export function createWeatherAgent(
  config: RuntimeConfig = loadRuntimeConfig(),
): Agent {
  const routes = createModelRoutes(config);
  const primary = routes[0];
  return new Agent({
    name: "weather-generator-grader",
    routes,
    tools: [weatherTool, calculateTool],
    reviewers: [createGraderReviewer({
      client: primary.client,
      model: primary.model,
    })],
  });
}

export const weatherAgent = createWeatherAgent();
