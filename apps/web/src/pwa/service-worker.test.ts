import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * Service worker policy (§21, §22).
 *
 * This is a static audit rather than an execution test, because the failure it guards against is
 * a policy in the worker's own source: an earlier version cached every same-origin request with
 * cache-first, so when the dev server re-optimised its dependencies and module URLs changed, the
 * worker kept serving stale modules. The lazily imported renderer never loaded, the preview never
 * appeared, and nothing in any terminal said why.
 */

const source = readFileSync("public/sw.js", "utf8");

/** The body of the fetch handler, which is where caching policy lives. */
const fetchHandler = source.slice(source.indexOf('addEventListener("fetch"'));

describe("the worker never stands between the page and its modules", () => {
  it("does not cache application code with cache-first", () => {
    // Cache-first for everything is exactly the bug.
    expect(source).not.toMatch(
      /respondWith\(caches\.match\(request\)\.then\(\(cached\) => cached \?\? fetch/,
    );
    // The network is tried first in the handler that does caching.
    expect(fetchHandler).toContain("await fetch(request)");
  });

  it("ignores the development server's module paths entirely", () => {
    for (const prefix of ["/src/", "/@vite/", "/node_modules/", "/sw.js"]) {
      expect(source, prefix).toContain(prefix);
    }
    expect(source).toContain("NEVER_CACHE");
  });

  it("never touches the API", () => {
    expect(source).toContain('url.pathname.startsWith("/api/")');
    expect(source).not.toContain("cache.put(new Request");
  });

  it("keeps the offline fallback for navigations", () => {
    expect(source).toContain('request.mode === "navigate"');
    expect(source).toContain("/index.html");
  });

  it("activates only when the page asks it to", () => {
    // An update must not swap code underneath a running editor, so the install and activate
    // handlers must not take over on their own — only the message handler may.
    const section = (name: string, next: string) =>
      source.slice(
        source.indexOf(`addEventListener("${name}"`),
        source.indexOf(`addEventListener("${next}"`),
      );

    expect(section("install", "activate")).not.toContain("skipWaiting");
    expect(section("activate", "message")).not.toContain("skipWaiting");

    // And the page-driven path exists, gated on the message the app sends.
    const messageHandler = section("message", "fetch");
    expect(messageHandler).toContain("skip-waiting");
    expect(messageHandler).toContain("skipWaiting");
  });
});

describe("registration is for the built app only", () => {
  it("returns null without touching the browser in development", async () => {
    const register = vi.fn();
    vi.stubGlobal("navigator", { serviceWorker: { register } });

    try {
      const { registerServiceWorker } = await import("./register");
      const result = await registerServiceWorker({ countPendingChanges: async () => 0 });

      // jsdom reports no service worker, and the dev guard returns null regardless — either way
      // nothing may be registered here, because that is what broke the preview.
      expect(result).toBeNull();
      expect(register).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
