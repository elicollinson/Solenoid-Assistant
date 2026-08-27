import { describe, expect, test } from "bun:test";
import { loadRuntimeConfig, requireNotionDataSourceIds } from "./config";

describe("where it listens", () => {
  // Worth its own test because the cost of getting it wrong is silent. This
  // server reads messages, contacts, calendar and screenshots and authenticates
  // nobody; bound to every interface it offers all of that to whatever network
  // the laptop is on, and nothing about the running app looks any different.
  test("is this machine only, unless something says otherwise", () => {
    expect(loadRuntimeConfig({}).host).toBe("127.0.0.1");
  });

  test("and HOST is how you say otherwise, deliberately", () => {
    expect(loadRuntimeConfig({ HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });

  test("an empty HOST is not a way to say 0.0.0.0 by accident", () => {
    // A commented-out line in .env leaves the variable set and empty. That has
    // to read as "unset" rather than as "bind everything".
    expect(loadRuntimeConfig({ HOST: "" }).host).toBe("127.0.0.1");
  });
});

describe("loadRuntimeConfig", () => {
  test("applies one set of runtime defaults", () => {
    const config = loadRuntimeConfig({});
    expect(config.port).toBe(3000);
    expect(config.llmProvider).toBe("ollama");
    expect(config.model).toBe("glm-5.2");
    expect(config.imageModel).toBe("glm-5.2");
    expect(config.ollama.host).toBe("https://ollama.com");
    expect(config.structuredOutputStrategy).toBe("two-stage");
    expect(config.openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(config.openrouter.model).toBe("google/gemma-4-31b-it");
    expect(config.openrouter.apiKey).toBeUndefined();
    expect(config.promptGuard).toEqual({
      modelPath: "models/prompt-guard-2-86m",
      device: "cpu",
      threshold: 0.5,
      batchSize: 16,
      chunkOverlap: 32,
    });
    expect(config.modelRoutes).toEqual([{
      provider: "ollama",
      model: "glm-5.2",
      structuredOutputStrategy: "two-stage",
    }]);
  });

  test("normalizes blank optional values and validates the port", () => {
    expect(loadRuntimeConfig({ OLLAMA_API_KEY: "" }).ollama.apiKey).toBeUndefined();
    expect(loadRuntimeConfig({ OPENAI_API_KEY: "" }).openai.apiKey).toBeUndefined();
    expect(loadRuntimeConfig({ OPENROUTER_API_KEY: "" }).openrouter.apiKey)
      .toBeUndefined();
    expect(() => loadRuntimeConfig({ PORT: "70000" })).toThrow();
    expect(() => loadRuntimeConfig({ LLM_PROVIDER: "unknown" })).toThrow();
    expect(() => loadRuntimeConfig({ PROMPT_GUARD_THRESHOLD: "1.1" })).toThrow();
    expect(() => loadRuntimeConfig({ PROMPT_GUARD_BATCH_SIZE: "0" })).toThrow();
    expect(() => loadRuntimeConfig({ PROMPT_GUARD_DEVICE: "coreml" })).toThrow();
  });

  test("loads an ordered, non-empty model route chain", () => {
    const config = loadRuntimeConfig({
      LLM_ROUTES: JSON.stringify([
        { provider: "openai", model: "qwen/qwen3.5-9b" },
        { provider: "openrouter", model: "google/gemma-4-31b-it:free" },
      ]),
      OPENROUTER_API_KEY: "openrouter-key",
    });
    expect(config.openrouter.apiKey).toBe("openrouter-key");
    expect(config.llmProvider).toBe("openai");
    expect(config.model).toBe("qwen/qwen3.5-9b");
    expect(config.modelRoutes.map(({ provider, model }) => ({ provider, model })))
      .toEqual([
        { provider: "openai", model: "qwen/qwen3.5-9b" },
        { provider: "openrouter", model: "google/gemma-4-31b-it:free" },
      ]);
    expect(() => loadRuntimeConfig({ LLM_ROUTES: "[]" })).toThrow();
    expect(() => loadRuntimeConfig({ LLM_ROUTES: "not-json" })).toThrow(
      /valid JSON/,
    );
  });

  test("loads an OpenAI-compatible endpoint", () => {
    const config = loadRuntimeConfig({
      LLM_PROVIDER: "openai",
      OPENAI_BASE_URL: "http://192.168.0.187:1234/v1",
      OPENAI_API_KEY: "lm-studio",
      MODEL: "qwen/qwen3.5-9b",
    });
    expect(config.llmProvider).toBe("openai");
    expect(config.openai.baseUrl).toBe("http://192.168.0.187:1234/v1");
    expect(config.openai.apiKey).toBe("lm-studio");
    expect(config.model).toBe("qwen/qwen3.5-9b");
    expect(config.imageModel).toBe("qwen/qwen3.5-9b");
    expect(config.structuredOutputStrategy).toBe("native");
  });

  test("selects structured-output behavior by backend with an explicit override", () => {
    expect(
      loadRuntimeConfig({ OLLAMA_API_URL: "http://localhost:11434" })
        .structuredOutputStrategy,
    ).toBe("native");
    expect(
      loadRuntimeConfig({
        LLM_PROVIDER: "openai",
        OPENAI_BASE_URL: "http://localhost:1234/v1",
        STRUCTURED_OUTPUT_STRATEGY: "two-stage",
      }).structuredOutputStrategy,
    ).toBe("two-stage");
  });

  test("requires all Notion data source ids only when requested", () => {
    const config = loadRuntimeConfig({});
    expect(() => requireNotionDataSourceIds(config)).toThrow(/NOTION_DS_BOOKS/);
  });
});
