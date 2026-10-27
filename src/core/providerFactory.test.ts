import { describe, expect, test } from "bun:test";
import { loadRuntimeConfig } from "./config";
import {
  createChatProvider,
  createModelRoutes,
  createOpenAIClient,
  withModelTtl,
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

  describe("LM Studio's idle unload", () => {
    const sent: unknown[] = [];
    const capture = (async (_input: unknown, init?: RequestInit) => {
      sent.push(typeof init?.body === "string" ? JSON.parse(init.body) : init?.body);
      return new Response("{}");
    }) as unknown as typeof fetch;

    test("asks for one on every request that names a model", async () => {
      sent.length = 0;
      await withModelTtl(900, capture)("http://x/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "google/gemma-4-26b-a4b-qat", messages: [] }),
      });
      expect(sent[0]).toEqual({ model: "google/gemma-4-26b-a4b-qat", messages: [], ttl: 900 });
    });

    test("leaves bodies without a model, and a caller's own ttl, alone", async () => {
      sent.length = 0;
      const ttl = withModelTtl(900, capture);
      await ttl("http://x/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m", ttl: 60 }) });
      await ttl("http://x/v1/embeddings", { method: "POST", body: JSON.stringify({ input: "a" }) });
      await ttl("http://x/v1/models");
      expect(sent).toEqual([{ model: "m", ttl: 60 }, { input: "a" }, undefined]);
    });

    test("defaults to fifteen minutes, and 0 turns it off", () => {
      const base = { LLM_PROVIDER: "openai", OPENAI_BASE_URL: "http://localhost:1234/v1" };
      expect(loadRuntimeConfig(base).openai.modelTtlSeconds).toBe(900);
      expect(loadRuntimeConfig({ ...base, OPENAI_MODEL_TTL_SECONDS: "0" }).openai.modelTtlSeconds).toBe(0);
    });
  });
});
