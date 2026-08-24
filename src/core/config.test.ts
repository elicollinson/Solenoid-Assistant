import { describe, expect, test } from "bun:test";
import { loadRuntimeConfig, requireNotionDataSourceIds } from "./config";

describe("loadRuntimeConfig", () => {
  test("applies one set of runtime defaults", () => {
    const config = loadRuntimeConfig({});
    expect(config.port).toBe(3000);
    expect(config.llmProvider).toBe("ollama");
    expect(config.model).toBe("glm-5.2");
    expect(config.imageModel).toBe("glm-5.2");
    expect(config.ollama.host).toBe("https://ollama.com");
    expect(config.structuredOutputStrategy).toBe("two-stage");
  });

  test("normalizes blank optional values and validates the port", () => {
    expect(loadRuntimeConfig({ OLLAMA_API_KEY: "" }).ollama.apiKey).toBeUndefined();
    expect(loadRuntimeConfig({ OPENAI_API_KEY: "" }).openai.apiKey).toBeUndefined();
    expect(() => loadRuntimeConfig({ PORT: "70000" })).toThrow();
    expect(() => loadRuntimeConfig({ LLM_PROVIDER: "unknown" })).toThrow();
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
