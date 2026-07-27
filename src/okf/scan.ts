// Reading the tree.
//
// Deliberately cache-free: a knowledge bundle is a few hundred small markdown
// files, so a full scan is cheaper than an mtime index and cannot go stale
// against a bundle someone edited by hand or pulled with git. Add caching when
// a real bundle makes scanning show up in a trace, not before.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import * as posix from "node:path/posix";
import {
  INDEX_FILENAME,
  LOG_FILENAME,
  RESERVED_BASENAMES,
  dirPath,
  type Bundle,
} from "./bundle";
import { parseDocument } from "./concept";

export interface ScannedConcept {
  id: string;
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface ScanProblem {
  id: string;
  path: string;
  message: string;
}

export interface ScanResult {
  concepts: ScannedConcept[];
  /** Files that could not be read as concepts — surfaced by validate, not thrown. */
  problems: ScanProblem[];
}

function isReserved(id: string): boolean {
  return (RESERVED_BASENAMES as readonly string[]).includes(posix.basename(id));
}

export async function scanConcepts(bundle: Bundle): Promise<ScanResult> {
  const concepts: ScannedConcept[] = [];
  const problems: ScanProblem[] = [];

  for (const rel of await listMarkdownFiles(bundle)) {
    const id = rel.slice(0, -3);
    if (isReserved(id)) continue;
    const path = join(bundle.root, rel);
    try {
      const { frontmatter, body } = parseDocument(await Bun.file(path).text());
      if (!frontmatter) {
        problems.push({ id, path, message: "no YAML frontmatter block" });
        continue;
      }
      concepts.push({ id, path, frontmatter, body });
    } catch (err) {
      problems.push({ id, path, message: err instanceof Error ? err.message : String(err) });
    }
  }

  concepts.sort((a, b) => a.id.localeCompare(b.id));
  problems.sort((a, b) => a.id.localeCompare(b.id));
  return { concepts, problems };
}

/** Every `.md` under the bundle root, bundle-relative, dot-directories skipped. */
export async function listMarkdownFiles(bundle: Bundle): Promise<string[]> {
  const glob = new Bun.Glob("**/*.md");
  const out: string[] = [];
  for await (const rel of glob.scan({ cwd: bundle.root, onlyFiles: true, dot: false })) {
    const normalized = rel.split(/[\\/]/).join("/");
    if (normalized.split("/").some((segment) => segment.startsWith("."))) continue;
    out.push(normalized);
  }
  return out.sort();
}

export interface DirectoryEntry {
  id: string;
  frontmatter: Record<string, unknown>;
}

export interface DirectoryListing {
  dirId: string;
  concepts: DirectoryEntry[];
  /** Immediate subdirectory IDs. */
  groups: string[];
  hasIndex: boolean;
  hasLog: boolean;
}

/** One directory level — what `index.md` describes and what `okf_list` returns. */
export async function listDirectory(bundle: Bundle, dirId: string): Promise<DirectoryListing> {
  const abs = dirPath(bundle, dirId);
  let dirents;
  try {
    dirents = await readdir(abs, { withFileTypes: true });
  } catch {
    // A bundle whose root does not exist yet is empty, not broken — an agent's
    // first call is often a list, before anything has been written.
    if (dirId === "") return { dirId, concepts: [], groups: [], hasIndex: false, hasLog: false };
    throw new Error(`No such group "${dirId}" in this bundle`);
  }

  const concepts: DirectoryEntry[] = [];
  const groups: string[] = [];
  let hasIndex = false;
  let hasLog = false;

  for (const entry of dirents) {
    if (entry.name.startsWith(".")) continue;
    const childId = dirId === "" ? entry.name : `${dirId}/${entry.name}`;
    if (entry.isDirectory()) {
      groups.push(childId);
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    if (entry.name === INDEX_FILENAME) {
      hasIndex = true;
      continue;
    }
    if (entry.name === LOG_FILENAME) {
      hasLog = true;
      continue;
    }
    const id = childId.slice(0, -3);
    try {
      const { frontmatter } = parseDocument(await Bun.file(join(abs, entry.name)).text());
      concepts.push({ id, frontmatter: frontmatter ?? {} });
    } catch {
      concepts.push({ id, frontmatter: {} });
    }
  }

  concepts.sort((a, b) => a.id.localeCompare(b.id));
  groups.sort();
  return { dirId, concepts, groups, hasIndex, hasLog };
}

/** Concepts in a directory and everything beneath it. */
export async function countConcepts(bundle: Bundle, dirId: string): Promise<number> {
  const listing = await listDirectory(bundle, dirId);
  let count = listing.concepts.length;
  for (const group of listing.groups) count += await countConcepts(bundle, group);
  return count;
}

/** Whether a directory (or anything beneath it) still holds a concept. */
export async function hasConcepts(bundle: Bundle, dirId: string): Promise<boolean> {
  const abs = dirPath(bundle, dirId);
  try {
    if (!(await stat(abs)).isDirectory()) return false;
  } catch {
    return false;
  }
  const glob = new Bun.Glob("**/*.md");
  for await (const rel of glob.scan({ cwd: abs, onlyFiles: true, dot: false })) {
    const name = posix.basename(rel.split(/[\\/]/).join("/"), ".md");
    if (!(RESERVED_BASENAMES as readonly string[]).includes(name)) return true;
  }
  return false;
}
