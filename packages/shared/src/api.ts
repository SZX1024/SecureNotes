import type { ApiResult } from "./errors";

/** All application endpoints live under this prefix (requirements §14). */
export const API_PREFIX = "/api/v1";

/** Session cookie name is frozen by requirements §4. */
export const SESSION_COOKIE_NAME = "session";

/**
 * Double-submit CSRF token: the value is readable by same-origin script and the
 * worker compares it with the server-side session record. The cookie is NOT
 * HttpOnly by design; the session cookie is.
 */
export const CSRF_COOKIE_NAME = "csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

/** Header carrying a per-request correlation id, echoed by the worker. */
export const REQUEST_ID_HEADER = "x-request-id";

export interface HealthPayload {
  status: "ok";
  version: string;
  environment: string;
}

export type HealthResponse = ApiResult<HealthPayload>;
