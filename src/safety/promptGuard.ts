import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";
import {
  PromptGuardScanner,
  type PromptGuardAssessment,
  type PromptGuardBackend,
  type PromptGuardPrediction,
  type PromptTextParts,
} from "./promptGuardCore";

const REQUIRED_MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model.onnx",
] as const;

function requireInstalledModel(modelPath: string): string {
  const absolutePath = resolve(modelPath);
  const missing = REQUIRED_MODEL_FILES.filter(
    (file) => !existsSync(resolve(absolutePath, file)),
  );
  if (missing.length > 0) {
    throw new Error(
      `Prompt Guard model is not installed at ${absolutePath}; missing ${missing.join(
        ", ",
      )}. Run: bun run setup:prompt-guard --accept-license`,
    );
  }
  return absolutePath;
}

async function loadTransformersBackend(
  config: RuntimeConfig["promptGuard"],
): Promise<PromptGuardBackend> {
  const modelPath = requireInstalledModel(config.modelPath);
  const { pipeline } = await import("@huggingface/transformers");
  const classifier = await pipeline("text-classification", modelPath, {
    device: config.device,
    dtype: "fp32",
    local_files_only: true,
    subfolder: "onnx",
    session_options: {
      graphOptimizationLevel: "all",
    },
  });

  return {
    encode: (text) => classifier.tokenizer.encode(text, {
      add_special_tokens: false,
    }),
    decode: (tokenIds) => classifier.tokenizer.decode(tokenIds, {
      skip_special_tokens: true,
      clean_up_tokenization_spaces: false,
    }),
    classify: async (texts) => {
      const output = await classifier(texts, { top_k: null });
      return output as PromptGuardPrediction[][];
    },
    dispose: () => classifier.dispose(),
  };
}

export function createPromptGuardScanner(
  config: RuntimeConfig = loadRuntimeConfig(),
): PromptGuardScanner {
  return new PromptGuardScanner(
    () => loadTransformersBackend(config.promptGuard),
    {
      threshold: config.promptGuard.threshold,
      batchSize: config.promptGuard.batchSize,
      chunkOverlap: config.promptGuard.chunkOverlap,
    },
  );
}

let defaultScanner: PromptGuardScanner | undefined;

function getDefaultScanner(): PromptGuardScanner {
  defaultScanner ??= createPromptGuardScanner();
  return defaultScanner;
}

export async function inspectPromptInjection(
  parts: PromptTextParts,
): Promise<PromptGuardAssessment> {
  return getDefaultScanner().assess(parts);
}

export async function containsPromptInjection(
  parts: PromptTextParts,
): Promise<boolean> {
  return getDefaultScanner().containsPromptInjection(parts);
}

export async function disposePromptGuard(): Promise<void> {
  const scanner = defaultScanner;
  defaultScanner = undefined;
  await scanner?.dispose();
}

export type { PromptGuardAssessment, PromptTextParts };
