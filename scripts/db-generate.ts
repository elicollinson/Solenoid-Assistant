#!/usr/bin/env bun
// Generate a migration, then make every new table STRICT.
//
// drizzle-kit cannot emit STRICT tables, and STRICT is worth keeping: without
// it SQLite silently coerces a number written into a TEXT column, which is
// exactly the mistake a model writing rows will make. drizzle-kit diffs against
// its own snapshot JSON rather than the emitted SQL, so rewriting the SQL here
// is safe for every future generate.
//
// Run this instead of `drizzle-kit generate`. src/db/schema.test.ts fails if a
// table ever reaches the database without STRICT, so bypassing this script is
// caught rather than silently accepted.
import { $ } from "bun";
import { readdir } from "node:fs/promises";

const MIGRATIONS_DIR = "drizzle";
const BREAKPOINT = "--> statement-breakpoint";

/** `CREATE TABLE ... (\n\t...\n);` becomes `... \n) STRICT;`. */
function addStrict(sql: string): string {
  return sql
    .split(BREAKPOINT)
    .map((statement) => {
      const trimmed = statement.trim();
      if (!/^CREATE TABLE /i.test(trimmed)) return statement;
      if (/^CREATE VIRTUAL TABLE /i.test(trimmed)) return statement;
      if (/\)\s*STRICT\s*;/i.test(trimmed)) return statement; // already patched
      // Only the final `);` of the statement closes the column list.
      return statement.replace(/\)\s*;(\s*)$/, ") STRICT;$1");
    })
    .join(BREAKPOINT);
}

const args = process.argv.slice(2);
const before = new Set(await readdir(MIGRATIONS_DIR).catch(() => []));

await $`bun x drizzle-kit generate ${args}`;

const after = await readdir(MIGRATIONS_DIR);
const created = after.filter((f) => f.endsWith(".sql") && !before.has(f));

// Patch everything, not just the new file: idempotent, and it repairs a
// migration someone generated with drizzle-kit directly.
let patched = 0;
for (const name of after.filter((f) => f.endsWith(".sql"))) {
  const path = `${MIGRATIONS_DIR}/${name}`;
  const sql = await Bun.file(path).text();
  const next = addStrict(sql);
  if (next !== sql) {
    await Bun.write(path, next);
    patched++;
  }
}

if (created.length > 0) console.log(`\ngenerated: ${created.join(", ")}`);
console.log(patched > 0 ? `STRICT applied to ${patched} migration file(s)` : "STRICT already applied");
