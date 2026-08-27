#!/usr/bin/env bun
// Project okf/ into SQLite so "Things I know" has your real memory to draw.
//
// Safe to re-run and safe to run against a database that already has one: the
// write is an upsert keyed on derived ids, so nothing that cited a fact loses
// its citation. Dropping the okf_* tables and running this again rebuilds the
// projection exactly.
import { DEFAULT_DB_PATH, initDb } from "../src/db";
import { reindexOkf } from "../src/db/okf/reindex";

const root = process.argv[2] ?? "okf";
const path = process.argv[3] ?? DEFAULT_DB_PATH;

const db = initDb(path);
const result = await reindexOkf(db, { root });

console.log(
  `indexed ${root} into ${path} — ${result.objects} objects, ${result.fields} fields, ` +
    `${result.conflicts} conflicts, ${result.links} links`,
);
for (const problem of result.problems) console.log(`  could not parse ${problem.path}: ${problem.message}`);

db.$client.close();
