import { MAX_AUTH_BODY_BYTES, MAX_JSON_BODY_BYTES } from "@securenotes/shared";
import type { Context, MiddlewareHandler } from "hono";
import type { ZodType } from "zod";

import type { AppBindings, Env } from "../env";
import { ApiError } from "../lib/api-error";

/**
 * Request guards (requirements §14): strict Origin/Referer validation, strict
 * Content-Type, and body-size limits.
 *
 * Order matters and is enforced by `app.ts`: origin first (it applies even to
 * requests that will fail authentication), then the body guards, then the
 * session and CSRF checks.
 */

/** Methods that can change state, i.e. those that need CSRF and Origin. */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isUnsafeMethod(method: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase());
}

/** Origins allowed to call the API, from the `ALLOWED_ORIGINS` binding. */
export function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function originOf(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Rejects cross-origin requests.
 *
 * A state-changing request must carry an `Origin` (or a `Referer` when a client
 * omits Origin) that is explicitly allowed — absence is a rejection, not a
 * pass, because every legitimate client here is a browser on the app's own
 * origin. Safe methods are only checked when they do carry an Origin, since
 * browsers omit it for same-origin navigations.
 */
export function originGuard(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const unsafe = isUnsafeMethod(c.req.method);
    const candidate = originOf(c.req.header("origin")) ?? originOf(c.req.header("referer")) ?? null;

    if (candidate === null) {
      if (unsafe) {
        throw new ApiError("ORIGIN_REJECTED", { diagnostic: "missing origin and referer" });
      }
      await next();
      return;
    }

    if (!allowedOrigins(c.env).includes(candidate)) {
      throw new ApiError("ORIGIN_REJECTED", { diagnostic: `origin not allowed: ${candidate}` });
    }

    await next();
  };
}

/**
 * Enforces `application/json` and a byte ceiling for state-changing requests,
 * and keeps the raw text on the context so a handler can parse it once without
 * reading the (single-use) request body twice.
 */
export function jsonBodyGuard(maxBytes = MAX_JSON_BODY_BYTES): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    if (!isUnsafeMethod(c.req.method)) {
      await next();
      return;
    }

    const mediaType = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      throw new ApiError("UNSUPPORTED_MEDIA_TYPE", {
        diagnostic: `content-type must be application/json, got ${mediaType || "none"}`,
      });
    }

    const declared = Number(c.req.header("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ApiError("PAYLOAD_TOO_LARGE", { diagnostic: `content-length ${declared}` });
    }

    const raw = await c.req.text();
    // A client can lie about (or omit) Content-Length, so the real size decides.
    if (new TextEncoder().encode(raw).length > maxBytes) {
      throw new ApiError("PAYLOAD_TOO_LARGE");
    }

    c.set("rawBody", raw);
    await next();
  };
}

/** Guard for the small authentication payloads. */
export function authBodyGuard(): MiddlewareHandler<AppBindings> {
  return jsonBodyGuard(MAX_AUTH_BODY_BYTES);
}

/**
 * Parses the body captured by `jsonBodyGuard` against a Zod schema (§14 schema
 * validation). Throws `VALIDATION_FAILED`, whose public message is generic, so
 * a schema error can never echo request data back to the caller.
 */
export async function parseJsonBody<T>(c: Context<AppBindings>, schema: ZodType<T>): Promise<T> {
  const raw = c.get("rawBody");
  if (raw === undefined) {
    throw new ApiError("INTERNAL", { diagnostic: "body guard did not run for this route" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError("VALIDATION_FAILED", { diagnostic: "body is not valid JSON" });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ApiError("VALIDATION_FAILED", {
      diagnostic: result.error.issues.map((issue) => issue.path.join(".")).join(", "),
    });
  }
  return result.data;
}
