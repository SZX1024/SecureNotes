import {
  API_PREFIX,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  type ApiFailure,
  type ErrorCode,
  type HealthPayload,
  isErrorCode,
  publicMessageFor,
} from "@securenotes/shared";

/** Transport-level failures mapped onto the shared, closed error-code set. */
const STATUS_FALLBACK: Readonly<Record<number, ErrorCode>> = {
  400: "BAD_REQUEST",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  412: "PRECONDITION_FAILED",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "RATE_LIMITED",
};

/**
 * An API failure the UI can branch on. `message` is taken from the local
 * message table, never from the response body, so no server-supplied text can
 * end up rendered in the DOM.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly diagnostic: string | undefined;

  constructor(code: ErrorCode, status: number, diagnostic?: string) {
    super(publicMessageFor(code));
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.diagnostic = diagnostic;
  }
}

function isFailureBody(value: unknown): value is ApiFailure {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { ok?: unknown; error?: unknown };
  if (candidate.ok !== false) return false;
  if (typeof candidate.error !== "object" || candidate.error === null) return false;
  return isErrorCode((candidate.error as { code?: unknown }).code);
}

function isSuccessBody(value: unknown): value is { ok: true; data: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === true &&
    "data" in value
  );
}

/** Reads the double-submit CSRF token; absent until a session is established. */
function readCsrfToken(): string | null {
  const pattern = new RegExp(`(?:^|; )${CSRF_COOKIE_NAME}=([^;]*)`);
  const match = pattern.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Same-origin, cookie-authenticated JSON request (§14). Never enables CORS and
 * never sends credentials cross-origin.
 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers({ accept: "application/json" });
  if (!SAFE_METHODS.has(method)) {
    const token = readCsrfToken();
    if (token !== null) headers.set(CSRF_HEADER_NAME, token);
  }
  const init: RequestInit = { method, headers, credentials: "same-origin" };
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(options.body);
  }
  if (options.signal !== undefined) init.signal = options.signal;

  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, init);
  } catch {
    throw new ApiError("INTERNAL", 0, "network request failed");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(STATUS_FALLBACK[response.status] ?? "INTERNAL", response.status);
  }

  if (isFailureBody(payload)) {
    throw new ApiError(payload.error.code, response.status, payload.error.diagnostic);
  }
  if (!response.ok || !isSuccessBody(payload)) {
    throw new ApiError(STATUS_FALLBACK[response.status] ?? "INTERNAL", response.status);
  }
  return payload.data as T;
}

export function fetchHealth(signal?: AbortSignal): Promise<HealthPayload> {
  return apiRequest<HealthPayload>("/health", { signal });
}
