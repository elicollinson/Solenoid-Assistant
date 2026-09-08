import { loadRuntimeConfig, type RuntimeConfig } from "../core/config";
import {
  ModelArmorScanner,
  type ModelArmorAssessment,
  type ModelArmorScannerOptions,
  type PromptTextParts,
} from "./modelArmorCore";

export function createModelArmorScanner(
  config: RuntimeConfig = loadRuntimeConfig(),
): ModelArmorScanner {
  return new ModelArmorScanner({
    projectId: config.modelArmor.projectId,
    location: config.modelArmor.location,
    templateId: config.modelArmor.templateId,
    apiKey: config.modelArmor.apiKey,
    apiEndpoint: config.modelArmor.apiEndpoint,
    credentialsJson: config.modelArmor.credentialsJson,
    credentialsBase64: config.modelArmor.credentialsBase64,
  });
}

let defaultScanner: ModelArmorScanner | undefined;

function getDefaultScanner(): ModelArmorScanner {
  defaultScanner ??= createModelArmorScanner();
  return defaultScanner;
}

export async function inspectPromptInjection(
  parts: PromptTextParts,
): Promise<ModelArmorAssessment> {
  return getDefaultScanner().assess(parts);
}

export async function containsPromptInjection(
  parts: PromptTextParts,
): Promise<boolean> {
  return getDefaultScanner().containsPromptInjection(parts);
}

export async function disposeModelArmor(): Promise<void> {
  const scanner = defaultScanner;
  defaultScanner = undefined;
  await scanner?.dispose();
}

export {
  ModelArmorScanner,
  type ModelArmorAssessment,
  type ModelArmorScannerOptions,
  type PromptTextParts,
};
