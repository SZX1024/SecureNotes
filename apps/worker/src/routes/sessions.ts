import { Hono } from "hono";
import { z } from "zod";

import type { AppBindings } from "../env";
import { ApiError } from "../lib/api-error";
import { classifyClient, truncateIp } from "../lib/client-meta";
import { applyClearedSessionCookies } from "../lib/cookies";
import { jsonOk } from "../lib/http";
import { parseJsonBody } from "../middleware/guards";
import { requireCsrf, requireSession } from "../middleware/session";
import { writeAuditEvent } from "../services/audit";
import {
  listSessions,
  renameSession,
  revokeAllSessions,
  revokeSession,
} from "../services/sessions";

/**
 * Session management (§4, §15): device list, rename, individual revoke, and
 * revoke-all. Every operation is scoped by `user_id` as well as session id, so
 * a session id from another account can never be touched (no IDOR/BOLA).
 */

export const sessionRoutes = new Hono<AppBindings>();

const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/;
const renameSchema = z.object({ deviceName: z.string().min(1).max(64) }).strict();

sessionRoutes.get("/sessions", requireSession(), async (c) => {
  const session = c.get("session")!;
  const now = Date.now();
  const sessions = await listSessions(c.env, session.userId, now, session.id);

  return jsonOk({
    sessions: sessions.map((entry) => ({
      id: entry.id,
      current: entry.current,
      deviceName: entry.deviceName,
      // Coarse categories only: never the raw User-Agent or full IP (§4).
      clientCategory: entry.clientCategory,
      ipTruncated: entry.ipTruncated,
      createdAt: entry.createdAt,
      lastSeenAt: entry.lastSeenAt,
      expiresAt: entry.expiresAt,
      rememberDevice: entry.rememberDevice,
    })),
  });
});

sessionRoutes.patch("/sessions/:id", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const target = c.req.param("id");
  if (!SESSION_ID_PATTERN.test(target)) {
    throw new ApiError("NOT_FOUND");
  }

  const body = await parseJsonBody(c, renameSchema);
  const renamed = await renameSession(c.env, session.userId, target, body.deviceName);
  if (!renamed) {
    throw new ApiError("NOT_FOUND");
  }

  return jsonOk({ id: target, deviceName: body.deviceName });
});

sessionRoutes.delete("/sessions/:id", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const target = c.req.param("id");
  if (!SESSION_ID_PATTERN.test(target)) {
    throw new ApiError("NOT_FOUND");
  }

  const now = Date.now();
  const revoked = await revokeSession(c.env, session.userId, target, now);
  if (!revoked) {
    throw new ApiError("NOT_FOUND");
  }

  const revokingSelf = target === session.id;

  await writeAuditEvent(
    c.env,
    {
      userId: session.userId,
      category: "session",
      eventType: "session_revoked",
      sessionId: target,
      ipTruncated: truncateIp(c.req.header("cf-connecting-ip")),
      clientCategory: classifyClient(c.req.header("user-agent")),
      detail: revokingSelf ? "revoked the current session" : "revoked another session",
    },
    now,
    c.get("requestId"),
  );

  const response = jsonOk({ revoked: target, loggedOut: revokingSelf });
  // Revoking the current session logs the user out immediately (§4).
  return revokingSelf ? applyClearedSessionCookies(response) : response;
});

sessionRoutes.post("/sessions/revoke-all", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const now = Date.now();

  // Revoke-all includes the current session (§4).
  const count = await revokeAllSessions(c.env, session.userId, now);

  await writeAuditEvent(
    c.env,
    {
      userId: session.userId,
      category: "session",
      eventType: "sessions_revoked_all",
      sessionId: session.id,
      detail: `revoked ${count} session(s), including the current one`,
    },
    now,
    c.get("requestId"),
  );

  // Revoke-all includes the current session, so the cookies are cleared too.
  return applyClearedSessionCookies(jsonOk({ revoked: count, loggedOut: true }));
});
