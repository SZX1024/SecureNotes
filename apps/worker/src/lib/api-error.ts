import type { ErrorCode } from "@securenotes/shared";

/**
 * An error that already carries the stable public code the client will see.
 *
 * Handlers throw these instead of building responses, so a validation or
 * precondition failure cannot accidentally leak a message: `onError` maps the
 * code to the frozen generic sentence (requirements §14) and drops everything
 * else. `diagnostic` is a separate, explicit field — never the Error message —
 * so an internal string can only be exposed if a developer deliberately opted
 * in, and even then only in development.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  /** Development-only detail. Never derived from the error message. */
  readonly diagnostic?: string;
  /** Extra response headers, e.g. `Retry-After` on RATE_LIMITED. */
  readonly headers: Record<string, string>;

  constructor(
    code: ErrorCode,
    options: { diagnostic?: string; headers?: Record<string, string> } = {},
  ) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.diagnostic = options.diagnostic;
    this.headers = options.headers ?? {};
  }
}

/** Throws `RATE_LIMITED` with the seconds the client should wait. */
export function rateLimited(retryAfterSeconds: number): ApiError {
  return new ApiError("RATE_LIMITED", {
    headers: { "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  });
}
