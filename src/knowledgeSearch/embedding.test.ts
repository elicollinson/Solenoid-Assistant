import { expect, test } from "bun:test";
import { GoogleGenAI } from "@google/genai";
import { decode, embeddingConfig, encode, googleEmbeddings, normalize, type EmbeddingConfig } from "./embedding";

const config: EmbeddingConfig = { enabled: true, project: "synthetic-project", location: "global",
  model: "gemini-embedding-2", dimensions: 768, dailyTokens: 1000 };
const values = Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0);
test("configuration is opt-in and does not reuse the voice key or Model Armor project", () => {
  expect(embeddingConfig({ GEMINI_API_KEY: "synthetic", MODEL_ARMOR_PROJECT_ID: "different-service" }))
    .toMatchObject({ enabled: false, project: undefined, model: "gemini-embedding-2", dimensions: 768 });
  expect(() => embeddingConfig({ OKF_EMBEDDING_DIMENSIONS: "42" })).toThrow();
});
test("document/query templates, truncation, retry and dimensions are explicit", async () => {
  const requests: unknown[] = [];
  const provider = googleEmbeddings(config, async request => { requests.push(request); return { embeddings: [{ values }] }; });
  await provider.embed("A fictional otter.", "document");
  await provider.embed("wildlife", "query");
  expect(requests[0]).toMatchObject({ contents: "title: OKF memory | text: A fictional otter.",
    config: { outputDimensionality: 768, autoTruncate: false, httpOptions: { retryOptions: { attempts: 1 } } } });
  expect(JSON.stringify(requests[0])).not.toContain("taskType");
  expect(requests[1]).toMatchObject({ contents: "task: search result | query: wildlife" });
  await googleEmbeddings({ ...config, model: "gemini-embedding-001" }, async request => {
    expect(request.config?.taskType).toBe("RETRIEVAL_DOCUMENT");
    return { embeddings: [{ values }] };
  }).embed("fiction", "document");
});
test("rejects malformed and truncated output; errors cannot expose submitted text", async () => {
  await expect(googleEmbeddings(config, async () => ({ embeddings: [{ values, statistics: { truncated: true } }] }))
    .embed("private text", "document")).rejects.toThrow("invalid_or_truncated_response");
  await expect(googleEmbeddings(config, async () => { throw new Error("private text and credentials"); })
    .embed("private text", "document")).rejects.toThrow("provider_unavailable");
  expect(() => normalize([NaN], 1)).toThrow();
  expect(() => normalize([0, 0], 2)).toThrow();
  expect(() => decode(new Uint8Array(3), 1)).toThrow();
  expect(decode(encode([3 / 5, 4 / 5]), 2)[0]).toBeCloseTo(0.6);
});
test("disabled provider and missing project never invoke transport", async () => {
  let called = false;
  const call = async () => { called = true; return { embeddings: [{ values }] }; };
  await expect(googleEmbeddings({ ...config, enabled: false }, call).embed("x", "query")).rejects.toThrow("disabled");
  await expect(googleEmbeddings({ ...config, project: undefined }, call).embed("x", "query")).rejects.toThrow("missing_project");
  expect(called).toBe(false);
});
test("locked SDK sends Vertex Embedding 2 embedContent wire format and decodes its response", async () => {
  // Real SDK, synthetic credentials and local transport: no Google API or paid call.
  let seen: { url: string; body: unknown } | undefined;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    seen = { url: request.url, body: await request.json() };
    return Response.json({ embedding: { values }, truncated: false, usageMetadata: { promptTokenCount: 8 } });
  } });
  try {
    const ai = new GoogleGenAI({ vertexai: true, project: config.project, location: config.location,
      googleAuthOptions: { authClient: { getRequestHeaders: async () => new Headers({ Authorization: "Bearer synthetic-test" }) } as never },
      httpOptions: { baseUrl: `http://127.0.0.1:${server.port}`, apiVersion: "v1" } });
    const provider = googleEmbeddings(config, request => ai.models.embedContent(request));
    expect(await provider.embed("Fictional otter", "document")).toEqual(values);
    expect(seen?.url).toContain("/publishers/google/models/gemini-embedding-2:embedContent");
    expect(seen?.body).toMatchObject({ content: { parts: [{ text: "title: OKF memory | text: Fictional otter" }] },
      embedContentConfig: { outputDimensionality: 768, autoTruncate: false } });
  } finally { server.stop(true); }
});
