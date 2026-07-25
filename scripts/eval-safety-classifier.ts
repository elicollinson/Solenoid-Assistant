/**
 * Evaluation script for the /safetyClassifier endpoint.
 *
 * Loads the injection test set, POSTs each entry to the locally-running API,
 * compares the returned `flagged` boolean against the expected label, and
 * prints a per-case breakdown plus a final success rate.
 *
 * Usage:
 *   bun run scripts/eval-safety-classifier.ts [--maxLength=20] [--url=http://localhost:3000]
 *
 * Requires the server to be running (bun run start:server).
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- CLI args ---------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const match = args.find((a) => a.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

const API_URL = getArg("url", "http://localhost:3000");
const MAX_LENGTH = Number(getArg("maxLength", "20"));

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

// --- Main -------------------------------------------------------------------
async function main() {
  const dataPath = resolve(
    __dirname,
    "../src/data/injectionTestSet.json",
  );
  const testCases: TestCase[] = JSON.parse(readFileSync(dataPath, "utf-8"));

  console.log(`Evaluating ${testCases.length} cases against ${API_URL}/safetyClassifier`);
  console.log(`maxLength: ${MAX_LENGTH}\n`);

  const results: CaseResult[] = [];

  for (const tc of testCases) {
    const expected = tc.label === "injection";

    let res: Response;
    try {
      res = await fetch(`${API_URL}/safetyClassifier`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: tc.text,
          maxLength: MAX_LENGTH,
        }),
      });
    } catch (err) {
      console.error(`  [${tc.id}] Network error: ${err instanceof Error ? err.message : err}`);
      results.push({
        id: tc.id,
        label: tc.label,
        technique: tc.technique,
        expected,
        actual: false,
        score: -1,
        correct: false,
        concern: `NETWORK ERROR: ${err instanceof Error ? err.message : err}`,
      });
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      console.error(`  [${tc.id}] HTTP ${res.status}: ${body}`);
      results.push({
        id: tc.id,
        label: tc.label,
        technique: tc.technique,
        expected,
        actual: false,
        score: -1,
        correct: false,
        concern: `HTTP ${res.status}: ${body}`,
      });
      continue;
    }

    const data = (await res.json()) as ApiResponse;
    const actual = data.flagged;
    const correct = actual === expected;

    results.push({
      id: tc.id,
      label: tc.label,
      technique: tc.technique,
      expected,
      actual,
      score: data.score,
      correct,
      concern: data.concern,
    });

    const status = correct ? "✅" : "❌";
    console.log(
      `  [${tc.id}] ${status} expected=${expected} actual=${actual} score=${data.score.toFixed(2)} (${tc.label}${tc.technique ? `, ${tc.technique}` : ""})`,
    );
  }

  // --- Summary ---------------------------------------------------------------
  const passed = results.filter((r) => r.correct).length;
  const failed = results.filter((r) => !r.correct);
  const successRate = (passed / results.length) * 100;

  console.log("\n" + "=".repeat(60));
  console.log(`Success rate: ${passed}/${results.length} (${successRate.toFixed(1)}%)`);
  console.log("=".repeat(60));

  if (failed.length > 0) {
    console.log("\nFailed cases:");
    for (const f of failed) {
      console.log(
        `  [${f.id}] expected=${f.expected} actual=${f.actual} score=${f.score.toFixed(2)} (${f.label}${f.technique ? `, ${f.technique}` : ""})`,
      );
      console.log(`    text:     ${testCases.find((t) => t.id === f.id)?.text ?? "(missing)"}`);
      console.log(`    concern:  ${f.concern}`);
    }
  } else {
    console.log("\nAll cases passed! 🎉");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});