// Catch up screenshot-to-Notion ingestion without going through the HTTP
// server. The workflow can legitimately run longer than Bun's maximum server
// idle timeout, so this CLI calls it in-process and has no whole-job deadline.
// Each configured model route still retains its own five-minute safety timeout.
//
// Usage:
//   bun run catchup:screenshots --from 2026-08-22T09:12:07-04:00
//   bun run catchup:screenshots --hours-back 48 --limit 100
//   bun run catchup:screenshots --from 2026-08-22 --json

import { initTracing, shutdownTracing } from "../src/core/tracing";
import { installShutdownHandler } from "../src/core/shutdown";
import {
  initNotionMcpCache,
  shutdownNotionMcpCache,
} from "../src/mcp/notionCache";
import { ingestRecentScreenshots } from "../src/workflows/screenshotIngestion";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5_000;

interface CatchupOptions {
  fromTime?: string;
  hoursBack?: number;
  limit: number;
  json: boolean;
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    "usage: bun run catchup:screenshots (--from <date> | --hours-back <hours>) " +
      "[--limit <1-5000>] [--json]",
  );
  process.exit(message ? 1 : 0);
}

function optionValue(args: string[], index: number, name: string): [string, number] {
  const arg = args[index]!;
  const inlinePrefix = `--${name}=`;
  if (arg.startsWith(inlinePrefix)) return [arg.slice(inlinePrefix.length), index];
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage(`--${name} requires a value`);
  return [value, index + 1];
}

function parseArgs(args: string[]): CatchupOptions {
  let fromTime: string | undefined;
  let hoursBack: number | undefined;
  let limit = DEFAULT_LIMIT;
  let json = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--from" || arg.startsWith("--from=")) {
      const [value, consumedIndex] = optionValue(args, index, "from");
      fromTime = value;
      index = consumedIndex;
      continue;
    }
    if (arg === "--hours-back" || arg.startsWith("--hours-back=")) {
      const [value, consumedIndex] = optionValue(args, index, "hours-back");
      hoursBack = Number(value);
      index = consumedIndex;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const [value, consumedIndex] = optionValue(args, index, "limit");
      limit = Number(value);
      index = consumedIndex;
      continue;
    }
    usage(`unknown argument ${arg}`);
  }

  if ((fromTime ? 1 : 0) + (hoursBack === undefined ? 0 : 1) !== 1) {
    usage("choose exactly one of --from or --hours-back");
  }
  if (fromTime && Number.isNaN(new Date(fromTime).getTime())) {
    usage(`--from value is not a parseable date: ${fromTime}`);
  }
  if (hoursBack !== undefined && (!Number.isFinite(hoursBack) || hoursBack <= 0)) {
    usage("--hours-back must be a positive number");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    usage(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
  }

  return { fromTime, hoursBack, limit, json };
}

const options = parseArgs(process.argv.slice(2));
let cleanedUp = false;
async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  await shutdownNotionMcpCache();
  await shutdownTracing();
}

initTracing();
installShutdownHandler(cleanup);

try {
  await initNotionMcpCache();
  const range = options.fromTime
    ? `from ${new Date(options.fromTime).toISOString()}`
    : `from the last ${options.hoursBack} hour(s)`;
  console.log(`Catching up screenshots ${range}, limit ${options.limit}...`);

  const result = await ingestRecentScreenshots({
    fromTime: options.fromTime,
    hoursBack: options.hoursBack,
    limit: options.limit,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const item of result.screenshots) {
      const classification = item.classification
        ? `${item.classification.classification}: ${item.classification.name}`
        : "unclassified";
      const page = item.ingestion?.page_url ? ` -> ${item.ingestion.page_url}` : "";
      const error = item.error ? ` (${item.error})` : "";
      console.log(`[${item.status}] ${item.filename} — ${classification}${page}${error}`);
    }

    const counts = result.screenshots.reduce<Record<string, number>>((all, item) => {
      all[item.status] = (all[item.status] ?? 0) + 1;
      return all;
    }, {});
    console.log(
      `Done: ${result.returned}/${result.totalInWindow} selected; ` +
        `ingested=${counts.ingested ?? 0}, rejected=${counts.rejected ?? 0}, ` +
        `skipped=${counts.skipped ?? 0}, failed=${counts.failed ?? 0}`,
    );
  }

  if (result.totalInWindow > result.returned) {
    console.warn(
      `Warning: ${result.totalInWindow - result.returned} screenshot(s) were outside ` +
        `the --limit cap. Run again with a higher --limit to cover them.`,
    );
  }
  if (result.screenshots.some((item) => item.status === "failed")) {
    process.exitCode = 1;
  }
} finally {
  await cleanup();
}
