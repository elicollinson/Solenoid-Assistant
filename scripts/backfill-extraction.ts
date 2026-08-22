// Backfill message extraction over a date range, one 24-hour window at a time.
//
// Walks consecutive 24h windows from <start> until --end (default: now), calling
// GET /messageExtraction?start=&end= for each. Windows run sequentially on
// purpose: each call drives the full agent pipeline (intake → grader fanout →
// OKF update), and the OKF store takes one writer at a time.
//
// Usage:
//   bun run scripts/backfill-extraction.ts <start> [--end <date>] [--url <base>] [--out <file>]
//
//   <start>       Any parseable date/time, e.g. 2026-07-20 or 2026-07-20T09:00:00Z
//   --end <date>  Stop boundary (default: now); the final window is clamped to it
//   --url <base>  Server base URL (default: http://localhost:3000)
//   --out <file>  Also write the full per-window results as JSON
//
// A failed window is logged and skipped — the rest of the backfill continues,
// and the failures are listed at the end with ready-to-run retry commands.

const HOUR_MS = 3600_000;
const WINDOW_MS = 24 * HOUR_MS;
// Each window runs multiple model calls end to end; give it room.
const REQUEST_TIMEOUT_MS = 20 * 60_000;

interface ExtractionResponse {
  actionItems: string[];
  conversationSummaries: string[];
  memoryContext: string[];
  okfUpdate: unknown;
}

interface WindowResult {
  start: string;
  end: string;
  ok: boolean;
  error?: string;
  result?: ExtractionResponse;
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    "usage: bun run scripts/backfill-extraction.ts <start> [--end <date>] [--url <base>] [--out <file>]",
  );
  process.exit(message ? 1 : 0);
}

function parseArgs(argv: string[]) {
  let start: string | undefined;
  let end: string | undefined;
  let url = "http://localhost:3000";
  let out: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") usage();
    else if (arg === "--end") end = argv[++i] ?? usage("--end requires a value");
    else if (arg === "--url") url = argv[++i] ?? usage("--url requires a value");
    else if (arg === "--out") out = argv[++i] ?? usage("--out requires a value");
    else if (arg.startsWith("--")) usage(`unknown flag ${arg}`);
    else if (start === undefined) start = arg;
    else usage(`unexpected argument ${arg}`);
  }

  if (!start) usage("missing <start>");
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) usage(`"${start}" is not a parseable date/time`);
  const endDate = end ? new Date(end) : new Date();
  if (Number.isNaN(endDate.getTime())) usage(`"${end}" is not a parseable date/time`);
  if (startDate >= endDate) {
    usage(`start (${startDate.toISOString()}) must be before end (${endDate.toISOString()})`);
  }
  return { startDate, endDate, url: url.replace(/\/$/, ""), out };
}

async function extractWindow(base: string, start: Date, end: Date): Promise<WindowResult> {
  const window = { start: start.toISOString(), end: end.toISOString() };
  const qs = new URLSearchParams(window).toString();
  try {
    const res = await fetch(`${base}/message-extraction?${qs}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json()) as ExtractionResponse & { error?: string };
    if (!res.ok || body.error) {
      return { ...window, ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    return { ...window, ok: true, result: body };
  } catch (err) {
    return { ...window, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const { startDate, endDate, url, out } = parseArgs(process.argv.slice(2));

const totalWindows = Math.ceil((endDate.getTime() - startDate.getTime()) / WINDOW_MS);
console.log(
  `Backfilling ${startDate.toISOString()} → ${endDate.toISOString()} ` +
    `(${totalWindows} window(s) of 24h) via ${url}`,
);

const results: WindowResult[] = [];
for (let i = 0; i < totalWindows; i++) {
  const winStart = new Date(startDate.getTime() + i * WINDOW_MS);
  // Clamp the last window so the backfill never reads past the stop boundary.
  const winEnd = new Date(Math.min(winStart.getTime() + WINDOW_MS, endDate.getTime()));

  process.stdout.write(
    `[${i + 1}/${totalWindows}] ${winStart.toISOString()} → ${winEnd.toISOString()} ... `,
  );
  const started = Date.now();
  const r = await extractWindow(url, winStart, winEnd);
  results.push(r);

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  if (r.ok && r.result) {
    console.log(
      `ok in ${secs}s — ${r.result.actionItems.length} action item(s), ` +
        `${r.result.conversationSummaries.length} conversation(s), ` +
        `${r.result.memoryContext.length} memory(ies)`,
    );
  } else {
    console.log(`FAILED in ${secs}s — ${r.error}`);
  }
}

const failed = results.filter((r) => !r.ok);
const succeeded = results.filter((r) => r.ok);
console.log(
  `\nDone: ${succeeded.length}/${results.length} window(s) succeeded, ` +
    `${succeeded.reduce((n, r) => n + (r.result?.actionItems.length ?? 0), 0)} action item(s), ` +
    `${succeeded.reduce((n, r) => n + (r.result?.memoryContext.length ?? 0), 0)} memory(ies) total`,
);

if (out) {
  await Bun.write(out, JSON.stringify(results, null, 2));
  console.log(`Full results written to ${out}`);
}

if (failed.length > 0) {
  console.error(`\n${failed.length} window(s) failed — retry individually with:`);
  for (const f of failed) {
    console.error(
      `  bun run scripts/backfill-extraction.ts ${f.start} --end ${f.end} --url ${url}`,
    );
  }
  process.exit(1);
}
