// index.md generation (§8).
//
// Index files are never authored by an agent. They are regenerated from
// sibling frontmatter on every mutation, which is what keeps progressive
// disclosure honest: an index cannot drift from the directory it describes if
// nothing can write it by hand.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as posix from "node:path/posix";
import { INDEX_FILENAME, dirPath, titleFromId, writeFileAtomic, type Bundle } from "./bundle";
import { parseDocument } from "./concept";
import { dumpYaml } from "./yaml";
import { countConcepts, listDirectory, type DirectoryListing } from "./scan";
import { statusOf } from "./trust";

export const OKF_VERSION = "0.2";

export function renderIndex(listing: DirectoryListing, isRoot: boolean): string {
  const lines: string[] = [];

  if (listing.concepts.length > 0) {
    lines.push("# Concepts", "");
    for (const { id, frontmatter } of listing.concepts) {
      const title = typeof frontmatter.title === "string" ? frontmatter.title : titleFromId(id);
      const description =
        typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
      const deprecated = statusOf(frontmatter) === "deprecated" ? " (deprecated)" : "";
      const suffix = description || deprecated ? ` - ${description}${deprecated}` : "";
      lines.push(`* [${title}](${posix.basename(id)}.md)${suffix}`);
    }
    lines.push("");
  }

  if (listing.groups.length > 0) {
    lines.push("# Groups", "");
    for (const group of listing.groups) {
      const name = posix.basename(group);
      lines.push(`* [${name}](${name}/)`);
    }
    lines.push("");
  }

  const body = lines.join("\n").trim();
  // Only a bundle-root index.md may carry frontmatter, and only to declare the
  // format version (§8, §12).
  if (!isRoot) return `${body}\n`;
  return `---\n${dumpYaml({ okf_version: OKF_VERSION })}---\n\n${body}\n`;
}

/**
 * Rewrite one directory's `index.md`, or remove it when the directory no
 * longer has anything to list.
 */
export async function regenerateIndex(bundle: Bundle, dirId: string): Promise<void> {
  const path = join(dirPath(bundle, dirId), INDEX_FILENAME);
  let listing: DirectoryListing;
  try {
    listing = await listDirectory(bundle, dirId);
  } catch {
    return; // directory is gone (pruned by a move) — nothing to index
  }

  // A directory holding only reference material (§6.3) is not a group, and an
  // index that advertised it would send a reader somewhere with nothing to read.
  const groups: string[] = [];
  for (const group of listing.groups) {
    if ((await countConcepts(bundle, group)) > 0) groups.push(group);
  }
  listing = { ...listing, groups };

  if (listing.concepts.length === 0 && listing.groups.length === 0) {
    await rm(path, { force: true });
    return;
  }

  const next = renderIndex(listing, dirId === "");
  const current = await readIfExists(path);
  if (current === next) return; // no churn, no needless git diff
  await writeFileAtomic(path, next);
}

/** Regenerate a directory and every ancestor up to the bundle root. */
export async function regenerateIndexChain(bundle: Bundle, dirId: string): Promise<void> {
  let current = dirId;
  for (;;) {
    await regenerateIndex(bundle, current);
    if (current === "") return;
    const parent = posix.dirname(current);
    current = parent === "." ? "" : parent;
  }
}

/** The declared format version from a bundle-root index.md, if any (§12). */
export async function declaredVersion(bundle: Bundle): Promise<string | undefined> {
  const text = await readIfExists(join(bundle.root, INDEX_FILENAME));
  if (text === undefined) return undefined;
  const { frontmatter } = parseDocument(text);
  const version = frontmatter?.okf_version;
  return typeof version === "string" ? version : undefined;
}

async function readIfExists(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : undefined;
}
