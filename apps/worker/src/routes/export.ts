import { Hono } from "hono";

import type { AppBindings } from "../env";
import { jsonOk } from "../lib/http";
import { requireSession } from "../middleware/session";
import { buildRecoveryPackage } from "../services/recovery-package";

/**
 * The export endpoints that are not the ordinary archive (§15, §20).
 *
 * Only the recovery package lives here for now. It is a read: nothing about asking for this file changes the
 * account, and a session that can build it can already use the key material it contains.
 */
export const exportRoutes = new Hono<AppBindings>();

exportRoutes.get("/export/recovery-package", requireSession(), async (c) => {
  const session = c.get("session")!;
  const recoveryPackage = await buildRecoveryPackage(c.env, session.userId, Date.now());
  return jsonOk({ recoveryPackage });
});
