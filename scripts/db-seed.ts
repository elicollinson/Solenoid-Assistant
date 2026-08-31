#!/usr/bin/env bun
// Load the design's content into SQLite so the UI has something true to draw.
//
// Safe to re-run: the seed clears what it owns first. It is anchored to the
// day it runs, so the home screen always reads as this morning.
import { DEFAULT_DB_PATH, initDb } from "../src/db";
import { seedDesignFixtures } from "../src/db/seed/design";

const path = process.argv[2] ?? DEFAULT_DB_PATH;
const db = initDb(path);

const result = seedDesignFixtures(db);

console.log(
  `seeded ${path} — ${result.workflows} workflows, ${result.runs} runs, ${result.runSteps} run steps, ` +
    `${result.activityItems} activity items, ${result.reminders} reminders, ${result.calendar} calendar entries, ` +
    `${result.decisions} decisions, ${result.actions} actions, ${result.sources} cited sources, ` +
    `${result.evidence} evidence links`,
);

db.$client.close();
