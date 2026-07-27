import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBundle } from "./bundle";
import { appendLogEntry, insertEntry } from "./logFile";

describe("insertEntry", () => {
  test("seeds a log from nothing", () => {
    expect(insertEntry("", "2026-07-25", "Creation", "Established [X](/x.md).")).toBe(
      "# Bundle Update Log\n\n## 2026-07-25\n* **Creation**: Established [X](/x.md).\n",
    );
  });

  test("date groups are newest first", () => {
    const first = insertEntry("", "2026-07-20", "Creation", "old");
    const second = insertEntry(first, "2026-07-25", "Update", "new");
    expect(second).toBe(
      "# Bundle Update Log\n\n## 2026-07-25\n* **Update**: new\n\n## 2026-07-20\n* **Creation**: old\n",
    );
  });

  test("a second entry on the same day joins that day's group, newest first", () => {
    const first = insertEntry("", "2026-07-25", "Creation", "one");
    const second = insertEntry(first, "2026-07-25", "Update", "two");
    expect(second).toBe(
      "# Bundle Update Log\n\n## 2026-07-25\n* **Update**: two\n* **Creation**: one\n",
    );
  });

  test("backdated entries land in their own group without disturbing newer ones", () => {
    let log = insertEntry("", "2026-07-25", "Creation", "newest");
    log = insertEntry(log, "2026-07-20", "Update", "older");
    expect(log.indexOf("2026-07-20")).toBeGreaterThan(log.indexOf("2026-07-25"));
  });

  test("keeps an existing custom title", () => {
    const existing = "# Directory Update Log\n\n## 2026-07-20\n* **Creation**: old\n";
    expect(insertEntry(existing, "2026-07-25", "Update", "new").startsWith("# Directory Update Log")).toBe(true);
  });

  test("absorbs a log that has a title but no entries", () => {
    expect(insertEntry("# Bundle Update Log\n\n*Memory bundle initialized.*\n", "2026-07-25", "Update", "x")).toBe(
      "# Bundle Update Log\n\n## 2026-07-25\n* **Update**: x\n\n*Memory bundle initialized.*\n",
    );
  });

  test("tolerates CRLF and trailing whitespace", () => {
    const existing = "# Bundle Update Log\r\n\r\n## 2026-07-25\r\n* **Creation**: one\r\n\r\n";
    expect(insertEntry(existing, "2026-07-25", "Update", "two")).toBe(
      "# Bundle Update Log\n\n## 2026-07-25\n* **Update**: two\n* **Creation**: one\n",
    );
  });
});

describe("appendLogEntry", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("writes log.md at the bundle root using the injected clock", async () => {
    dir = mkdtempSync(join(tmpdir(), "okf-log-"));
    const bundle = openBundle(dir, { now: () => new Date("2026-07-25T12:00:00Z") });
    await appendLogEntry(bundle, "Creation", "Established [X](/x.md).");
    await appendLogEntry(bundle, "Update", "Updated [X](/x.md).");
    expect(await Bun.file(join(dir, "log.md")).text()).toBe(
      "# Bundle Update Log\n\n## 2026-07-25\n* **Update**: Updated [X](/x.md).\n* **Creation**: Established [X](/x.md).\n",
    );
  });
});
