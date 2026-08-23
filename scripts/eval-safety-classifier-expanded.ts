/**
 * Expanded evaluation script for the /safetyClassifier endpoint.
 *
 * Runs the full injection test suite across a range of `maxLength` configs,
 * repeating each config for a given number of iterations. Produces a JSON
 * data file with per-entry scores, per-run averages, per-question averages
 * across iterations, and per-config overall averages.
 *
 * Usage:
 *   bun run scripts/eval-safety-classifier-expanded.ts \
 *     --maxLengths=5,10,15,20 \
 *     --iterations=3 \
 *     [--url=http://localhost:3000] \
 *     [--output=../artifacts/evals/safety-classifier.json]
 *
 * Requires the server to be running (bun run start:server).
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getOption } from "./lib/cli";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- CLI args ---------------------------------------------------------------
const args = process.argv.slice(2);
const API_URL = getOption(args, "url", "http://localhost:3000");
const MAX_LENGTHS = getOption(args, "maxLengths", "10,20,30")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => !isNaN(n) && n >= 2);
const ITERATIONS = Number(getOption(args, "iterations", "1"));
const OUTPUT_PATH = getOption(args, "output", "../artifacts/evals/safety-classifier.json");

// --- Types ------------------------------------------------------------------
interface TestCase {
  id: number;
  text: string;
  label: "injection" | "benign";
  technique: string | null;
}

interface ApiResponse {
  flagged: boolean;
  concern: string;
  score: number;
}

/** A single test case result from one API call. */
interface CaseResult {
  id: number;
  label: string;
  technique: string | null;
  expected: boolean;
  actual: boolean;
  score: number;
  correct: boolean;
  concern: string;
}

/** All case results from one full-suite run. */
interface RunResult {
  iteration: number;
  cases: CaseResult[];
  runAverageScore: number;
  runSuccessRate: number;
}

/** Per-question aggregate across all iterations for one config. */
interface QuestionAverage {
  id: number;
  label: string;
  technique: string | null;
  averageScore: number;
  correctRate: number;
}

/** Full results for one maxLength config. */
interface ConfigResult {
  maxLength: number;
  iterations: RunResult[];
  perQuestionAverages: QuestionAverage[];
  configAverageScore: number;
  configSuccessRate: number;
}

/** Top-level output document. */
interface EvalOutput {
  createdAt: string;
  apiUrl: string;
  iterationsPerConfig: number;
  configs: ConfigResult[];
}

// --- Helpers ----------------------------------------------------------------

/**
 * POST a single test case to the API and return a CaseResult.
 * Network/HTTP errors are recorded as incorrect results with score -1.
 */
async function evalCase(
  tc: TestCase,
  maxLength: number,
): Promise<CaseResult> {
  const expected = tc.label === "injection";

  let res: Response;
  try {
    res = await fetch(`${API_URL}/safety-classifier`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: tc.text, maxLength }),
    });
  } catch (err) {
    return {
      id: tc.id,
      label: tc.label,
      technique: tc.technique,
      expected,
      actual: false,
      score: -1,
      correct: false,
      concern: `NETWORK ERROR: ${err instanceof Error ? err.message : err}`,
    };
  }

  if (!res.ok) {
    const body = await res.text();
    return {
      id: tc.id,
      label: tc.label,
      technique: tc.technique,
      expected,
      actual: false,
      score: -1,
      correct: false,
      concern: `HTTP ${res.status}: ${body}`,
    };
  }

  const data = (await res.json()) as ApiResponse;
  return {
    id: tc.id,
    label: tc.label,
    technique: tc.technique,
    expected,
    actual: data.flagged,
    score: data.score,
    correct: data.flagged === expected,
    concern: data.concern,
  };
}

/** Run the full test suite once for a given maxLength. */
async function runSuite(
  testCases: TestCase[],
  maxLength: number,
  iteration: number,
): Promise<RunResult> {
  const cases: CaseResult[] = [];

  for (const tc of testCases) {
    const result = await evalCase(tc, maxLength);
    cases.push(result);

    const status = result.correct ? "✅" : "❌";
    console.log(
      `      [${tc.id}] ${status} score=${result.score.toFixed(2)} (${tc.label}${tc.technique ? `, ${tc.technique}` : ""})`,
    );
  }

  const validScores = cases.filter((c) => c.score >= 0);
  const runAverageScore =
    validScores.length > 0
      ? validScores.reduce((sum, c) => sum + c.score, 0) / validScores.length
      : 0;
  const runSuccessRate =
    cases.length > 0
      ? cases.filter((c) => c.correct).length / cases.length
      : 0;

  console.log(
    `    Run ${iteration + 1} avg score=${runAverageScore.toFixed(3)} success=${(runSuccessRate * 100).toFixed(1)}%`,
  );

  return { iteration, cases, runAverageScore, runSuccessRate };
}

/** Aggregate per-question averages across all iterations for a config. */
function computePerQuestionAverages(
  runs: RunResult[],
  testCases: TestCase[],
): QuestionAverage[] {
  return testCases.map((tc) => {
    const entries = runs
      .flatMap((r) => r.cases)
      .filter((c) => c.id === tc.id && c.score >= 0);

    const averageScore =
      entries.length > 0
        ? entries.reduce((sum, c) => sum + c.score, 0) / entries.length
        : 0;
    const correctRate =
      entries.length > 0
        ? entries.filter((c) => c.correct).length / entries.length
        : 0;

    return {
      id: tc.id,
      label: tc.label,
      technique: tc.technique,
      averageScore,
      correctRate,
    };
  });
}

// --- Main -------------------------------------------------------------------
async function main() {
  if (MAX_LENGTHS.length === 0) {
    console.error("No valid maxLength values provided (must be >= 2).");
    process.exit(1);
  }
  if (ITERATIONS < 1) {
    console.error("iterations must be at least 1.");
    process.exit(1);
  }

  const dataPath = resolve(__dirname, "../src/data/injectionTestSet.json");
  const testCases: TestCase[] = JSON.parse(readFileSync(dataPath, "utf-8"));

  console.log("=".repeat(70));
  console.log("Expanded Safety Classifier Evaluation");
  console.log("=".repeat(70));
  console.log(`API:         ${API_URL}/safetyClassifier`);
  console.log(`maxLengths:  ${MAX_LENGTHS.join(", ")}`);
  console.log(`iterations:  ${ITERATIONS}`);
  console.log(`test cases:  ${testCases.length}`);
  console.log(`output:      ${resolve(__dirname, OUTPUT_PATH)}`);
  console.log("=".repeat(70) + "\n");

  const configs: ConfigResult[] = [];

  for (const maxLength of MAX_LENGTHS) {
    console.log(`\n── maxLength=${maxLength} ──────────────────────────────`);

    const runs: RunResult[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      console.log(`  Iteration ${i + 1}/${ITERATIONS}`);
      const run = await runSuite(testCases, maxLength, i);
      runs.push(run);
    }

    const perQuestionAverages = computePerQuestionAverages(runs, testCases);

    // Config-level averages across all iterations and all questions.
    const allValidScores = runs
      .flatMap((r) => r.cases)
      .filter((c) => c.score >= 0);
    const configAverageScore =
      allValidScores.length > 0
        ? allValidScores.reduce((sum, c) => sum + c.score, 0) /
          allValidScores.length
        : 0;
    const allCases = runs.flatMap((r) => r.cases);
    const configSuccessRate =
      allCases.length > 0
        ? allCases.filter((c) => c.correct).length / allCases.length
        : 0;

    console.log(`\n  Config summary (maxLength=${maxLength}):`);
    console.log(`    average score:  ${configAverageScore.toFixed(3)}`);
    console.log(`    success rate:   ${(configSuccessRate * 100).toFixed(1)}%`);

    // Print per-question averages for this config.
    console.log(`\n  Per-question averages:`);
    for (const q of perQuestionAverages) {
      console.log(
        `    [${q.id}] avgScore=${q.averageScore.toFixed(3)} correctRate=${(q.correctRate * 100).toFixed(0)}% (${q.label}${q.technique ? `, ${q.technique}` : ""})`,
      );
    }

    configs.push({
      maxLength,
      iterations: runs,
      perQuestionAverages,
      configAverageScore,
      configSuccessRate,
    });
  }

  // --- Write output file ----------------------------------------------------
  const output: EvalOutput = {
    createdAt: new Date().toISOString(),
    apiUrl: API_URL,
    iterationsPerConfig: ITERATIONS,
    configs,
  };

  const outputPath = resolve(__dirname, OUTPUT_PATH);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  // --- Final summary --------------------------------------------------------
  console.log("\n" + "=".repeat(70));
  console.log("Final Summary");
  console.log("=".repeat(70));
  console.log(
    "maxLength | avg score | success rate",
  );
  console.log("-".repeat(70));
  for (const c of configs) {
    console.log(
      `  ${String(c.maxLength).padStart(5)}   |  ${c.configAverageScore.toFixed(3)}   |  ${(c.configSuccessRate * 100).toFixed(1)}%`,
    );
  }
  console.log("-".repeat(70));
  console.log(`\nResults written to: ${outputPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
