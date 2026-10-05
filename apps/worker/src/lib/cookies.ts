import { CSRF_COOKIE_NAME, REMEMBER_DEVICE_MAX_MS, SESSION_COOKIE_NAME } from "@securenotes/shared";
import { serialize } from "hono/utils/cookie";

/**
 * Session and CSRF cookies (§4, §14).
 *
 * Cookies are appended to the `Response` the handler returns rather than set
 * through the Hono context. `setCookie(c, …)` writes to the context's own
 * response, and a handler that returns a freshly built `Response` — which is
 * what `jsonOk` does — silently loses them. Attaching them to the response that
 * actually goes out removes that failure mode entirely.
 *
 * The session cookie is HttpOnly, so script cannot read the bearer token; the
 * CSRF cookie is readable by design because the client echoes it in a header.
 * Both are Secure and SameSite=Strict, which is the third layer of CSRF defence
 * after the token and the Origin check.
 *
 * A remembered device gets a persistent cookie capped at 30 days; any other
 * session gets a cookie bounded by the 40-minute idle window, which is why
 * closing the browser returns the user to TOTP (§4: remember-device never
 * bypasses TOTP).
 */

export interface SessionCookieInput {
  token: string;
  csrfToken: string;
  rememberDevice: boolean;
}

function maxAgeSeconds(rememberDevice: boolean): number | undefined {
  return rememberDevice ? Math.floor(REMEMBER_DEVICE_MAX_MS / 1000) : undefined;
}

export function applySessionCookies(response: Response, input: SessionCookieInput): Response {
  const maxAge = maxAgeSeconds(input.rememberDevice);

  response.headers.append(
    "set-cookie",
    serialize(SESSION_COOKIE_NAME, input.token, {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
      ...(maxAge !== undefined ? { maxAge } : {}),
    }),
  );
  response.headers.append(
    "set-cookie",
    serialize(CSRF_COOKIE_NAME, input.csrfToken, {
      httpOnly: false,
      secure: true,
      sameSite: "Strict",
      path: "/",
      ...(maxAge !== undefined ? { maxAge } : {}),
    }),
  );

  return response;
}

/** Expires both cookies, e.g. after logout or revoke-all. */
export function applyClearedSessionCookies(response: Response): Response {
  const cleared = { secure: true, sameSite: "Strict", path: "/", maxAge: 0 } as const;

  response.headers.append(
    "set-cookie",
    serialize(SESSION_COOKIE_NAME, "", { ...cleared, httpOnly: true }),
  );
  response.headers.append(
    "set-cookie",
    serialize(CSRF_COOKIE_NAME, "", { ...cleared, httpOnly: false }),
  );

  return response;
}
