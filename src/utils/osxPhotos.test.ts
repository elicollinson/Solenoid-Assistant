import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { materialize, type PhotoRecord } from "./osxPhotos";

test("materialize maps both edited and unedited iCloud exports back to their UUIDs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "photos-edited-test-"));
  try {
    const binary = path.join(root, "osxphotos");
    // Model osxphotos' documented default suffix for edited versions.
    await writeFile(binary, `#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
const ids = (await readFile(args[args.indexOf("--uuid-from-file") + 1], "utf8")).split("\\n");
const suffixIndex = args.indexOf("--edited-suffix");
const editedSuffix = suffixIndex < 0 ? "_edited" : args[suffixIndex + 1];
for (const id of ids) {
  const suffix = id === "edited-photo" ? editedSuffix : "";
  await writeFile(path.join(args[1], id + suffix + ".png"), "fixture");
}
`);
    await chmod(binary, 0o700);
    const photos = ["edited-photo", "original-photo"].map((uuid) => ({ uuid, path: null }) as PhotoRecord);
    const resolved = await materialize(photos, root, { binary });
    expect([...resolved]).toEqual([
      ["edited-photo", path.join(root, "edited-photo.png")],
      ["original-photo", path.join(root, "original-photo.png")],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
