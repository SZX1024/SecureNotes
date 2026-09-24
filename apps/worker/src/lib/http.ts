import {
  publicMessageFor,
  type ApiFailure,
  type ApiSuccess,
  type ErrorCode,
} from "@securenotes/shared";
import type { Context } from "hono";

import type { AppBindings } from "../env";

/**
 * HTTP status for each stable error code. Kept server-side on purpose: the
 * client only has to branch on `error.code`.
 */
const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  METHOD_NOT_ALLOWED: 405,
  NOT_FOUND: 404,
  CSRF_FAILED: 403,
  ORIGIN_REJECTED: 403,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TOTP_REQUIRED: 401,
  RATE_LIMITED: 429,
  FORBIDDEN: 403,
  CONFLICT: 409,
  REVISION_CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  INTERNAL: 500,
};

export function statusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function jsonOk<T>(data: T, status = 200): Response {
  const body: ApiSuccess<T> = { ok: true, data };
  return jsonResponse(body, status);
}

/**
 * Build a failure response from a closed set of codes. `diagnostic` is dropped
 * unless the worker runs in development, so a production response can never
 * carry a stack trace, SQL fragment or secret (requirements §14, §33.4).
 */
export function jsonFail(c: Context<AppBindings>, code: ErrorCode, diagnostic?: string): Response {
  const body: ApiFailure = {
    ok: false,
    error: { code, message: publicMessageFor(code) },
  };
  if (diagnostic !== undefined && c.env.ENVIRONMENT === "development") {
    body.error.diagnostic = diagnostic;
  }
  return jsonResponse(body, statusFor(code));
}
