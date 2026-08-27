// The service worker.
//
// It exists for two reasons and neither of them is offline data. A browser will
// not offer to install an app that cannot answer its own start URL without the
// network, and an installed app that opens to a blank page when the server is
// down is worse than a bookmark. So this caches the shell — the document, the
// bundle, the fonts — and nothing else.
//
// The API is deliberately left alone. This agent's screens say what it did
// overnight and what is still waiting on you; a cached copy of that is a
// yesterday that looks like a today, and the app already has honest words for
// not being able to reach the server ("I couldn't reach the API — …"). A stale
// answer would be a worse failure than a visible one, so /api never touches
// this cache in either direction.

const VERSION = "solenoid-shell-v1";

/**
 * What must be there before the app can draw anything.
 *
 * Only the document. Vite hashes the bundle's filename on every build, so a
 * list of asset URLs written here would be wrong by the next `build:web`;
 * everything else is cached the first time it is asked for, which costs one
 * online load and never goes stale against a name it does not know.
 */
const SHELL = ["/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      // Take over on the next load rather than making the user close the app
      // twice to pick up a new build.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== VERSION).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

/** Whether a request is for live agent data rather than for the shell. */
const isApi = (url) => url.pathname === "/api" || url.pathname.startsWith("/api/");

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (isApi(url)) return; // straight to the network, and a failure stays a failure

  // A navigation is the app being opened. Try the network so a new build is
  // picked up, and fall back to the shell so opening it offline still draws
  // the frame and the screen's own "I couldn't reach the API" notice.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/").then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Everything else — the bundle, the stylesheet, the icons, the fonts — is
  // immutable at its URL, so the cache is the fast path and the network only
  // fills what is missing.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Opaque cross-origin responses (Google Fonts) are cacheable but cannot
        // be inspected; storing them is what makes the app open offline with
        // its own two typefaces rather than in a system fallback.
        if (response.ok || response.type === "opaque") {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
