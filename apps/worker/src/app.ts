import { API_PREFIX, type HealthPayload } from "@securenotes/shared";
import { Hono } from "hono";

import type { AppBindings } from "./env";
import { ApiError } from "./lib/api-error";
import { findConfigProblem } from "./lib/config";
import { jsonFail, jsonOk } from "./lib/http";
import { jsonBodyGuard, originGuard } from "./middleware/guards";
import { requestId } from "./middleware/request-id";
import { securityHeaders } from "./middleware/security-headers";
import { attachSession } from "./middleware/session";
import { auditRoutes } from "./routes/audit";
import { securityRoutes } from "./routes/security";
import { authRoutes } from "./routes/auth";
import { sessionRoutes } from "./routes/sessions";
import { APP_VERSION } from "./version";

/**
 * Builds the worker application.
 *
 * Exported as a factory so tests can exercise a specific binding set (for
 * example `ENVIRONMENT: "production"`) without redeploying or restarting the
 * workerd pool.
 *
 * Middleware order is a security decision, not a style choice:
 *   1. request id      — everything downstream can be correlated;
 *   2. security headers— even a rejected request gets hardened headers;
 *   3. Origin/Referer  — rejects cross-origin callers before any work;
 *   4. body guard      — enforces Content-Type and the size ceiling;
 *   5. session         — loads the session, if any, from the cookie.
 * CSRF and authentication are attached per route, after the session is known.
 */
export function createApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use("*", requestId());
  app.use("*", securityHeaders());

  const api = new Hono<AppBindings>();

  // Configuration first: a missing secret must produce a precise error rather
  // than a confusing crash deep inside a crypto call on some later request.
  api.use("*", async (c, next) => {
    const problem = findConfigProblem(c.env);
    if (problem) {
      throw new ApiError("INTERNAL", { diagnostic: `worker is misconfigured: ${problem}` });
    }
    await next();
  });

  api.use("*", originGuard());
  api.use("*", jsonBodyGuard());
  api.use("*", attachSession());

  // Liveness/version probe. Deliberately unauthenticated and free of any
  // account, key or binding detail beyond the application version.
  api.get("/health", (c) => {
    const payload: HealthPayload = {
      status: "ok",
      version: APP_VERSION,
      environment: c.env.ENVIRONMENT,
    };
    return jsonOk(payload);
  });

  // Every endpoint declares a strict method set; anything else is a 405 rather
  // than an accidental 404 that could mask routing mistakes (§14).
  api.all("/health", (c) => jsonFail(c, "METHOD_NOT_ALLOWED"));

  api.route("/", authRoutes);
  api.route("/", sessionRoutes);
  api.route("/", auditRoutes);
  api.route("/", securityRoutes);

  app.route(API_PREFIX, api);

  // Unknown paths — API or not — must never fall through to a plain-text
  // runtime 404, and must not be able to shadow a route registered later.
  // `notFound` is only reached when nothing matched, unlike a `*` route.
  app.notFound((c) => {
    // Non-API paths serve the application shell from P4 onwards.
    return jsonFail(c, "NOT_FOUND");
  });

  app.onError((error, c) => {
    // Handlers raise ApiError for anything expected; its code is already the
    // stable public one, and only an explicitly supplied diagnostic — never the
    // error message — can appear, and only in development.
    if (error instanceof ApiError) {
      return jsonFail(c, error.code, error.diagnostic, error.headers);
    }

    // Server-side logging keeps the error name for triage; the stack is only
    // logged in development, where no real note can exist.
    const requestIdValue = c.get("requestId");
    if (c.env.ENVIRONMENT === "development") {
      console.error(`[${requestIdValue}] ${c.req.method} ${c.req.path} failed`, error);
    } else {
      console.error(
        `[${requestIdValue}] ${c.req.method} ${c.req.path} failed: ${
          error instanceof Error ? error.name : "UnknownError"
        }`,
      );
    }
    return jsonFail(c, "INTERNAL", error instanceof Error ? error.message : undefined);
  });

  return app;
}

export const app = createApp();
