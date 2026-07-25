/**
 * Evaluation script for the /safetyClassifier endpoint against the
 * NotInject benchmark dataset from HuggingFace (leolee99/NotInject).
 *
 * NotInject is a benchmark for over-defense: all 339 samples are BENIGN
 * (label: false) but contain trigger words that may be mistakenly flagged
 * as prompt injection. The correct classification for every entry is
 * `flagged: false`.
 *
 * The script fetches all rows from the HuggingFace datasets-server API
 * (3 splits × 113 rows), POSTs each entry to /safetyClassifier across
 * maxLength configs 5–8 with 1 iteration, and writes a structured JSON
 * results file with per-case details so you can see exactly which entries
 * were falsely flagged for each config.
 *
 * Usage:
 *   bun run scripts/eval-pint-benchmark.ts \
 *     --maxLengths=5,6,7,8 \
 *     --iterations=1 \
 *     [--url=http://localhost:3000] \
 *     [--output=../src/data/pint-eval-results.json]
 *
 * Requires the server to be running (bun run start:server).
 */
import { writeFileSync, mkdirSync } from "fs";
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
const MAX_LENGTHS = getArg("maxLengths", "5,6,7,8")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => !isNaN(n) && n >= 2);
const ITERATIONS = Number(getArg("iterations", "1"));
const OUTPUT_PATH = getArg("output", "../src/data/pint-eval-results.json");

// --- HuggingFace dataset config ---------------------------------------------
const HF_DATASET = "leolee99/NotInject";
const HF_SPLITS = ["NotInject_one", "NotInject_two", "NotInject_three"];
const HF_PAGE_SIZE = 100;

// --- Types ------------------------------------------------------------------
interface NotInjectEntry {
  prompt: string;
  word_list: string[];
  category: string;
}

interface DatasetEntry extends NotInjectEntry {
  /** Global index across all splits. */
  index: number;
  /** Which split this entry came from. */
  split: string;
  /** All entries are benign — label is always false. */
  label: boolean;
}

interface ApiResponse {
  flagged: boolean;
  concern: string;
  score: number;
}

/** A single test case result from one API call. */
interface CaseResult {
  index: number;
  split: string;
  text: string;
  category: string;
  wordList: string[];
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
  failedCases: CaseResult[];
}

/** Per-entry aggregate across all iterations for one config. */
interface EntryAverage {
  index: number;
  split: string;
  text: string;
  category: string;
  wordList: string[];
  averageScore: number;
  correctRate: number;
}

/** Full results for one maxLength config. */
interface ConfigResult {
  maxLength: number;
  iterations: RunResult[];
  perEntryAverages: EntryAverage[];
  configAverageScore: number;
  configSuccessRate: number;
  /** Per-category breakdown for this config. */
  categoryBreakdown: CategoryBreakdown[];
  /** Per-split breakdown for this config. */
  splitBreakdown: SplitBreakdown[];
}

interface CategoryBreakdown {
  category: string;
  total: number;
  correct: number;
  accuracy: number;
}

interface SplitBreakdown {
  split: string;
  total: number;
  correct: number;
  accuracy: number;
}

/** Top-level output document. */
interface EvalOutput {
  createdAt: string;
  apiUrl: string;
  dataset: string;
  iterationsPerConfig: number;
  totalEntries: number;
  configs: ConfigResult[];
}

// --- HuggingFace data loading -----------------------------------------------

interface HFRowResponse {
  rows: { row_idx: number; row: NotInjectEntry; truncated_cells: string[] }[];
  num_rows_total: number;
  num_rows_per_page: number;
}

/**
 * Fetch all rows for a single split from the HuggingFace datasets-server API,
 * paginating as needed.
 */
async function fetchSplit(split: string): Promise<NotInjectEntry[]> {
  const entries: NotInjectEntry[] = [];
  let offset = 0;

  while (true) {
    const url =
      `https://datasets-server.huggingface.co/rows` +
      `?dataset=${HF_DATASET}&config=default&split=${split}` +
      `&offset=${offset}&length=${HF_PAGE_SIZE}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HF API error for split ${split} offset ${offset}: HTTP ${res.status}`);
    }

    const data = (await res.json()) as HFRowResponse;
    for (const r of data.rows) {
      entries.push(r.row);
    }

    offset += data.rows.length;
    if (offset >= data.num_rows_total || data.rows.length === 0) break;
  }

  return entries;
}

/**
 * Fetch all entries from all splits, assign global indices, and return
 * a flat array of DatasetEntry objects.
 */
async function loadDataset(): Promise<DatasetEntry[]> {
  const all: DatasetEntry[] = [];
  let globalIdx = 0;

  for (const split of HF_SPLITS) {
    console.log(`  Fetching split ${split}...`);
    const entries = await fetchSplit(split);
    for (const entry of entries) {
      all.push({
        ...entry,
        index: globalIdx++,
        split,
        label: false, // all NotInject entries are benign
      });
    }
    console.log(`    ${entries.length} rows loaded`);
  }

  return all;
}

// --- Helpers ----------------------------------------------------------------

/**
 * POST a single dataset entry to the API and return a CaseResult.
 * Network/HTTP errors are recorded as incorrect results with score -1.
 */
async function evalEntry(
  entry: DatasetEntry,
  maxLength: number,
): Promise<CaseResult> {
  const expected = entry.label; // false for all NotInject entries

  let res: Response;
  try {
    res = await fetch(`${API_URL}/safetyClassifier`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: entry.prompt, maxLength }),
    });
  } catch (err) {
    return {
      index: entry.index,
      split: entry.split,
      text: entry.prompt,
      category: entry.category,
      wordList: entry.word_list,
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
      index: entry.index,
      split: entry.split,
      text: entry.prompt,
      category: entry.category,
      wordList: entry.word_list,
      expected,
      actual: false,
      score: -1,
      correct: false,
      concern: `HTTP ${res.status}: ${body}`,
    };
  }

  const data = (await res.json()) as ApiResponse;
  return {
    index: entry.index,
    split: entry.split,
    text: entry.prompt,
    category: entry.category,
    wordList: entry.word_list,
    expected,
    actual: data.flagged,
    score: data.score,
    correct: data.flagged === expected,
    concern: data.concern,
  };
}

/** Run the full dataset once for a given maxLength. */
async function runSuite(
  entries: DatasetEntry[],
  maxLength: number,
  iteration: number,
): Promise<RunResult> {
  const cases: CaseResult[] = [];

  for (const entry of entries) {
    const result = await evalEntry(entry, maxLength);
    cases.push(result);

    const status = result.correct ? "✅" : "❌";
    console.log(
      `      [${entry.index}] ${status} score=${result.score.toFixed(2)} (${entry.split}, ${entry.category})`,
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
  const failedCases = cases.filter((c) => !c.correct);

  console.log(
    `    Run ${iteration + 1} avg score=${runAverageScore.toFixed(3)} accuracy=${(runSuccessRate * 100).toFixed(1)}% (${cases.filter((c) => c.correct).length}/${cases.length} correct)`,
  );

  if (failedCases.length > 0) {
    console.log(`    Failed cases (false positives — benign but flagged):`);
    for (const f of failedCases) {
      console.log(
        `      [${f.index}] score=${f.score.toFixed(2)} (${f.split}, ${f.category}) triggers=[${f.wordList.join(", ")}]`,
      );
      console.log(`        text: ${f.text.slice(0, 120)}${f.text.length > 120 ? "..." : ""}`);
      console.log(`        concern: ${f.concern}`);
    }
  }

  return { iteration, cases, runAverageScore, runSuccessRate, failedCases };
}

/** Aggregate per-entry averages across all iterations for a config. */
function computePerEntryAverages(
  runs: RunResult[],
  entries: DatasetEntry[],
): EntryAverage[] {
  return entries.map((entry) => {
    const entryResults = runs
      .flatMap((r) => r.cases)
      .filter((c) => c.index === entry.index);
    const validScores = entryResults.filter((c) => c.score >= 0);

    const averageScore =
      validScores.length > 0
        ? validScores.reduce((sum, c) => sum + c.score, 0) / validScores.length
        : 0;
    const correctRate =
      entryResults.length > 0
        ? entryResults.filter((c) => c.correct).length / entryResults.length
        : 0;

    return {
      index: entry.index,
      split: entry.split,
      text: entry.prompt,
      category: entry.category,
      wordList: entry.word_list,
      averageScore,
      correctRate,
    };
  });
}

/** Compute per-category accuracy breakdown for a config. */
function computeCategoryBreakdown(
  runs: RunResult[],
  entries: DatasetEntry[],
): CategoryBreakdown[] {
  const allCases = runs.flatMap((r) => r.cases);
  const categories = [...new Set(entries.map((e) => e.category))];

  return categories.map((cat) => {
    const catCases = allCases.filter((c) => c.category === cat);
    const total = catCases.length;
    const correct = catCases.filter((c) => c.correct).length;
    return {
      category: cat,
      total,
      correct,
      accuracy: total > 0 ? correct / total : 0,
    };
  });
}

/** Compute per-split accuracy breakdown for a config. */
function computeSplitBreakdown(
  runs: RunResult[],
  entries: DatasetEntry[],
): SplitBreakdown[] {
  const allCases = runs.flatMap((r) => r.cases);
  const splits = [...new Set(entries.map((e) => e.split))];

  return splits.map((split) => {
    const splitCases = allCases.filter((c) => c.split === split);
    const total = splitCases.length;
    const correct = splitCases.filter((c) => c.correct).length;
    return {
      split,
      total,
      correct,
      accuracy: total > 0 ? correct / total : 0,
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

  console.log("=".repeat(70));
  console.log("NotInject Benchmark — Safety Classifier Evaluation");
  console.log("=".repeat(70));
  console.log(`API:         ${API_URL}/safetyClassifier`);
  console.log(`Dataset:     ${HF_DATASET} (HuggingFace)`);
  console.log(`maxLengths:  ${MAX_LENGTHS.join(", ")}`);
  console.log(`iterations:  ${ITERATIONS}`);
  console.log(`output:      ${resolve(__dirname, OUTPUT_PATH)}`);
  console.log("=".repeat(70) + "\n");

  // --- Load dataset from HuggingFace ---------------------------------------
  console.log("Loading dataset from HuggingFace...");
  const entries = await loadDataset();

  console.log(`\nDataset summary: ${entries.length} entries (all benign — label: false)`);
  const categories = [...new Set(entries.map((e) => e.category))];
  console.log(`Categories: ${categories.join(", ")}`);
  const splits = [...new Set(entries.map((e) => e.split))];
  console.log(`Splits: ${splits.join(", ")}\n`);

  const configs: ConfigResult[] = [];

  for (const maxLength of MAX_LENGTHS) {
    console.log(`\n── maxLength=${maxLength} ──────────────────────────────`);

    const runs: RunResult[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      console.log(`  Iteration ${i + 1}/${ITERATIONS}`);
      const run = await runSuite(entries, maxLength, i);
      runs.push(run);
    }

    const perEntryAverages = computePerEntryAverages(runs, entries);
    const categoryBreakdown = computeCategoryBreakdown(runs, entries);
    const splitBreakdown = computeSplitBreakdown(runs, entries);

    // Config-level averages across all iterations and all entries.
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
    console.log(`    accuracy rate:  ${(configSuccessRate * 100).toFixed(1)}%`);

    // Print per-split breakdown
    console.log(`\n  Per-split breakdown:`);
    for (const sb of splitBreakdown) {
      console.log(
        `    ${sb.split.padEnd(18)} ${sb.correct}/${sb.total} = ${(sb.accuracy * 100).toFixed(1)}%`,
      );
    }

    // Print per-category breakdown
    console.log(`\n  Per-category breakdown:`);
    for (const cb of categoryBreakdown) {
      console.log(
        `    ${cb.category.padEnd(22)} ${cb.correct}/${cb.total} = ${(cb.accuracy * 100).toFixed(1)}%`,
      );
    }

    // Print per-entry averages (only showing failures for brevity)
    const failedEntries = perEntryAverages.filter((e) => e.correctRate < 1.0);
    if (failedEntries.length > 0) {
      console.log(`\n  Per-entry averages (failures only):`);
      for (const e of failedEntries) {
        console.log(
          `    [${e.index}] avgScore=${e.averageScore.toFixed(3)} correctRate=${(e.correctRate * 100).toFixed(0)}% (${e.split}, ${e.category}) triggers=[${e.wordList.join(", ")}]`,
        );
        console.log(`      text: ${e.text.slice(0, 120)}${e.text.length > 120 ? "..." : ""}`);
      }
    } else {
      console.log(`\n  All entries passed! 🎉`);
    }

    configs.push({
      maxLength,
      iterations: runs,
      perEntryAverages,
      configAverageScore,
      configSuccessRate,
      categoryBreakdown,
      splitBreakdown,
    });
  }

  // --- Write output file ----------------------------------------------------
  const output: EvalOutput = {
    createdAt: new Date().toISOString(),
    apiUrl: API_URL,
    dataset: HF_DATASET,
    iterationsPerConfig: ITERATIONS,
    totalEntries: entries.length,
    configs,
  };

  const outputPath = resolve(__dirname, OUTPUT_PATH);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  // --- Final summary --------------------------------------------------------
  console.log("\n" + "=".repeat(70));
  console.log("Final Summary");
  console.log("=".repeat(70));
  console.log("maxLength | avg score | accuracy rate | false positives");
  console.log("-".repeat(70));
  for (const c of configs) {
    const totalCases = c.iterations.flatMap((r) => r.cases).length;
    const falsePositives = c.iterations.flatMap((r) => r.cases).filter((c2) => !c2.correct).length;
    console.log(
      `  ${String(c.maxLength).padStart(5)}   |  ${c.configAverageScore.toFixed(3)}   |  ${(c.configSuccessRate * 100).toFixed(1)}%${" ".repeat(7 - (c.configSuccessRate * 100).toFixed(1).length)} |  ${falsePositives}/${totalCases}`,
    );
  }
  console.log("-".repeat(70));

  // Print failed cases per config for quick reference
  console.log("\nFalse positives per config (benign entries incorrectly flagged):");
  for (const c of configs) {
    const allFailed = c.iterations.flatMap((r) => r.failedCases);
    if (allFailed.length === 0) {
      console.log(`  maxLength=${c.maxLength}: No false positives! 🎉`);
    } else {
      // Deduplicate by index
      const seen = new Set<number>();
      const unique = allFailed.filter((f) => {
        if (seen.has(f.index)) return false;
        seen.add(f.index);
        return true;
      });
      console.log(`  maxLength=${c.maxLength}: ${unique.length} unique false positives`);
      for (const f of unique) {
        console.log(
          `    [${f.index}] score=${f.score.toFixed(2)} (${f.split}, ${f.category}) triggers=[${f.wordList.join(", ")}]`,
        );
        console.log(`      text: ${f.text.slice(0, 120)}${f.text.length > 120 ? "..." : ""}`);
      }
    }
  }

  console.log(`\nResults written to: ${outputPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});