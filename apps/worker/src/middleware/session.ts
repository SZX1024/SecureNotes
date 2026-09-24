import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from "@securenotes/shared";
import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";

import type { AppBindings } from "../env";
import { ApiError } from "../lib/api-error";
import { findSessionByToken, touchSession, verifyCsrfToken } from "../services/sessions";
import { isUnsafeMethod } from "./guards";

/**
 * Authentication and CSRF middleware (§4, §14).
 *
 * Every failure that means "your session is not usable" produces
 * `UNAUTHENTICATED`, which is the signal the client acts on by discarding its
 * cached key material and returning to authentication (§4). That is deliberate:
 * a single fail-closed signal cannot be confused with a recoverable error.
 */

/** Loads the session when a cookie is present, without requiring one. */
export function attachSession(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE_NAME);
    if (token) {
      const now = Date.now();
      const found = await findSessionByToken(c.env, token, now);
      if (found) {
        // The sliding window is only persisted past a small threshold (§4).
        const session = await touchSession(c.env, found, now);
        c.set("session", {
          id: session.id,
          userId: session.userId,
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt,
          expiresAt: session.expiresAt,
          rememberDevice: session.rememberDevice,
        });
      }
    }
    await next();
  };
}

/** Requires a usable session; otherwise `UNAUTHENTICATED`. */
export function requireSession(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (!c.get("session")) {
      throw new ApiError("UNAUTHENTICATED");
    }
    await next();
  };
}

/**
 * CSRF check for state-changing requests (§14).
 *
 * The submitted header must match the HMAC token derived from the current
 * session, so a token is only ever valid for the session it was issued to. The
 * header is required: treating the cookie alone as proof would reduce this to
 * the SameSite attribute and add nothing. Safe methods are exempt because they
 * must not change state.
 */
export function requireCsrf(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (!isUnsafeMethod(c.req.method)) {
      await next();
      return;
    }

    const session = c.get("session");
    if (!session) {
      throw new ApiError("UNAUTHENTICATED");
    }

    const submitted = c.req.header(CSRF_HEADER_NAME) ?? null;
    if (!(await verifyCsrfToken(c.env, session.id, submitted))) {
      throw new ApiError("CSRF_FAILED", { diagnostic: "csrf token mismatch" });
    }

    await next();
  };
}
