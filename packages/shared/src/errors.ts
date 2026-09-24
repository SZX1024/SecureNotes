/**
 * Stable error surface for the REST API (requirements §14).
 *
 * Rules enforced here by design:
 * - every failure has a machine-readable `code` from a closed set;
 * - the client-facing `message` is a fixed, generic sentence per code, so no
 *   stack trace, SQL fragment, secret or plaintext can leak through it;
 * - optional diagnostics travel only in a field the worker strips unless it is
 *   running in development mode.
 */
export const ERROR_CODES = [
  "BAD_REQUEST",
  "VALIDATION_FAILED",
  "UNSUPPORTED_MEDIA_TYPE",
  "PAYLOAD_TOO_LARGE",
  "METHOD_NOT_ALLOWED",
  "NOT_FOUND",
  "CSRF_FAILED",
  "ORIGIN_REJECTED",
  "UNAUTHENTICATED",
  "INVALID_CREDENTIALS",
  "TOTP_REQUIRED",
  "RATE_LIMITED",
  "FORBIDDEN",
  "CONFLICT",
  "REVISION_CONFLICT",
  "PRECONDITION_FAILED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Generic sentences returned to clients. Kept free of any request-derived data.
 */
export const PUBLIC_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  BAD_REQUEST: "The request could not be processed.",
  VALIDATION_FAILED: "The request payload is not valid.",
  UNSUPPORTED_MEDIA_TYPE: "The request content type is not supported.",
  PAYLOAD_TOO_LARGE: "The request payload is too large.",
  METHOD_NOT_ALLOWED: "The HTTP method is not allowed for this endpoint.",
  NOT_FOUND: "The requested resource was not found.",
  CSRF_FAILED: "The request could not be verified.",
  ORIGIN_REJECTED: "The request origin is not allowed.",
  UNAUTHENTICATED: "Authentication is required.",
  INVALID_CREDENTIALS: "The supplied credentials are not valid.",
  TOTP_REQUIRED: "A current authenticator code is required.",
  RATE_LIMITED: "Too many requests. Try again later.",
  FORBIDDEN: "This operation is not permitted.",
  CONFLICT: "The resource changed since it was read.",
  REVISION_CONFLICT: "The resource was modified concurrently.",
  PRECONDITION_FAILED: "The operation is not valid for the current state.",
  INTERNAL: "An internal error occurred.",
});

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  /** Development-mode only. Always absent in production responses. */
  diagnostic?: string;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: ApiErrorBody;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export function publicMessageFor(code: ErrorCode): string {
  return PUBLIC_MESSAGES[code];
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}
