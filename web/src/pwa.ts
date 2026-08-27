// Installing the app.
//
// Registration is production-only on purpose. A service worker in front of the
// Vite dev server serves yesterday's modules to a page that is being hot-
// reloaded, and the failure looks like a bug in whatever you were editing
// rather than like a stale cache. `bun run build:web` is where it starts.
//
// Nothing here prompts. Chrome's install prompt and Safari's Add to Dock are
// both browser affordances, and an agent that asks to be installed the first
// time you open it is doing the thing this product's whole voice is against.

/** Register the shell cache, if this build has one and this browser does too. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;

  // After load, so the registration never competes with the first paint for
  // bandwidth — the app is useless until the bundle and the first read land.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
      // Not fatal, and not worth a notice on the screen: the app works, it just
      // will not open without the network and cannot be installed.
      console.warn("service worker registration failed", error);
    });
  });
}
