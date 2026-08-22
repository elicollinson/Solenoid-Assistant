import { Ollama } from "ollama";
import { loadRuntimeConfig, type RuntimeConfig } from "./config";

export interface OllamaClientOptions {
  host?: string;
  apiKey?: string;
}

export function createOllamaClient(
  options: OllamaClientOptions = {},
  config: RuntimeConfig = loadRuntimeConfig(),
): Ollama {
  const host = options.host ?? config.ollama.host;
  const apiKey = options.apiKey ?? config.ollama.apiKey;
  return new Ollama({
    host,
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
  });
}
