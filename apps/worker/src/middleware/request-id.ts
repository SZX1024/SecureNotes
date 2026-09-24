import { REQUEST_ID_HEADER } from "@securenotes/shared";
import type { MiddlewareHandler } from "hono";

import type { AppBindings } from "../env";

/**
 * Correlation id attached to every request and echoed to the client. Audit
 * records (§5) reference it so a security event can be traced without storing
 * anything sensitive in the log line itself.
 */
export function requestId(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    await next();
    c.res.headers.set(REQUEST_ID_HEADER, c.get("requestId"));
  };
}
