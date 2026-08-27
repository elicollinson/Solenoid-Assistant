#!/usr/bin/env bun
// Take the workflows with no code behind them out of the database.
//
// The opposite of `bun run db:seed`. That command writes the design's
// demonstrations — workflows with runs and prose on the record and nothing
// behind them — so the UI has something to draw. This removes them, leaving the
// list in src/workflows/catalog.ts and nothing else.
//
// Destructive, so it says what it will do and asks, unless you pass --yes.
// Everything it removes is reproducible with `bun run db:seed`.
import { createInterface } from "node:readline/promises";
import { DEFAULT_DB_PATH, initDb } from "../src/db";
import { pruneUncataloguedWorkflows, uncataloguedWorkflows } from "../src/db/mutations/pruneWorkflows";

const args = process.argv.slice(2);
const assumeYes = args.includes("--yes") || args.includes("-y");
const path = args.find((a) => !a.startsWith("-")) ?? DEFAULT_DB_PATH;

const db = initDb(path);
const doomed = uncataloguedWorkflows(db);

if (doomed.length === 0) {
  console.log(`${path} — nothing to prune; every workflow on the list has code behind it.`);
  db.$client.close();
  process.exit(0);
}

console.log(`${path} — ${doomed.length} workflow${doomed.length === 1 ? "" : "s"} with no code behind ${doomed.length === 1 ? "it" : "them"}:`);
for (const slug of doomed) console.log(`  ${slug}`);
console.log(
  "\nRemoving these takes their runs, traces and logs with them, and the feed\n" +
    "entries that were accounts of those runs. Reminders, calendar commitments,\n" +
    "suggestions and memories are kept. `bun run db:seed` writes it all back.",
);

if (!assumeYes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("\nGo ahead? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log("Left alone.");
    db.$client.close();
    process.exit(0);
  }
}

const result = pruneUncataloguedWorkflows(db);

console.log(
  `\npruned ${path} — ${result.removed.length} workflows, ${result.runs} runs, ` +
    `${result.activity} feed entries${result.calendar ? `, ${result.calendar} calendar blocks` : ""}` +
    `${result.unscopedSuggestions ? `; ${result.unscopedSuggestions} suggestion(s) left unscoped` : ""}`,
);

db.$client.close();
