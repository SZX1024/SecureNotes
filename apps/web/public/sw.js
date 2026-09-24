/*
 * SecureNotes service worker (requirements §21).
 *
 * Two responsibilities, deliberately kept small:
 *   1. serve the application shell offline, so the app opens without a network;
 *   2. never activate a new version on its own — the page decides, because only
 *      the page can see whether unsynced changes are still queued.
 *
 * The API is never cached. Responses under /api carry ciphertext and session
 * state, and a stale cached response there would be both wrong and a privacy
 * problem, so those requests always go to the network.
 */

const CACHE_NAME = "securenotes-shell-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  // Note the absence of skipWaiting(): the new worker parks in "waiting" until
  // the page sends the activation message.
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
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "securenotes:skip-waiting") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    // Same-origin API traffic is never cached; cross-origin is left alone.
    return;
  }

  // Navigations fall back to the cached shell so a deep link works offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match("/index.html")) ?? Response.error()),
    );
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
});
