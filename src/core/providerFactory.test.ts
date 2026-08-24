import { describe, expect, test } from "bun:test";
import { loadRuntimeConfig } from "./config";
import {
  createChatProvider,
  createModelRoutes,
  createOpenAIClient,
} from "./providerFactory";

describe("providerFactory", () => {
  test("keeps Ollama as the default provider", () => {
    const provider = createChatProvider(loadRuntimeConfig({}));
    expect(provider.providerName).toBe("ollama");
    expect(provider.structuredOutputStrategy).toBe("two-stage");
  });

  test("creates an OpenAI-compatible provider for LM Studio", () => {
    const config = loadRuntimeConfig({
      LLM_PROVIDER: "openai",
      OPENAI_BASE_URL: "http://192.168.0.187:1234/v1",
    });
    expect(createChatProvider(config).providerName).toBe("openai");
    expect(createChatProvider(config).structuredOutputStrategy).toBe("native");
    expect(createOpenAIClient({}, config).baseURL).toBe("http://192.168.0.187:1234/v1");
  });

  test("reports a missing OpenAI-compatible base URL", () => {
    const config = loadRuntimeConfig({ LLM_PROVIDER: "openai" });
    expect(() => createChatProvider(config)).toThrow(/OPENAI_BASE_URL/);
  });

  test("resolves every configured model route in order", () => {
    const routes = createModelRoutes(loadRuntimeConfig({
      LLM_ROUTES: JSON.stringify([
        { provider: "openai", model: "qwen/qwen3.5-9b" },
        { provider: "openrouter", model: "google/gemma-4-31b-it" },
      ]),
      OPENAI_BASE_URL: "http://localhost:1234/v1",
      OPENROUTER_API_KEY: "test-key",
    }));
    expect(routes.map((route) => [route.client.providerName, route.model]))
      .toEqual([
        ["openai", "qwen/qwen3.5-9b"],
        ["openrouter", "google/gemma-4-31b-it"],
      ]);
  });

  test("requires credentials for every explicitly configured route", () => {
    const config = loadRuntimeConfig({
      LLM_ROUTES: JSON.stringify([
        { provider: "openrouter", model: "google/gemma-4-31b-it" },
      ]),
    });
    expect(() => createModelRoutes(config)).toThrow(/OPENROUTER_API_KEY/);
  });
});
