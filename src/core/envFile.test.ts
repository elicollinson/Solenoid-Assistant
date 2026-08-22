import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setEnvValue } from "./envFile";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("setEnvValue", () => {
  test("updates one key while preserving the rest of the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-file-"));
    dirs.push(dir);
    const path = join(dir, ".env");
    writeFileSync(path, "FIRST=one\nSECOND=two\n");
    setEnvValue("SECOND", "changed", path);
    setEnvValue("THIRD", "three", path);
    expect(readFileSync(path, "utf8")).toContain("FIRST=one\nSECOND=changed\n");
    expect(readFileSync(path, "utf8")).toContain("THIRD=three");
  });

  test("rejects unsafe keys and multiline values", () => {
    expect(() => setEnvValue("bad-key", "value", "/tmp/unused")).toThrow(/Invalid/);
    expect(() => setEnvValue("GOOD", "a\nb", "/tmp/unused")).toThrow(/single line/);
  });
});
