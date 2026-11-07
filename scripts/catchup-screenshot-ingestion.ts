// Catch up screenshot collection ingestion without going through the HTTP
// server. The workflow can legitimately run longer than Bun's maximum server
// idle timeout, so this CLI calls it in-process and has no whole-job deadline.
// Each configured model route still retains its own five-minute safety timeout.
//
// Usage:
//   bun run catchup:screenshots --from 2026-08-22T09:12:07-04:00
//   bun run catchup:screenshots --from 2026-08-22 --to 2026-08-29 --json
//   bun run catchup:screenshots --hours-back 48
//
// The window is walked oldest first, one screenshot at a time, and anything
// already in Collections is passed over, so an interrupted catch-up can simply
// be run again with the same window.

import { initTracing, shutdownTracing } from "../src/core/tracing";
import { installShutdownHandler } from "../src/core/shutdown";
import { ingestScreenshotWindow } from "../src/workflows/screenshotIngestion";
import { withWorkflowPermissions } from "../src/workflows/permissions";
import { getDb } from "../src/db";

interface CatchupOptions {
  start: Date;
  end: Date;
  json: boolean;
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    "usage: bun run catchup:screenshots (--from <date> | --hours-back <hours>) [--to <date>] [--json]",
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

function parseDate(value: string, flag: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) usage(`${flag} value is not a parseable date: ${value}`);
  return date;
}

function parseArgs(args: string[]): CatchupOptions {
  let from: string | undefined;
  let to: string | undefined;
  let hoursBack: number | undefined;
  let json = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--json") {
      json = true;
      continue;
    }
    for (const name of ["from", "to", "hours-back"] as const) {
      if (arg === `--${name}` || arg.startsWith(`--${name}=`)) {
        const [value, consumedIndex] = optionValue(args, index, name);
        if (name === "from") from = value;
        else if (name === "to") to = value;
        else hoursBack = Number(value);
        index = consumedIndex;
        break;
      }
      if (name === "hours-back") usage(`unknown argument ${arg}`);
    }
  }

  if ((from ? 1 : 0) + (hoursBack === undefined ? 0 : 1) !== 1) {
    usage("choose exactly one of --from or --hours-back");
  }
  if (hoursBack !== undefined && (!Number.isFinite(hoursBack) || hoursBack <= 0)) {
    usage("--hours-back must be a positive number");
  }
  const end = to ? parseDate(to, "--to") : new Date();
  const start = from ? parseDate(from, "--from") : new Date(end.getTime() - hoursBack! * 3600_000);
  if (start > end) usage("--from must be before --to");
  return { start, end, json };
}

const options = parseArgs(process.argv.slice(2));
let cleanedUp = false;
async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  await shutdownTracing();
}

initTracing();
installShutdownHandler(cleanup);

try {
  console.log(`Catching up screenshots from ${options.start.toISOString()} to ${options.end.toISOString()}...`);

  // The same rules the scheduled run is under. This is the most unattended
  // caller there is — a long sweep with nobody watching it — so it is the last
  // place a write should go through because nothing was looking.
  const result = await withWorkflowPermissions(getDb(), "screenshot-ingestion", () =>
    ingestScreenshotWindow({ start: options.start, end: options.end }),
  );

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const item of result.screenshots) {
      const classification = item.classification
        ? `${item.classification.classification}: ${item.classification.name}`
        : "unclassified";
      const page = item.ingestion?.itemId ? ` -> ${item.ingestion.itemId}` : "";
      const error = item.error ? ` (${item.error})` : "";
      console.log(`[${item.status}] ${item.filename} — ${classification}${page}${error}`);
    }

    const counts = result.screenshots.reduce<Record<string, number>>((all, item) => {
      all[item.status] = (all[item.status] ?? 0) + 1;
      return all;
    }, {});
    console.log(
      `Done: ${result.totalInWindow} in the window, ${result.alreadyDone} already in Collections, ` +
        `${result.processed} processed; ingested=${counts.ingested ?? 0}, rejected=${counts.rejected ?? 0}, ` +
        `skipped=${counts.skipped ?? 0}, failed=${counts.failed ?? 0}`,
    );
  }

  if (result.screenshots.some((item) => item.status === "failed")) {
    process.exitCode = 1;
  }
} finally {
  await cleanup();
}
