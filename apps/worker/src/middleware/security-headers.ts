import type { MiddlewareHandler } from "hono";

import type { AppBindings } from "../env";
import { readSetCookieHeaders } from "../lib/http";

/**
 * Baseline response headers (requirements §13).
 *
 * The API is a pure JSON surface, so it gets the most restrictive policy
 * possible: `default-src 'none'` plus `sandbox`. The application shell (HTML)
 * needs a different, still-strict policy that accommodates external HTTPS
 * images, iframes, Mermaid and KaTeX; that policy is added in P6 together with
 * the asset-serving route, and this middleware only ever *adds* headers, so it
 * cannot weaken the shell policy.
 *
 * `frame-ancestors 'none'` / `X-Frame-Options: DENY` prevent our own pages from
 * being framed. Requirement §12's iframe support is about embedding *others*
 * (governed by `frame-src` in the shell policy), not about being embedded.
 */
const COMMON_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy":
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
};

const API_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox",
  "cache-control": "no-store",
};

export function securityHeaders(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    await next();

    const response = c.res;
    const headers = new Headers(response.headers);

    // Rebuilding a Response copies only the iterable headers, and `Set-Cookie`
    // is not among them: without this loop every session cookie would be
    // dropped between the handler and the client.
    for (const cookie of readSetCookieHeaders(response.headers)) {
      headers.append("set-cookie", cookie);
    }

    for (const [name, value] of Object.entries(COMMON_HEADERS)) {
      headers.set(name, value);
    }
    if (new URL(c.req.url).pathname.startsWith("/api/")) {
      for (const [name, value] of Object.entries(API_HEADERS)) {
        headers.set(name, value);
      }
    }
    // HSTS only where it is meaningful: a real HTTPS deployment. Sending it in
    // local development would break the plain-HTTP dev server.
    if (c.env.ENVIRONMENT === "production") {
      headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    }

    c.res = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
