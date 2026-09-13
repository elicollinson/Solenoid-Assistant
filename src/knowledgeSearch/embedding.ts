import { GoogleGenAI, type GoogleGenAIOptions, type EmbedContentParameters, type EmbedContentResponse } from "@google/genai";
import { GoogleCredentialsError, loadGoogleCredentials } from "../core/googleCredentials";
import { hash } from "../writeHistory/history";
export { hash };
export type EmbeddingConfig = {
  enabled: boolean;
  project?: string;
  location: string;
  model: "gemini-embedding-2" | "gemini-embedding-001";
  dimensions: number;
  dailyTokens: number;
};
export function embeddingConfig(env: Record<string, string | undefined> = process.env): EmbeddingConfig {
  const model = env.OKF_EMBEDDING_MODEL ?? "gemini-embedding-2";
  const dimensions = Number(env.OKF_EMBEDDING_DIMENSIONS ?? 768);
  const dailyTokens = Number(env.OKF_EMBEDDING_DAILY_TOKENS ?? 100_000);
  if (!["gemini-embedding-2", "gemini-embedding-001"].includes(model) ||
      ![768, 1536, 3072].includes(dimensions) || !Number.isSafeInteger(dailyTokens) || dailyTokens < 0) {
    throw new Error("Invalid OKF embedding model, dimensions, or daily token budget");
  }
  const location = env.OKF_EMBEDDING_LOCATION ?? "global";
  if (!["global", "us", "eu", "us-central1"].includes(location)) throw new Error("Invalid OKF embedding location");
  return { enabled: env.OKF_EMBEDDINGS_ENABLED === "true", model: model as EmbeddingConfig["model"], dimensions,
    dailyTokens, project: env.OKF_EMBEDDING_PROJECT || env.GOOGLE_CLOUD_PROJECT || env.MODEL_ARMOR_PROJECT_ID || env.GCP_PROJECT, location };
}
export const configId = (c: EmbeddingConfig) => hash(`vertex:${c.model}:${c.dimensions}:okf-sections-v1:retrieval-v1:f32le-unit`);
/** Conservative UTF-8 byte bound on one formatted input; autoTruncate=false is the server-side guard. */
export const maxInputBytes = (c: EmbeddingConfig) => c.model === "gemini-embedding-001" ? 1900 : 7000;
export const formatInput = (c: EmbeddingConfig, text: string, kind: "document" | "query") =>
  c.model === "gemini-embedding-2" ? (kind === "document" ? `title: OKF memory | text: ${text}` : `task: search result | query: ${text}`) : text;

export class EmbeddingError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); }
}
export interface EmbeddingProvider {
  embed(input: string, kind: "document" | "query"): Promise<number[]>;
}
export function normalize(values: readonly number[], dim: number): number[] {
  if (values.length !== dim || values.some(v => !Number.isFinite(v))) throw new EmbeddingError("invalid_vector");
  const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new EmbeddingError("invalid_vector");
  return values.map(v => v / norm);
}
export function encode(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return bytes;
}
export function decode(bytes: Uint8Array, dim: number): number[] {
  if (bytes.byteLength !== dim * 4) throw new EmbeddingError("invalid_vector");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return normalize(Array.from({ length: dim }, (_, i) => view.getFloat32(i * 4, true)), dim);
}
type EmbedCall = (request: EmbedContentParameters) => Promise<EmbedContentResponse>;
type EmbeddingClient = { models: { embedContent: EmbedCall } };
export function googleEmbeddings(config: EmbeddingConfig, call?: EmbedCall,
  createClient: (options: GoogleGenAIOptions) => EmbeddingClient = options => new GoogleGenAI(options)): EmbeddingProvider {
  // Lazy initialization: disabled/local-only reads never request credentials.
  let client: EmbeddingClient | undefined;
  return { async embed(input, kind) {
    if (!config.enabled) throw new EmbeddingError("disabled");
    if (!config.project) throw new EmbeddingError("missing_project");
    const text = formatInput(config, input, kind);
    if (Buffer.byteLength(text) > maxInputBytes(config)) throw new EmbeddingError("input_too_large");
    try {
      const request: EmbedContentParameters = { model: config.model, contents: text,
        config: { outputDimensionality: config.dimensions, autoTruncate: false,
          ...(config.model === "gemini-embedding-001" ? { taskType: kind === "document" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY" } : {}),
          httpOptions: { timeout: 15_000, retryOptions: { attempts: 1 } } } };
      if (!call && !client) {
        const credentials = loadGoogleCredentials();
        client = createClient({ vertexai: true, project: config.project, location: config.location,
          ...(credentials ? { googleAuthOptions: { credentials } } : {}),
          httpOptions: { apiVersion: "v1" } });
      }
      const response = await (call ? call(request) : client!.models.embedContent(request));
      const result = response.embeddings?.[0];
      if (response.embeddings?.length !== 1 || !result?.values || result.statistics?.truncated) {
        throw new EmbeddingError("invalid_or_truncated_response");
      }
      return normalize(result.values, config.dimensions);
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      if (error instanceof GoogleCredentialsError) throw new EmbeddingError("invalid_credentials");
      const status = Number((error as { status?: number })?.status);
      // Provider errors can contain the submitted text. Never persist/message them.
      throw new EmbeddingError(Number.isFinite(status) ? `provider_${status}` : "provider_unavailable",
        !Number.isFinite(status) || status === 429 || status >= 500);
    }
  } };
}
