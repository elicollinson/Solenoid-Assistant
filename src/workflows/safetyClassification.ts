import type { Agent } from "../core/rawAgent";
import { log } from "../core/logger";
import { injectionRiskClassifier } from "../agents/safetyClassifier";
import { injectionRiskPrompt, injectionRiskSchema } from "../prompts";
import { chunkWords } from "../utils/chunkWords";
import { fanout, fulfilled, rejected } from "../utils/fanout";

const INJECTION_FLAG_THRESHOLD = 0.5;

export interface SafetyClassificationResult {
  flagged: boolean;
  concern: string;
  score: number;
}

export async function classifySafety(
  input: string,
  maxLength: number,
  agent: Agent = injectionRiskClassifier,
): Promise<SafetyClassificationResult> {
  const chunks = chunkWords(input, maxLength);
  const evaluations = await fanout(
    chunks.map((text) => ({ text })),
    agent,
    injectionRiskPrompt,
    injectionRiskSchema,
    8,
  );

  const scored = fulfilled(evaluations);
  const failures = rejected(evaluations);
  if (failures.length > 0) {
    log.warn(
      `safetyClassifier: ${failures.length}/${evaluations.length} chunk classifications failed; ` +
        `scoring on the remainder. First error: ${failures[0]?.message}`,
    );
  }
  if (scored.length === 0) {
    throw new Error(
      `All ${evaluations.length} chunk classifications failed: ` +
        `${failures[0]?.message ?? "unknown error"}`,
    );
  }

  const highestConfidence = scored.reduce((best, evaluation) =>
    evaluation.concernScore > best.concernScore ? evaluation : best,
  );

  return {
    flagged: highestConfidence.concernScore > INJECTION_FLAG_THRESHOLD,
    concern: highestConfidence.rationale,
    score: highestConfidence.concernScore,
  };
}
