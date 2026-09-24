/**
 * Service worker for the installed app.
 *
 * Two rules, both learned the hard way:
 *
 * 1. **Never cache application code with cache-first.** A cache-first rule for every
 *    same-origin request meant that when the dev server re-optimised its dependencies and
 *    module URLs changed, the worker kept serving the old modules — so the lazily imported
 *    renderer never loaded and the preview never appeared, with nothing in any terminal to
 *    explain it. Module code is fetched from the network; the cache is only a fallback.
 * 2. **Never touch the API.** Those responses carry session cookies and ciphertext, and a
 *    cached one would be served to a different session.
 *
 * The worker also stays inactive until the page asks it to take over, so an update cannot swap
 * code underneath a running editor.
 */

const CACHE_NAME = "securenotes-shell-v3";

/** Precached because they are small, static and needed before anything else loads. */
const SHELL = ["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

/** Development server paths. Caching these is what broke the preview. */
const NEVER_CACHE = ["/src/", "/@vite/", "/@id/", "/@fs/", "/node_modules/", "/sw.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL).catch(() => undefined)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
      );
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") {
    void self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return;
  }
  // The API is never cached, and never served from a cache.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }
  // Module code and the dev server are always fetched; a stale module is worse than no cache.
  if (NEVER_CACHE.some((prefix) => url.pathname.startsWith(prefix))) {
    return;
  }

  event.respondWith(
    (async () => {
      try {
        // Network first: the network is the truth, the cache is only what makes offline work.
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          const cache = await caches.open(CACHE_NAME);
          void cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        const cached = await caches.match(request);
        if (cached) {
          return cached;
        }
        // A navigation that cannot reach the network falls back to the shell, which is what
        // makes a previously loaded app openable offline.
        if (request.mode === "navigate") {
          const shell = await caches.match("/index.html");
          if (shell) {
            return shell;
          }
        }
        throw error;
      }
    })(),
  );
});
