// 0015: screenshots that ran out of classification attempts were filed as
// rejected for good. The migration turns those, and only those, into errors so
// the next collection brings them back.
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb, runMigrations } from "./index";

test("migration marks exhausted rejections as errors and leaves decisions alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "screenshot-errors-"));
  const db = createDb(":memory:");
  try {
    mkdirSync(join(dir, "meta"));
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 15);
    writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) copyFileSync(`drizzle/${entry.tag}.sql`, join(dir, `${entry.tag}.sql`));
    runMigrations(db, dir);
    const insert = db.$client.query(
      "INSERT INTO source_candidates(hash,extension,status,created_at,attempts,classification) VALUES(?,?,?,?,?,?)",
    );
    insert.run("exhausted", ".png", "rejected", 1, 5, null);
    insert.run("judged", ".png", "rejected", 1, 1, null);
    insert.run("accepted", ".png", "accepted", 1, 5, '{"classification":"Movie","name":"Arrival"}');
    insert.run("retrying", ".png", "failed", 1, 3, null);
    runMigrations(db);
    const status = Object.fromEntries(
      (db.$client.query("SELECT hash,status FROM source_candidates").all() as { hash: string; status: string }[])
        .map((row) => [row.hash, row.status]),
    );
    expect(status).toEqual({ exhausted: "error", judged: "rejected", accepted: "accepted", retrying: "failed" });
  } finally { db.$client.close(); rmSync(dir, { recursive: true, force: true }); }
});
