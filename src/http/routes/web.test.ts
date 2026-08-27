// Serving the built app, and the four ways that goes wrong.
//
// A wildcard route mounted under an API is a route that can shadow it, a file
// server rooted in a directory is a directory that can be escaped from, and a
// single-page app that 404s its own deep links is not installable in any
// meaningful sense. The cache headers are here too, because a held copy of
// `sw.js` is an app that can never be updated again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { createWebRoutes, findWebBuild } from "./web";

let root: string;
// Elysia's type carries every route mounted on it, so annotating this as the
// bare class does not fit what `.use()` returns. Only `handle` is used here.
let app: { handle: (request: Request) => Promise<Response> };

const get = (path: string, headers: Record<string, string> = {}) =>
  app.handle(new Request(`http://localhost${path}`, { headers }));

const asPage = { accept: "text/html,application/xhtml+xml" };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "solenoid-web-"));
  const dist = join(root, "web", "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  await Bun.write(join(dist, "index.html"), "<!doctype html><title>Solenoid</title>");
  await Bun.write(join(dist, "assets", "index-abc123.js"), "console.log(1)");
  await Bun.write(join(dist, "sw.js"), "// worker");
  await Bun.write(join(dist, "manifest.webmanifest"), '{"name":"Solenoid"}');
  // Something outside the build, to be reached for and refused.
  await Bun.write(join(root, "secret.txt"), "not yours");

  const found = await findWebBuild(root);
  if (!found) throw new Error("the fixture build was not found");
  // Mounted under a route of the API's, so the shadowing test is a real one.
  app = new Elysia().get("/api/home", () => ({ ok: true })).use(createWebRoutes(found));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("finding the build", () => {
  test("is null where nobody has run build:web", async () => {
    expect(await findWebBuild(mkdtempSync(join(tmpdir(), "solenoid-nobuild-")))).toBeNull();
  });
});

describe("what it serves", () => {
  test("the document at the root", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Solenoid");
  });

  test("the files an install needs, by name", async () => {
    for (const path of ["/sw.js", "/manifest.webmanifest", "/assets/index-abc123.js"]) {
      expect((await get(path)).status).toBe(200);
    }
  });

  test("a path that is not a file is the app, so a deep link opens it", async () => {
    const response = await get("/things-i-know/okf:contact/ferris", asPage);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Solenoid");
  });

  test("but a missing asset stays missing rather than becoming the document", async () => {
    // Answering an absent script with HTML is how a page ends up reporting a
    // syntax error on line 1 instead of a 404.
    expect((await get("/assets/index-gone.js")).status).toBe(404);
  });
});

describe("what it refuses", () => {
  test("anything the API owns, even though the wildcard would match it", async () => {
    expect((await get("/api/home")).status).toBe(200); // the API's own route answers
    expect((await get("/api/nothing-here", asPage)).status).toBe(404);
    expect((await get("/health", asPage)).status).toBe(404);
    expect((await get("/openapi", asPage)).status).toBe(404);
  });

  test("a path that climbs out of the build", async () => {
    const response = await get("/../secret.txt");
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain("not yours");
  });
});

describe("what may be held, and for how long", () => {
  test("a fingerprinted asset can never mean a different file, so it is held for a year", async () => {
    expect((await get("/assets/index-abc123.js")).headers.get("cache-control")).toContain("immutable");
  });

  test("the document and the worker are never held", async () => {
    // These two are what decide which build is running. A cached copy of either
    // is an app that cannot be updated.
    for (const path of ["/", "/sw.js"]) {
      expect((await get(path)).headers.get("cache-control")).toBe("no-cache");
    }
  });
});
