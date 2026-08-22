
import { Agent } from "../core/rawAgent";
import { GeneratorGrader } from "./generatorGrader";
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
): GeneratorGrader {
  return new GeneratorGrader({
    name: "weather-generator-grader",
    client: createChatProvider(config),
    model: config.model,
    tools: [weatherTool, calculateTool],
  });
}

export const weatherAgent = createWeatherAgent();
