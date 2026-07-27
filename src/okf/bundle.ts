// Bundle addressing: the one place a model-supplied string becomes a path.
//
// Every OKF tool takes a *concept ID* (spec §2: the file's path within the
// bundle with `.md` removed) — never a filesystem path. That keeps a single
// resolve/guard seam, the same way the iMessage tools expose no parameter that
// could reach past the trust boundary: an out-of-bundle write is not
// expressible in the tool vocabulary.
import { mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import * as posix from "node:path/posix";

export class OkfError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "OkfError";
  }
}

/** Filenames with defined meaning that MUST NOT be concept documents (§3.1). */
export const RESERVED_BASENAMES = ["index", "log"] as const;

export const INDEX_FILENAME = "index.md";
export const LOG_FILENAME = "log.md";

export interface Bundle {
  /** Absolute path to the bundle root directory. */
  root: string;
  /** Injectable clock — every timestamp the store stamps flows through this. */
  now: () => Date;
}

export function openBundle(root: string, opts: { now?: () => Date } = {}): Bundle {
  return { root: resolve(root), now: opts.now ?? (() => new Date()) };
}

/**
 * Normalize a model-supplied concept ID.
 *
 * Lenient about the two mistakes models make constantly — a leading `/` and a
 * trailing `.md` — because each one otherwise costs a whole agent loop
 * iteration. Strict about everything that could escape the bundle or collide
 * with a reserved filename.
 */
export function normalizeConceptId(raw: string): string {
  const id = normalizePathish(raw);
  if (id === "") throw new OkfError("Concept ID is empty", "invalid_id");
  const segments = id.split("/");
  const last = segments[segments.length - 1] ?? "";
  if ((RESERVED_BASENAMES as readonly string[]).includes(last)) {
    throw new OkfError(
      `"${last}.md" is a reserved filename (§3.1) and cannot be a concept; it is maintained automatically`,
      "reserved_id",
    );
  }
  return id;
}

/** Normalize a directory ID (`""` is the bundle root). Reserved names allowed. */
export function normalizeDirId(raw: string): string {
  return normalizePathish(raw, { allowEmpty: true });
}

function normalizePathish(raw: string, opts: { allowEmpty?: boolean } = {}): string {
  if (typeof raw !== "string") throw new OkfError("Concept ID must be a string", "invalid_id");
  let id = raw.trim();
  if (id.includes("\\")) {
    throw new OkfError(`Invalid concept ID "${raw}": use "/" as the path separator`, "invalid_id");
  }
  if (id.includes("\0")) throw new OkfError("Invalid concept ID", "invalid_id");
  id = id.replace(/^\/+/, "").replace(/\/+$/, ""); // bundle-relative already
  if (id.toLowerCase().endsWith(".md")) id = id.slice(0, -3);
  id = id.replace(/\/{2,}/g, "/");
  if (id === "" || id === ".") {
    if (opts.allowEmpty) return "";
    throw new OkfError("Concept ID is empty", "invalid_id");
  }
  const segments = id.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new OkfError(
        `Invalid concept ID "${raw}": path segments must not be empty, "." or ".."`,
        "invalid_id",
      );
    }
    if (segment.startsWith(".")) {
      throw new OkfError(`Invalid concept ID "${raw}": segments must not start with "."`, "invalid_id");
    }
  }
  return segments.join("/");
}

/** Absolute filesystem path for a concept ID, re-checked against the root. */
export function conceptPath(bundle: Bundle, id: string): string {
  return within(bundle, join(bundle.root, `${id}.md`));
}

/** Absolute filesystem path for a directory ID (`""` is the root). */
export function dirPath(bundle: Bundle, dirId: string): string {
  return within(bundle, dirId === "" ? bundle.root : join(bundle.root, dirId));
}

// Defense in depth: normalizeConceptId already rejects traversal, but a bug
// there must not become a write outside the bundle.
function within(bundle: Bundle, candidate: string): string {
  const abs = resolve(candidate);
  if (abs !== bundle.root && !abs.startsWith(bundle.root + sep)) {
    throw new OkfError(`Path escapes the bundle root: ${candidate}`, "escapes_root");
  }
  return abs;
}

/** The directory ID containing a concept (`""` when it sits at the root). */
export function parentDirId(id: string): string {
  const parent = posix.dirname(id);
  return parent === "." ? "" : parent;
}

/** Filename-derived display title, for concepts with no `title` (§4.1). */
export function titleFromId(id: string): string {
  return posix.basename(id);
}

let tmpCounter = 0;

/** Write via a temp file + rename so a crash never leaves a half-written concept. */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${++tmpCounter}`;
  await Bun.write(tmp, contents);
  await rename(tmp, path);
}
