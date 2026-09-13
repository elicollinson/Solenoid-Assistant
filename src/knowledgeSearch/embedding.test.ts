import { expect, test } from "bun:test";
import { GoogleGenAI } from "@google/genai";
import { decode, embeddingConfig, encode, googleEmbeddings, normalize, type EmbeddingConfig } from "./embedding";

const config: EmbeddingConfig = { enabled: true, project: "synthetic-project", location: "global",
  model: "gemini-embedding-2", dimensions: 768, dailyTokens: 1000 };
const values = Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0);
test("configuration is opt-in and reuses the app project while preserving explicit overrides", () => {
  expect(embeddingConfig({ GEMINI_API_KEY: "synthetic", MODEL_ARMOR_PROJECT_ID: "different-service" }))
    .toMatchObject({ enabled: false, project: "different-service", model: "gemini-embedding-2", dimensions: 768 });
  expect(embeddingConfig({ OKF_EMBEDDING_PROJECT: "override", GOOGLE_CLOUD_PROJECT: "general", MODEL_ARMOR_PROJECT_ID: "armor" }).project).toBe("override");
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

const credentialKeys = ["MODEL_ARMOR_CREDENTIALS_JSON", "MODEL_ARMOR_CREDENTIALS_BASE64", "GOOGLE_APPLICATION_CREDENTIALS_JSON", "GOOGLE_APPLICATION_CREDENTIALS_BASE64"] as const;
async function withCredentials(env: Record<string, string>, run: () => Promise<void>) {
  const previous = Object.fromEntries(credentialKeys.map(key => [key, process.env[key]]));
  try {
    for (const key of credentialKeys) delete process.env[key];
    Object.assign(process.env, env);
    await run();
  } finally {
    for (const key of credentialKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("embedding client receives each supported inline credential source without reusing Model Armor routing", async () => {
  const credentials = { type: "service_account", client_email: "synthetic@example.invalid", private_key: "synthetic-secret" };
  for (const key of credentialKeys) await withCredentials({ [key]: key.endsWith("BASE64") ? Buffer.from(JSON.stringify(credentials)).toString("base64") : JSON.stringify(credentials) }, async () => {
    let created = 0;
    const provider = googleEmbeddings(config, undefined, options => {
      created++;
      expect(options).toMatchObject({ vertexai: true, project: "synthetic-project", location: "global", googleAuthOptions: { credentials } });
      return { models: { embedContent: async () => ({ embeddings: [{ values }] }) } };
    });
    expect(created).toBe(0);
    await provider.embed("fictional document", "document");
    await provider.embed("fictional query", "query");
    expect(created).toBe(1);
  });
});

test("embedding ADC path omits explicit credentials and disabled calls never parse malformed inline credentials", async () => {
  await withCredentials({}, async () => {
    await googleEmbeddings(config, undefined, options => {
      expect(options.googleAuthOptions).toBeUndefined();
      return { models: { embedContent: async () => ({ embeddings: [{ values }] }) } };
    }).embed("fiction", "document");
  });
  await withCredentials({ MODEL_ARMOR_CREDENTIALS_JSON: "synthetic-secret{" }, async () => {
    const factory = () => { throw new Error("must not construct client"); };
    const disabled = googleEmbeddings({ ...config, enabled: false }, undefined, factory);
    await expect(disabled.embed("fiction", "query")).rejects.toThrow("disabled");
    await expect(googleEmbeddings({ ...config, project: undefined }, undefined, factory).embed("fiction", "query")).rejects.toThrow("missing_project");
    try { await googleEmbeddings(config, undefined, factory).embed("fiction", "query"); }
    catch (error) {
      expect(error).toMatchObject({ code: "invalid_credentials", retryable: false });
      expect(String(error)).not.toContain("synthetic-secret");
      return;
    }
    throw new Error("malformed credentials unexpectedly accepted");
  });
});
