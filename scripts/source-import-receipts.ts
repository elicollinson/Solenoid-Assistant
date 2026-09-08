#!/usr/bin/env bun
// Explicitly migrate this instance's old processing receipts without rerunning
// any workflow or modifying the existing JSON file.
import {
  loadProcessed,
  saveProcessed,
} from "../src/utils/screenshotsProcessed";
const source = process.argv[2];
if (!source)
  throw new Error(
    "Usage: source-import-receipts.ts PATH_TO_OLD_SCREENSHOTS_DIRECTORY",
  );
await saveProcessed({
  ...(await loadProcessed(source)),
  ...(await loadProcessed()),
});
console.log("Imported screenshot receipts; existing database receipts kept.");
