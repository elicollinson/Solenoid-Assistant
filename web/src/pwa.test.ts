// Whether this thing can actually be installed.
//
// Every part of that answer is a string in one file agreeing with a filename in
// another: the manifest names icons, the document names the manifest and a
// separate Apple-only icon, and the worker names what it precaches. Nothing
// type-checks any of it and no screen goes red when it breaks — the app simply
// stops offering to install, or installs with a blank square, and the first
// person to notice is whoever tries to add it to a home screen.
//
// So the checks here are deliberately literal: the file that is named exists,
// and the sizes a platform requires are the sizes actually present.
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

const web = dirname(import.meta.dir);
const publicDir = join(web, "public");
const read = (path: string) => Bun.file(join(publicDir, path)).text();

const manifest = (await Bun.file(join(publicDir, "manifest.webmanifest")).json()) as {
  id: string;
  name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};

const html = await Bun.file(join(web, "index.html")).text();

describe("the manifest", () => {
  test("asks to be a window rather than a tab", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    // Chrome keys an installed app by `id`; letting it default to start_url
    // means changing start_url later installs a second copy alongside the first.
    expect(manifest.id).toBe("/");
  });

  test("names a colour for the surround the OS paints", () => {
    for (const colour of [manifest.theme_color, manifest.background_color]) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test("offers the two sizes a browser needs before it will offer to install", () => {
    const any = manifest.icons.filter((i) => i.purpose === "any" && i.type === "image/png");
    expect(any.map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
  });

  test("offers a maskable icon, for the platforms that crop to their own shape", () => {
    const maskable = manifest.icons.filter((i) => i.purpose === "maskable");
    expect(maskable.length).toBeGreaterThan(0);
    for (const icon of maskable) expect(icon.type).toBe("image/png");
  });

  test("every icon it names is a file that is there", async () => {
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith("/")).toBe(true);
      const file = Bun.file(join(publicDir, icon.src));
      expect(await file.exists()).toBe(true);
      expect(file.size).toBeGreaterThan(0);
    }
  });

  test("and the PNGs are the sizes they claim", async () => {
    for (const icon of manifest.icons.filter((i) => i.type === "image/png")) {
      const claimed = icon.sizes.split("x").map(Number);
      expect(claimed).toHaveLength(2);
      const bytes = new DataView(await Bun.file(join(publicDir, icon.src)).arrayBuffer());
      // A PNG's IHDR puts width and height at bytes 16 and 20, big-endian.
      expect([bytes.getUint32(16), bytes.getUint32(20)]).toEqual(claimed);
    }
  });
});

describe("the document", () => {
  test("links the manifest", () => {
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
  });

  test("names the Apple icon separately, because iOS reads none of the manifest's", async () => {
    const match = html.match(/rel="apple-touch-icon" href="([^"]+)"/);
    expect(match?.[1]).toBeTruthy();
    expect(await Bun.file(join(publicDir, match?.[1] ?? "")).exists()).toBe(true);
  });

  test("asks iOS for a window and for the status bar to be its own", () => {
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style"');
  });

  test("asks for the insets, without which the tab bar sits under the home indicator", () => {
    // env(safe-area-inset-*) reports 0 unless the viewport covers the display.
    expect(html).toContain("viewport-fit=cover");
  });

  test("gives the surround a colour in both themes", () => {
    expect(html).toContain('media="(prefers-color-scheme: light)"');
    expect(html).toContain('media="(prefers-color-scheme: dark)"');
  });
});

describe("the worker", () => {
  test("precaches only the document, because every other name is hashed per build", async () => {
    const sw = await read("sw.js");
    expect(sw).toContain('const SHELL = ["/"]');
  });

  test("never caches the API", async () => {
    // A cached answer here is last night's overnight report drawn as this
    // morning's. The screens already have honest words for an unreachable
    // server; a stale one they cannot detect at all.
    const sw = await read("sw.js");
    expect(sw).toMatch(/if \(isApi\(url\)\) return;/);
  });

  test("drops caches it did not write, so an old build's files do not accumulate", async () => {
    const sw = await read("sw.js");
    expect(sw).toContain("caches.delete(name)");
  });
});
