// Rasterise the app icons from web/public/icon.svg.
//
// Home screens and docks want PNG. iOS will not take an SVG for
// `apple-touch-icon` at all, and the platforms that accept one in a manifest
// still render a PNG better at 60px. So the SVG is the source and these are
// built from it — checked in, because installing the app must not depend on
// anyone having run a build step first.
//
// `maskable` is a second drawing rather than a second size. Android and macOS
// crop an icon to their own shape and only guarantee the middle 80%, so the
// mark is smaller in that one; feeding them the full-bleed icon would cut the
// wire off. See web/public/icon-maskable.svg.
//
// Rendering is sharp's, which is in the tree already. If it ever leaves, this
// script is what breaks — the icons it produced are committed and keep working.
import { dirname, join } from "node:path";
// Declared in ./sharp.d.ts — the package hides its own types behind its
// exports map, so the three calls made here are named there instead.
import sharp from "sharp";

const root = dirname(import.meta.dir);
const publicDir = join(root, "web", "public");

/** What each PNG is for, so a size is never changed without knowing what reads it. */
const WANTED: readonly { from: string; to: string; size: number; why: string }[] = [
  { from: "icon.svg", to: "apple-touch-icon.png", size: 180, why: "iOS home screen, and Safari's Add to Dock on a Mac" },
  { from: "icon.svg", to: "icon-192.png", size: 192, why: "the smallest a manifest may offer and still be installable" },
  { from: "icon.svg", to: "icon-512.png", size: 512, why: "install prompts, task switchers, the About window" },
  { from: "icon-maskable.svg", to: "icon-maskable-512.png", size: 512, why: "platforms that crop the icon to their own shape" },
];

// The SVG has no intrinsic pixel density; without this the strokes on the inner
// rings alias badly at 180px. 384dpi renders the 512pt artwork at 2048px first.
const DENSITY = 384;

for (const { from, to, size, why } of WANTED) {
  const source = Buffer.from(await Bun.file(join(publicDir, from)).arrayBuffer());
  await sharp(source, { density: DENSITY })
    .resize(size, size, { fit: "cover" })
    .png({ compressionLevel: 9 })
    .toFile(join(publicDir, to));
  const bytes = Bun.file(join(publicDir, to)).size;
  console.log(`${to.padEnd(24)} ${size}×${size}  ${String(bytes).padStart(6)} bytes  — ${why}`);
}
