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
import { folderRoutes } from "./routes/folders";
import { noteRoutes, recycleBinRoutes } from "./routes/notes";
import { exportRoutes } from "./routes/export";
import { securityRoutes } from "./routes/security";
import { attachmentRoutes, tagRoutes } from "./routes/tags-attachments";
import { authRoutes } from "./routes/auth";
import { sessionRoutes } from "./routes/sessions";
import { APP_VERSION } from "./version";

/**
 * Whether a request should receive the application shell rather than the API's
 * JSON error.
 *
 * Only a browser navigation (which asks for HTML) and only a non-API path. This
 * keeps `/api/*` and every non-navigation request on the JSON contract, so the
 * shell can never be returned where a caller parses JSON.
 */
export function wantsApplicationShell(path: string, accept: string | undefined): boolean {
  return !path.startsWith(API_PREFIX) && (accept ?? "").toLowerCase().includes("text/html");
}

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
  // Attachments are the one multipart upload; they are named explicitly so a
  // future route cannot quietly accept something other than JSON.
  api.use("*", jsonBodyGuard({ multipartPrefixes: ["/attachments"] }));
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
  api.route("/", noteRoutes);
  api.route("/", folderRoutes);
  api.route("/", tagRoutes);
  api.route("/", attachmentRoutes);
  api.route("/", recycleBinRoutes);
  api.route("/", exportRoutes);

  app.route(API_PREFIX, api);

  // Unknown paths — API or not — must never fall through to a plain-text
  // runtime 404, and must not be able to shadow a route registered later.
  // `notFound` is only reached when nothing matched, unlike a `*` route.
  app.notFound(async (c) => {
    const assets = (c.env as { ASSETS?: Fetcher }).ASSETS;

    // A browser navigating to a deep link gets the application shell, so the
    // SPA can route it. Anything else — an API client, a fetch, a crawler — gets
    // the JSON error contract, which keeps the API's behaviour deterministic and
    // prevents the shell from being served where a caller expects JSON.
    if (assets && wantsApplicationShell(c.req.path, c.req.header("accept"))) {
      return assets.fetch(c.req.raw);
    }
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
