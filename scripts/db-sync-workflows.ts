#!/usr/bin/env bun
// Put the workflow catalog into the database — deliberately, by a person.
//
// This used to happen on every server boot, and that was a bug with teeth: the
// database became a cache of src/workflows/catalog.ts, so a schedule somebody
// set through the screen, or asked the agent for, was overwritten on the next
// restart — and where the catalog said `rrule: null`, deleted outright with
// nothing logged. A record a restart can rewrite is not a record.
//
// So it is a script. Run it after adding a workflow to the catalog; boot only
// LOOKS now, and warns about anything unseeded.
//
// Safe to re-run and additive. Existing rows keep their schedule exactly as it
// is, including where the catalog disagrees — see `upsertSchedule` in
// src/workflows/sync.ts.
import { DEFAULT_DB_PATH, initDb } from "../src/db";
import { syncWorkflowCatalog } from "../src/workflows/sync";

const path = process.argv[2] ?? DEFAULT_DB_PATH;
const db = initDb(path);

const { added, updated } = syncWorkflowCatalog(db);
console.log(
  `synced ${path} — ${added} added, ${updated} updated. ` +
    "Schedules already in the database were left alone.",
);

db.$client.close();
