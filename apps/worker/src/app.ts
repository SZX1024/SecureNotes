import { API_PREFIX, type HealthPayload } from "@securenotes/shared";
import { Hono } from "hono";

import type { AppBindings } from "./env";
import { jsonFail, jsonOk } from "./lib/http";
import { requestId } from "./middleware/request-id";
import { securityHeaders } from "./middleware/security-headers";
import { APP_VERSION } from "./version";

/**
 * Builds the worker application.
 *
 * Exported as a factory so tests can exercise a specific binding set (for
 * example `ENVIRONMENT: "production"`) without redeploying or restarting the
 * workerd pool.
 */
export function createApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use("*", requestId());
  app.use("*", securityHeaders());

  const api = new Hono<AppBindings>();

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

  app.route(API_PREFIX, api);

  // Unknown paths — API or not — must never fall through to a plain-text
  // runtime 404, and must not be able to shadow a route registered later.
  // `notFound` is only reached when nothing matched, unlike a `*` route.
  app.notFound((c) => {
    // Non-API paths serve the application shell from P4 onwards.
    return jsonFail(c, "NOT_FOUND");
  });

  app.onError((error, c) => {
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
