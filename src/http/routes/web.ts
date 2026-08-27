// Serving the built web app.
//
// In development Vite serves web/ on :5173 and proxies /api here, and this
// route does nothing because there is no build to serve. It matters once the
// app is installed: a home-screen icon or a dock app points at one origin and
// expects it to answer on its own, with no dev server running behind it. That
// origin is this one.
//
// So: `bun run build:web`, then `bun start --no-web`, and :3000 is the whole
// app. Without a build the route is not mounted at all — a 404 from the API is
// a better answer than an empty page pretending to be the UI.
import { Elysia } from "elysia";
import { join, normalize } from "node:path";

/**
 * How long a file may be held.
 *
 * Vite fingerprints everything under assets/, so those URLs can never mean a
 * different file and are held for a year. Nothing else is: the document names
 * the current bundle and the worker decides when a new one is picked up, so a
 * cached copy of either is an app that cannot be updated. That is the one cache
 * header here worth getting right — the rest is only speed.
 */
function cacheFor(path: string): string {
  if (path.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (path === "/sw.js" || path === "/index.html" || path === "/") return "no-cache";
  return "public, max-age=3600";
}

/** Everything the API owns. A file in the build must never answer for one. */
const RESERVED = ["/api", "/health", "/openapi", "/agents", "/messages", "/safety", "/screenshots", "/tasks"];

const isReserved = (path: string) => RESERVED.some((base) => path === base || path.startsWith(`${base}/`));

/**
 * Static files from `dist`, with the document as the fallback.
 *
 * The fallback is what makes it a single-page app: the browser may ask for any
 * path inside the scope — a deep link, a service worker's navigation preload —
 * and the answer is always the document, which then draws whatever that path
 * means. Only for navigations, though; a missing asset stays a 404 rather than
 * becoming an HTML page with a JavaScript content type.
 */
export function createWebRoutes(dist: string) {
  const index = Bun.file(join(dist, "index.html"));

  return new Elysia({ name: "routes.web" }).get("/*", async ({ request, path, set }) => {
    if (isReserved(path)) {
      set.status = 404;
      return { error: `No route ${path}` };
    }

    // Resolve inside dist and nowhere else: `normalize` collapses the `..` that
    // would otherwise walk out of it, and the prefix check is what refuses.
    const resolved = normalize(join(dist, path === "/" ? "/index.html" : path));
    if (!resolved.startsWith(dist)) {
      set.status = 403;
      return { error: "No" };
    }

    const file = Bun.file(resolved);
    if (await file.exists()) {
      set.headers["cache-control"] = cacheFor(path);
      return file;
    }

    // Not a file. If a browser is asking for a page, give it the app.
    if (request.headers.get("accept")?.includes("text/html")) {
      set.headers["cache-control"] = "no-cache";
      return index;
    }

    set.status = 404;
    return { error: `Nothing at ${path}` };
  });
}

/** The build, if there is one. Null is the ordinary case in development. */
export async function findWebBuild(root: string): Promise<string | null> {
  const dist = normalize(join(root, "web", "dist"));
  return (await Bun.file(join(dist, "index.html")).exists()) ? dist : null;
}
