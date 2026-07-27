// Cross-links (§6): extraction, resolution, and rewriting on move.
//
// Move is the only operation that can break the bundle graph — a concept ID is
// its path (§2), so relocating a file invalidates every inbound link unless
// they are rewritten in the same operation. That is the whole reason move is
// its own tool rather than a field on patch.
import * as posix from "node:path/posix";
import { parentDirId } from "./bundle";

export type LinkKind = "concept" | "directory" | "external" | "unresolved";

export interface ExtractedLink {
  text: string;
  /** The raw link target, exactly as written. */
  target: string;
  /** Character offset of `target` within the body. */
  offset: number;
}

export interface ResolvedLink extends ExtractedLink {
  kind: LinkKind;
  /** Concept ID the link points at, when `kind === "concept"`. */
  id?: string;
  /** Directory ID, when `kind === "directory"`. */
  dirId?: string;
  fragment?: string;
}

// Inline markdown links, excluding images (`![alt](src)`) — an embedded image
// is not a relationship between concepts. Footnote refs/defs (`[^id]`,
// `[^id]: ...`) never match because they are not followed by `(`.
const LINK_RE = /(!)?\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export function extractLinks(body: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINK_RE.exec(body)) !== null) {
    if (match[1] === "!") continue; // image
    const rawTarget = match[3] ?? "";
    const target = rawTarget.startsWith("<") ? rawTarget.slice(1, -1) : rawTarget;
    links.push({
      text: match[2] ?? "",
      target,
      offset: match.index + match[0].indexOf(rawTarget),
    });
  }
  return links;
}

/** Resolve a link target relative to the concept that contains it. */
export function resolveLink(fromId: string, link: ExtractedLink): ResolvedLink {
  const { target } = link;
  if (target === "" || target.startsWith("#")) return { ...link, kind: "external" };
  if (SCHEME_RE.test(target) || target.startsWith("//")) return { ...link, kind: "external" };

  const hashIndex = target.indexOf("#");
  const fragment = hashIndex === -1 ? undefined : target.slice(hashIndex + 1);
  const pathPart = hashIndex === -1 ? target : target.slice(0, hashIndex);

  // Resolved by hand rather than with posix.normalize, which silently *clamps*
  // `../../../x.md` to the root — turning a link that escapes the bundle into a
  // link to a different, real concept. An escape must stay unresolved.
  const base = pathPart.startsWith("/") ? [] : parentDirId(fromId).split("/").filter(Boolean);
  const segments = [...base, ...pathPart.split("/")];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      resolved.push(segment);
      continue;
    }
    if (resolved.length === 0) return { ...link, kind: "unresolved", fragment };
    resolved.pop();
  }

  const trimmed = resolved.join("/");
  if (pathPart.endsWith("/") || trimmed === "") {
    return { ...link, kind: "directory", dirId: trimmed.replace(/\/$/, ""), fragment };
  }
  if (!trimmed.toLowerCase().endsWith(".md")) return { ...link, kind: "unresolved", fragment };
  return { ...link, kind: "concept", id: trimmed.slice(0, -3), fragment };
}

export function conceptLinks(fromId: string, body: string): ResolvedLink[] {
  return extractLinks(body).map((link) => resolveLink(fromId, link));
}

/** Whether `body` (belonging to `fromId`) links to any of `targets`. */
export function linksTo(fromId: string, body: string, targets: Set<string>): boolean {
  return conceptLinks(fromId, body).some((l) => l.kind === "concept" && !!l.id && targets.has(l.id));
}

export interface RewriteOptions {
  /** The concept's ID before the move — link targets resolve against this. */
  sourceIdBefore: string;
  /** The concept's ID after the move. Same as `sourceIdBefore` for bystanders. */
  sourceIdAfter: string;
  /** old concept ID -> new concept ID. */
  moves: ReadonlyMap<string, string>;
}

/**
 * Rewrite concept links in a body.
 *
 * Link *form* is preserved: an absolute (`/a/b.md`) link stays absolute, a
 * relative one stays relative and is recomputed from the concept's new
 * location — which is why a moved file's own relative links are rewritten even
 * when their targets did not move.
 */
export function rewriteLinks(body: string, opts: RewriteOptions): string {
  const { sourceIdBefore, sourceIdAfter, moves } = opts;
  const moved = sourceIdBefore !== sourceIdAfter;
  let out = "";
  let cursor = 0;

  for (const link of extractLinks(body)) {
    const resolved = resolveLink(sourceIdBefore, link);
    if (resolved.kind !== "concept" || !resolved.id) continue;

    const newId = moves.get(resolved.id) ?? resolved.id;
    const isAbsolute = link.target.startsWith("/");
    if (newId === resolved.id && (isAbsolute || !moved)) continue; // nothing to restate

    const fragment = resolved.fragment === undefined ? "" : `#${resolved.fragment}`;
    const replacement = isAbsolute
      ? `/${newId}.md${fragment}`
      : `${relativeTarget(sourceIdAfter, newId)}${fragment}`;
    if (replacement === link.target) continue;

    out += body.slice(cursor, link.offset) + replacement;
    cursor = link.offset + link.target.length;
  }
  return out + body.slice(cursor);
}

/** Relative link from one concept to another, always prefixed so it reads as a path. */
export function relativeTarget(fromId: string, toId: string): string {
  const fromDir = parentDirId(fromId);
  const rel = posix.relative(fromDir === "" ? "." : fromDir, `${toId}.md`);
  return rel.startsWith(".") ? rel : `./${rel}`;
}
