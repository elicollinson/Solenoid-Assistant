export const PROMPT_GUARD_MAX_TOKENS = 512;
const PROMPT_GUARD_SPECIAL_TOKENS = 2;

export type PromptTextParts = readonly [string, ...string[]];

export interface PromptGuardPrediction {
  label: string;
  score: number;
}

export interface PromptGuardBackend {
  encode(text: string): number[];
  decode(tokenIds: number[]): string;
  classify(texts: string[]): Promise<PromptGuardPrediction[][]>;
  dispose(): Promise<void>;
}

export interface PromptGuardAssessment {
  flagged: boolean;
  label: "BENIGN" | "MALICIOUS";
  score: number;
  chunkCount: number;
  maliciousChunkIndex: number | null;
}

export interface PromptGuardScannerOptions {
  threshold?: number;
  batchSize?: number;
  chunkOverlap?: number;
  maxTokens?: number;
}

interface ResolvedPromptGuardScannerOptions {
  threshold: number;
  batchSize: number;
  chunkOverlap: number;
  maxTokens: number;
}

const EMPTY_ASSESSMENT: PromptGuardAssessment = {
  flagged: false,
  label: "BENIGN",
  score: 0,
  chunkCount: 0,
  maliciousChunkIndex: null,
};

function resolveOptions(
  options: PromptGuardScannerOptions,
): ResolvedPromptGuardScannerOptions {
  const resolved = {
    threshold: options.threshold ?? 0.5,
    batchSize: options.batchSize ?? 16,
    chunkOverlap: options.chunkOverlap ?? 32,
    maxTokens: options.maxTokens ?? PROMPT_GUARD_MAX_TOKENS,
  };
  const contentTokens = resolved.maxTokens - PROMPT_GUARD_SPECIAL_TOKENS;

  if (resolved.threshold < 0 || resolved.threshold > 1) {
    throw new RangeError("Prompt Guard threshold must be between 0 and 1");
  }
  if (!Number.isInteger(resolved.batchSize) || resolved.batchSize < 1) {
    throw new RangeError("Prompt Guard batch size must be a positive integer");
  }
  if (!Number.isInteger(resolved.maxTokens) || resolved.maxTokens < 3) {
    throw new RangeError("Prompt Guard maxTokens must be an integer of at least 3");
  }
  if (
    !Number.isInteger(resolved.chunkOverlap) ||
    resolved.chunkOverlap < 0 ||
    resolved.chunkOverlap >= contentTokens
  ) {
    throw new RangeError(
      `Prompt Guard chunk overlap must be between 0 and ${contentTokens - 1}`,
    );
  }

  return resolved;
}

function combineParts(parts: readonly string[]): string {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new TypeError("Prompt Guard input must contain at least one string");
  }
  for (const part of parts) {
    if (typeof part !== "string") {
      throw new TypeError("Every Prompt Guard input part must be a string");
    }
  }
  return parts.join("\n");
}

function createChunks(
  tokenIds: number[],
  backend: PromptGuardBackend,
  options: ResolvedPromptGuardScannerOptions,
): string[] {
  const contentTokens = options.maxTokens - PROMPT_GUARD_SPECIAL_TOKENS;
  const step = contentTokens - options.chunkOverlap;
  const chunks: string[] = [];

  for (let start = 0; start < tokenIds.length; start += step) {
    const ids = tokenIds.slice(start, start + contentTokens);
    if (ids.length === 0) break;
    chunks.push(backend.decode(ids));
    if (start + contentTokens >= tokenIds.length) break;
  }

  return chunks;
}

function maliciousScore(predictions: PromptGuardPrediction[]): number {
  const prediction = predictions.find(({ label }) => {
    const normalized = label.trim().toUpperCase();
    return normalized === "MALICIOUS" || normalized === "LABEL_1";
  });
  if (!prediction || !Number.isFinite(prediction.score)) {
    throw new Error(
      "Prompt Guard output did not contain a finite MALICIOUS/LABEL_1 score",
    );
  }
  return prediction.score;
}

async function assessText(
  text: string,
  backend: PromptGuardBackend,
  options: ResolvedPromptGuardScannerOptions,
): Promise<PromptGuardAssessment> {
  const tokenIds = backend.encode(text);
  if (tokenIds.length === 0) return { ...EMPTY_ASSESSMENT };

  const chunks = createChunks(tokenIds, backend, options);
  let highestScore = -Infinity;
  let highestChunkIndex: number | null = null;

  for (let start = 0; start < chunks.length; start += options.batchSize) {
    const batch = chunks.slice(start, start + options.batchSize);
    const predictions = await backend.classify(batch);
    if (predictions.length !== batch.length) {
      throw new Error(
        `Prompt Guard returned ${predictions.length} results for ${batch.length} chunks`,
      );
    }

    predictions.forEach((chunkPredictions, index) => {
      const score = maliciousScore(chunkPredictions);
      if (score > highestScore) {
        highestScore = score;
        highestChunkIndex = start + index;
      }
    });
  }

  const flagged = highestScore >= options.threshold;
  return {
    flagged,
    label: flagged ? "MALICIOUS" : "BENIGN",
    score: highestScore,
    chunkCount: chunks.length,
    maliciousChunkIndex: highestChunkIndex,
  };
}

export class PromptGuardScanner {
  private backendPromise: Promise<PromptGuardBackend> | undefined;
  private readonly options: ResolvedPromptGuardScannerOptions;

  constructor(
    private readonly loadBackend: () => Promise<PromptGuardBackend>,
    options: PromptGuardScannerOptions = {},
  ) {
    this.options = resolveOptions(options);
  }

  private getBackend(): Promise<PromptGuardBackend> {
    if (!this.backendPromise) {
      this.backendPromise = this.loadBackend().catch((error) => {
        this.backendPromise = undefined;
        throw error;
      });
    }
    return this.backendPromise;
  }

  async assess(parts: PromptTextParts): Promise<PromptGuardAssessment> {
    const text = combineParts(parts);
    if (text.length === 0) return { ...EMPTY_ASSESSMENT };
    return assessText(text, await this.getBackend(), this.options);
  }

  async containsPromptInjection(parts: PromptTextParts): Promise<boolean> {
    return (await this.assess(parts)).flagged;
  }

  async dispose(): Promise<void> {
    const pending = this.backendPromise;
    this.backendPromise = undefined;
    if (!pending) return;
    const backend = await pending.catch(() => undefined);
    await backend?.dispose();
  }
}
