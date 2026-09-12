// Explicit destination prevents accidentally modifying the configured live DB.
import { parseArgs } from "node:util";
import { initDb } from "../src/db";
import { importCollectionSnapshot, collectionSnapshotSchema } from "../src/db/mutations/importCollections";
const { values } = parseArgs({ args: process.argv.slice(2), options: {
  snapshot: { type: "string" }, database: { type: "string" }, apply: { type: "boolean" },
}, strict: true });
if (!values.snapshot || (values.apply && !values.database)) throw new Error("Usage: bun run import:collections --snapshot <file.json> [--apply --database <destination.db>]");
const snapshot = collectionSnapshotSchema.parse(await Bun.file(values.snapshot).json());
if (values.apply) {
  const db = initDb(values.database!);
  try { console.log(JSON.stringify(importCollectionSnapshot(db, snapshot))); }
  finally { db.$client.close(); }
} else console.log(JSON.stringify({ mode: "preview", records: snapshot.records.length, collections: Object.fromEntries(["book", "movie", "tv", "game", "music"].map((c) => [c, snapshot.records.filter((r) => r.collection === c).length])) }));
