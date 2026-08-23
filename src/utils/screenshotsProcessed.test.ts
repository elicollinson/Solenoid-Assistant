import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProcessed, markAsIngested, saveProcessed } from "./screenshotsProcessed";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temporaryDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "screenshots-processed-"));
  dirs.push(dir);
  return dir;
}

describe("processed screenshot state", () => {
  test("treats a missing file as empty and round-trips an atomic save", async () => {
    const dir = await temporaryDir();
    const state = await loadProcessed(dir);
    markAsIngested(state, "uuid", "Book", "Dune");
    await saveProcessed(state, dir);

    expect((await loadProcessed(dir)).uuid?.name).toBe("Dune");
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("fails loudly for corrupt state instead of reprocessing everything", async () => {
    const dir = await temporaryDir();
    await writeFile(path.join(dir, "processed.json"), "not json", "utf8");
    expect(loadProcessed(dir)).rejects.toThrow(/not valid JSON/);
  });
});
