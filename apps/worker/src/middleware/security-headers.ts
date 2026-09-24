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

/**
 * Policy for the application shell (§13).
 *
 * Strict, but not `default-src 'none'`: the app needs to run its own script, draw
 * KaTeX and Mermaid output (which use inline styles), show external HTTPS images,
 * and embed arbitrary HTTPS iframes, which §12 permits as a product feature.
 *
 * What is deliberately absent is any way to execute script that the app did not
 * ship: no `'unsafe-inline'` and no `'unsafe-eval'` in `script-src`, no CDN origin,
 * and `object-src 'none'`. §13 forbids weakening this to permit arbitrary script
 * execution, so an embedded iframe is isolated by its sandbox (§12) rather than by
 * relaxing the policy.
 */
export const SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Inline styles are required for sanitised `style` attributes, KaTeX and Mermaid
  // SVG output. Styles cannot execute script; the values themselves are filtered
  // by the render layer.
  "style-src 'self' 'unsafe-inline'",
  // External images must be HTTPS; `data:` covers inline icons in generated SVG.
  "img-src 'self' https: data:",
  "font-src 'self' data:",
  // The client talks only to its own origin, which is what keeps CORS off.
  "connect-src 'self'",
  // §12: arbitrary HTTPS embeds are a product requirement.
  "frame-src https:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Whether a response is the application shell rather than API JSON. */
export function shellHeadersFor(pathname: string, contentType: string | null): boolean {
  if (pathname.startsWith("/api/")) {
    return false;
  }
  return (contentType ?? "").toLowerCase().includes("text/html");
}

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
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith("/api/")) {
      for (const [name, value] of Object.entries(API_HEADERS)) {
        headers.set(name, value);
      }
    } else if (shellHeadersFor(pathname, headers.get("content-type"))) {
      // The shell is a different security context from the API, so it gets the
      // policy its features require rather than the API's `default-src 'none'`.
      headers.set("content-security-policy", SHELL_CSP);
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
