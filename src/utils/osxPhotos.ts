/**
 * Typed wrapper around the `osxphotos` CLI.
 *
 * We shell out rather than reimplement: osxphotos encodes years of
 * reverse-engineered knowledge about the Photos.sqlite schema, which Apple
 * changes between macOS releases. Parsing its JSON is the cheap half of a
 * deal where someone else maintains the expensive half.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * A single record from `osxphotos query --json`.
 *
 * These key names come from `PhotoInfo._asdict_uncached()` in the osxphotos
 * source. `--json` emits the *non-shallow* representation, so the extra keys
 * (person_info, search_info, adjustments, ...) are present too; only the
 * fields this pipeline actually touches are typed here. Dates are serialized
 * as ISO 8601 strings.
 */
export interface PhotoRecord {
  uuid: string;
  /** Current filename inside the library. */
  filename: string;
  /** Filename at import time — usually the more human-meaningful one. */
  original_filename: string;
  /**
   * Absolute path to the original on disk, or null when the asset lives only
   * in iCloud and has not been downloaded locally. Always null-check this.
   */
  path: string | null;
  /** Path to the rendered edit, if the photo has been edited. */
  path_edited: string | null;
  /** ISO 8601. The capture date. */
  date: string;
  date_added: string;
  title: string | null;
  description: string | null;
  keywords: string[];
  albums: string[];
  persons: string[];
  /** Apple's own image-classification labels — cheap pre-filtering signal. */
  labels: string[];
  width: number;
  height: number;
  original_filesize: number;
  /** Uniform Type Identifier, e.g. "public.png", "public.heic". */
  uti: string;
  ismovie: boolean;
  isphoto: boolean;
  /** True when the original is not downloaded locally. */
  ismissing: boolean;
  intrash: boolean;
  /** The flag we care about: set by the OS at capture time. */
  screenshot: boolean;
  /** Video equivalent of `screenshot`. */
  screen_recording?: boolean;
  /** In a shared iCloud album. */
  shared: boolean;
  favorite: boolean;
  hidden: boolean;
}

export interface QueryOptions {
  /** Only screenshots. Default true — this is the whole point. */
  screenshot?: boolean;
  /** Exclude content shared with you via Messages ("Shared with You"). */
  excludeSyndicated?: boolean;
  /** Exclude shared iCloud albums. */
  excludeShared?: boolean;
  /** Exclude photos marked hidden in Photos.app. Default true. */
  excludeHidden?: boolean;
  /** ISO 8601 date string, e.g. "2026-01-01". Inclusive lower bound. */
  fromDate?: string;
  /** ISO 8601 date string. Inclusive upper bound. */
  toDate?: string;
  /** Path to a non-default .photoslibrary. Omit to use the system library. */
  libraryPath?: string;
  /** Cap the number of results (applied client-side, after the query). */
  limit?: number;
  /** Path to the osxphotos binary. Default: "osxphotos" on PATH. */
  binary?: string;
}

/** Thrown when the osxphotos CLI itself fails, with its stderr attached. */
export class OsxPhotosError extends Error {
  // Assigned explicitly rather than via a TS parameter property: Node's
  // --experimental-strip-types only erases types, it can't emit the
  // constructor assignment a parameter property implies.
  stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.name = "OsxPhotosError";
    this.stderr = stderr;
  }
}

/**
 * A Photos library with a decade of screenshots produces a large JSON blob —
 * every record carries face info, labels, scores and EXIF. 256MB is generous
 * headroom; if you blow through it, switch to streaming with `spawn` and a
 * incremental JSON parser.
 */
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Ceiling on any single osxphotos invocation. An iCloud download of a large
 * batch is the slow case; anything past this is a wedged subprocess, and a
 * wedged subprocess must not wedge the HTTP request that started it.
 */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

async function runOsxPhotos(
  args: string[],
  binary: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  try {
    // execFile, not exec: argv array means no shell, so paths with spaces
    // (like "Photos Library.photoslibrary") need no quoting and nothing
    // user-supplied can be interpreted as shell syntax.
    const pending = execFileAsync(binary, args, {
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });

    // osxphotos has interactive `click.confirm` guards (e.g. exporting into a
    // directory that already holds an export database). Node leaves the child's
    // stdin an open pipe it never writes to, so such a prompt blocks on a read
    // that can never complete — the whole request hangs with no output. Closing
    // stdin turns any prompt into an immediate EOF/Abort, i.e. a fast error
    // instead of a silent hang.
    pending.child.stdin?.end();

    const { stdout } = await pending;
    return stdout;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };

    if (e.killed) {
      throw new OsxPhotosError(
        `osxphotos timed out after ${Math.round(timeoutMs / 1000)}s and was killed ` +
          `(command: ${binary} ${args.join(" ")}).`,
        e.stderr ?? "",
      );
    }
    if (e.code === "ENOENT") {
      throw new OsxPhotosError(
        `Could not find the '${binary}' executable. Install it with ` +
          `\`uv tool install --python 3.13 osxphotos\` or \`brew install osxphotos\`.`,
        "",
      );
    }
    const stderr = e.stderr ?? "";
    // Full Disk Access is the overwhelmingly common first-run failure, and
    // the raw error is opaque enough to be worth translating.
    if (/operation not permitted|unable to open database/i.test(stderr)) {
      throw new OsxPhotosError(
        "osxphotos could not read the Photos library. Grant Full Disk Access " +
          "to your terminal (or whatever process runs this) in System Settings " +
          "> Privacy & Security > Full Disk Access, then restart it.",
        stderr,
      );
    }
    // click aborts when a confirmation prompt hits closed stdin. That means a
    // guard fired that we should be suppressing with an explicit flag, not a
    // transient failure — say so rather than surfacing a bare "Aborted!".
    if (/aborted!?/i.test(stderr)) {
      throw new OsxPhotosError(
        "osxphotos asked for interactive confirmation and was aborted (stdin is " +
          "closed for non-interactive runs). The stderr warning above it names the " +
          "guard that fired; pass the flag that suppresses it.",
        stderr,
      );
    }
    throw new OsxPhotosError(`osxphotos failed: ${e.message}`, stderr);
  }
}

/**
 * Query the Photos library for screenshots.
 *
 * The defaults encode the intent "my own screenshots, nothing anyone sent me":
 * the `screenshot` flag is stamped by the OS at capture time, so an image
 * someone else screenshotted and sent you never carries it — your device
 * didn't capture it. `excludeSyndicated` and `excludeShared` close the
 * remaining gaps for content that arrived via Messages or a shared album.
 */
export async function queryScreenshots(
  opts: QueryOptions = {},
): Promise<PhotoRecord[]> {
  const {
    screenshot = true,
    excludeSyndicated = true,
    excludeShared = true,
    excludeHidden = true,
    fromDate,
    toDate,
    libraryPath,
    limit,
    binary = "osxphotos",
  } = opts;

  const args = ["query", "--json"];

  if (screenshot) args.push("--screenshot");
  if (excludeSyndicated) args.push("--not-syndicated");
  if (excludeShared) args.push("--not-shared");
  if (excludeHidden) args.push("--not-hidden");
  if (fromDate) args.push("--from-date", fromDate);
  if (toDate) args.push("--to-date", toDate);
  if (libraryPath) args.push("--library", libraryPath);

  const stdout = await runOsxPhotos(args, binary);

  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let records: PhotoRecord[];
  try {
    records = JSON.parse(trimmed) as PhotoRecord[];
  } catch {
    throw new OsxPhotosError(
      "Could not parse osxphotos JSON output.",
      trimmed.slice(0, 500),
    );
  }

  // osxphotos excludes trashed photos by default, but belt and braces: a
  // deleted screenshot is not something you want to spend vision tokens on.
  const usable = records.filter((r) => !r.intrash);

  return typeof limit === "number" ? usable.slice(0, limit) : usable;
}

/**
 * Optional extra hardening: map each UUID to the bundle ID of the app that
 * imported it. Photos records this, and it distinguishes e.g.
 * "com.apple.MobileSMS" (arrived via Messages) from "com.apple.camera".
 *
 * Screenshots you took yourself won't normally have a Messages bundle ID, so
 * this is redundant with `--not-syndicated` in most libraries — reach for it
 * if you've manually saved images out of conversations over the years.
 */
export async function getImportSources(
  uuids: string[],
  binary = "osxphotos",
): Promise<Map<string, string | null>> {
  if (uuids.length === 0) return new Map();

  const dir = await mkdtemp(path.join(tmpdir(), "osxphotos-uuids-"));
  const uuidFile = path.join(dir, "uuids.txt");
  await writeFile(uuidFile, uuids.join("\n"), "utf8");

  const stdout = await runOsxPhotos(
    [
      "query",
      "--json",
      "--uuid-from-file",
      uuidFile,
      "--field",
      "uuid",
      "{uuid}",
      "--field",
      "app",
      "{imported_by.id}",
    ],
    binary,
  );

  const rows = JSON.parse(stdout.trim() || "[]") as Array<{
    uuid: string;
    app: string;
  }>;

  return new Map(
    rows.map((r) => [r.uuid, r.app && r.app !== "_" ? r.app : null]),
  );
}

/**
 * Ensure every photo has a readable file on disk, returning uuid -> path.
 *
 * Photos whose originals are already local are used in place — no copying.
 * Anything iCloud-only (`ismissing`) is exported into `destDir` with
 * `--download-missing`, which pulls it down from iCloud first.
 *
 * The export uses `--filename "{uuid}"` so the output name is deterministic
 * and we can find it again; the export report keys on filename rather than
 * UUID, so predicting the name is simpler than parsing the report.
 */
export async function materialize(
  photos: PhotoRecord[],
  destDir: string,
  opts: { binary?: string; libraryPath?: string } = {},
): Promise<Map<string, string>> {
  const { binary = "osxphotos", libraryPath } = opts;
  const resolved = new Map<string, string>();

  const missing: PhotoRecord[] = [];
  for (const p of photos) {
    if (p.path) {
      resolved.set(p.uuid, p.path);
    } else {
      missing.push(p);
    }
  }

  if (missing.length === 0) return resolved;

  const tmp = await mkdtemp(path.join(tmpdir(), "osxphotos-export-"));
  const uuidFile = path.join(tmp, "uuids.txt");
  await writeFile(uuidFile, missing.map((p) => p.uuid).join("\n"), "utf8");

  const args = [
    "export",
    destDir,
    "--uuid-from-file",
    uuidFile,
    "--download-missing",
    "--filename",
    "{uuid}",
    // Screenshots are never edited in any meaningful sense, but if one has
    // been, the edit is the version you actually want described.
    "--skip-original-if-edited",
    // destDir is reused across runs, so it holds an export database from the
    // last one. Without --update, osxphotos warns about the stale database and
    // blocks on an interactive "Do you want to continue?" — fatal for a server.
    // --update is also what we want semantically: already-exported screenshots
    // are skipped instead of re-downloaded.
    "--update",
  ];
  if (libraryPath) args.push("--library", libraryPath);

  await runOsxPhotos(args, binary);

  // Match exported files back to UUIDs by their deterministic stem.
  const entries = await readdir(destDir);
  const byStem = new Map<string, string>();
  for (const name of entries) {
    byStem.set(path.parse(name).name, path.join(destDir, name));
  }
  for (const p of missing) {
    const found = byStem.get(p.uuid);
    if (found) resolved.set(p.uuid, found);
  }

  return resolved;
}
