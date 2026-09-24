import {
  AUTH_ATTEMPTS_GLOBAL_PER_HOUR,
  AUTH_ATTEMPTS_PER_ACCOUNT_PER_HOUR,
  AUTH_ATTEMPTS_PER_IP_PER_HOUR,
} from "@securenotes/shared";
import { Hono } from "hono";
import { z } from "zod";

import type { AppBindings, Env } from "../env";
import { ApiError, rateLimited } from "../lib/api-error";
import { classifyClient, truncateIp } from "../lib/client-meta";
import { applyClearedSessionCookies, applySessionCookies } from "../lib/cookies";
import { jsonOk } from "../lib/http";
import { authBodyGuard, parseJsonBody } from "../middleware/guards";
import { requireCsrf, requireSession } from "../middleware/session";
import {
  USERNAME_PATTERN,
  getAccount,
  initializeAccount,
  readTotpSecretBase32,
  redeemRecoveryCode,
  verifyTotpCredentials,
  type Account,
} from "../services/account";
import { writeAuditEvent } from "../services/audit";
import { clearAuthFailures, consumeRateLimit, registerAuthFailure } from "../services/rate-limit";
import {
  createSession,
  revokeAllSessions,
  revokeSession,
  type SessionRecord,
} from "../services/sessions";

/**
 * Authentication endpoints (§3, §4, §15).
 *
 * The shape of every response is deliberately small, and every credential
 * failure returns the same code and message so a caller cannot tell "no such
 * username" from "wrong code" from "spent recovery code".
 */

export const authRoutes = new Hono<AppBindings>();

const HOUR_MS = 60 * 60 * 1000;

const usernameSchema = z.string().min(3).max(64).regex(USERNAME_PATTERN);

/** `.strict()` on every schema: unexpected fields are a validation failure (§14). */
const setupSchema = z.object({ username: usernameSchema }).strict();
const loginSchema = z
  .object({
    username: usernameSchema,
    code: z.string().regex(/^[0-9]{6}$/),
    rememberDevice: z.boolean().optional(),
    deviceName: z.string().min(1).max(64).optional(),
  })
  .strict();
const recoverySchema = z
  .object({
    username: usernameSchema,
    code: z.string().min(8).max(128),
    rememberDevice: z.boolean().optional(),
  })
  .strict();

function requestMeta(headers: Headers) {
  return {
    ipTruncated: truncateIp(headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for")),
    clientCategory: classifyClient(headers.get("user-agent")),
    requestId: headers.get("x-request-id") ?? undefined,
  };
}

/**
 * Counts one authentication attempt against all three buckets from §3 (IP,
 * account and endpoint/global) and rejects once any of them is exhausted.
 *
 * Buckets are checked before any credential work so a flood costs the attacker
 * a cheap INSERT rather than a TOTP verification.
 */
async function enforceAuthRateLimits(
  env: Env,
  username: string,
  ipTruncated: string | null,
  endpoint: "auth/login" | "auth/recovery",
  nowMs: number,
): Promise<void> {
  const rules = [
    {
      rule: { scope: "ip" as const, limit: AUTH_ATTEMPTS_PER_IP_PER_HOUR, windowMs: HOUR_MS },
      bucket: ipTruncated ?? "unknown",
    },
    {
      rule: {
        scope: "account" as const,
        limit: AUTH_ATTEMPTS_PER_ACCOUNT_PER_HOUR,
        windowMs: HOUR_MS,
      },
      bucket: username.toLowerCase(),
    },
    {
      rule: {
        scope: "endpoint" as const,
        limit: AUTH_ATTEMPTS_GLOBAL_PER_HOUR,
        windowMs: HOUR_MS,
      },
      bucket: endpoint,
    },
  ];

  for (const { rule, bucket } of rules) {
    const verdict = await consumeRateLimit(env, rule, bucket, nowMs);
    if (!verdict.allowed) {
      throw rateLimited(verdict.retryAfterSeconds);
    }
  }
}

function sessionPayload(session: SessionRecord, csrfToken: string) {
  return {
    session: {
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
      rememberDevice: session.rememberDevice,
      deviceName: session.deviceName,
      clientCategory: session.clientCategory,
      ipTruncated: session.ipTruncated,
    },
    csrfToken,
  };
}

/** Whether the client has uploaded its key material yet (P3 completes this). */
function keyMaterialPresent(account: Account): boolean {
  return account.wrappedDekIv !== null && account.wrappedDekCiphertext !== null;
}

authRoutes.get("/auth/status", async (c) => {
  const account = await getAccount(c.env);
  return jsonOk({ initialized: account !== null });
});

/**
 * First-run initialization (§3). Returns the TOTP secret and the ten recovery
 * codes exactly once, and does not create a session: the user then logs in
 * through the normal TOTP path, so enrolment never bypasses the second factor.
 */
authRoutes.post("/auth/setup", authBodyGuard(), async (c) => {
  const body = await parseJsonBody(c, setupSchema);
  const now = Date.now();
  const meta = requestMeta(c.req.raw.headers);

  const result = await initializeAccount(c.env, body.username, now);
  if (!result) {
    throw new ApiError("PRECONDITION_FAILED", { diagnostic: "account already initialized" });
  }

  await writeAuditEvent(
    c.env,
    {
      userId: result.account.id,
      category: "account",
      eventType: "account_initialized",
      ipTruncated: meta.ipTruncated,
      clientCategory: meta.clientCategory,
    },
    now,
    meta.requestId,
  );

  return jsonOk({
    username: result.account.username,
    totpSecret: result.totpSecretBase32,
    totpUri: result.totpUri,
    recoveryCodes: result.recoveryCodes,
    // Shown once: the server keeps only digests from this point on.
    recoveryCodesShownOnce: true,
  });
});

/** Username + current TOTP (§3). */
authRoutes.post("/auth/login", authBodyGuard(), async (c) => {
  const body = await parseJsonBody(c, loginSchema);
  const now = Date.now();
  const meta = requestMeta(c.req.raw.headers);

  await enforceAuthRateLimits(c.env, body.username, meta.ipTruncated, "auth/login", now);

  const result = await verifyTotpCredentials(c.env, body.username, body.code, now);

  if (result.kind === "backoff") {
    throw rateLimited(result.retryAfterSeconds);
  }
  if (result.kind === "invalid") {
    const account = await getAccount(c.env);
    if (account && account.username === body.username) {
      await registerAuthFailure(c.env, account.id, now);
    }
    await writeAuditEvent(
      c.env,
      {
        userId: account?.id ?? null,
        category: "auth",
        eventType: "login_failed",
        outcome: "failure",
        ipTruncated: meta.ipTruncated,
        clientCategory: meta.clientCategory,
      },
      now,
      meta.requestId,
    );
    throw new ApiError("INVALID_CREDENTIALS");
  }

  const account = result.account;
  await clearAuthFailures(c.env, account.id, now);

  const { created, evicted } = await createSession(
    c.env,
    {
      userId: account.id,
      rememberDevice: body.rememberDevice === true,
      deviceName: body.deviceName ?? null,
      ipTruncated: meta.ipTruncated,
      clientCategory: meta.clientCategory,
    },
    now,
  );

  if (evicted) {
    await writeAuditEvent(
      c.env,
      {
        userId: account.id,
        category: "session",
        eventType: "session_evicted",
        sessionId: evicted.id,
        ipTruncated: meta.ipTruncated,
        clientCategory: meta.clientCategory,
      },
      now,
      meta.requestId,
    );
  }
  await writeAuditEvent(
    c.env,
    {
      userId: account.id,
      category: "auth",
      eventType: "login_succeeded",
      sessionId: created.session.id,
      ipTruncated: meta.ipTruncated,
      clientCategory: meta.clientCategory,
    },
    now,
    meta.requestId,
  );
  await writeAuditEvent(
    c.env,
    {
      userId: account.id,
      category: "session",
      eventType: "session_created",
      sessionId: created.session.id,
      ipTruncated: meta.ipTruncated,
      clientCategory: meta.clientCategory,
    },
    now,
    meta.requestId,
  );

  return applySessionCookies(
    jsonOk({
      ...sessionPayload(created.session, created.csrfToken),
      username: account.username,
      keyMaterialPresent: keyMaterialPresent(account),
      // ADR-002: delivered over HTTPS to derive the KEK. Memory-only on the client.
      totpSecret: await readTotpSecretBase32(c.env, account.id),
    }),
    {
      token: created.token,
      csrfToken: created.csrfToken,
      rememberDevice: created.session.rememberDevice,
    },
  );
});

/**
 * Recovery-code login (§3). The code is single-use, and using one revokes every
 * other session while keeping the new one.
 */
authRoutes.post("/auth/recovery", authBodyGuard(), async (c) => {
  const body = await parseJsonBody(c, recoverySchema);
  const now = Date.now();
  const meta = requestMeta(c.req.raw.headers);

  await enforceAuthRateLimits(c.env, body.username, meta.ipTruncated, "auth/recovery", now);

  const result = await redeemRecoveryCode(c.env, body.username, body.code, now);
  if (result.kind === "invalid") {
    const account = await getAccount(c.env);
    if (account && account.username === body.username) {
      await registerAuthFailure(c.env, account.id, now);
    }
    await writeAuditEvent(
      c.env,
      {
        userId: account?.id ?? null,
        category: "auth",
        eventType: "recovery_login_failed",
        outcome: "failure",
        ipTruncated: meta.ipTruncated,
        clientCategory: meta.clientCategory,
      },
      now,
      meta.requestId,
    );
    throw new ApiError("INVALID_CREDENTIALS");
  }

  const account = result.account;
  await clearAuthFailures(c.env, account.id, now);

  const { created } = await createSession(
    c.env,
    {
      userId: account.id,
      rememberDevice: body.rememberDevice === true,
      ipTruncated: meta.ipTruncated,
      clientCategory: meta.clientCategory,
    },
    now,
  );

  const revoked = await revokeAllSessions(c.env, account.id, now, {
    keepSessionId: created.session.id,
  });

  await writeAuditEvent(
    c.env,
    {
      userId: account.id,
      category: "auth",
      eventType: "recovery_login_succeeded",
      sessionId: created.session.id,
      ipTruncated: meta.ipTruncated,
      clientCategory: meta.clientCategory,
    },
    now,
    meta.requestId,
  );
  await writeAuditEvent(
    c.env,
    {
      userId: account.id,
      category: "session",
      eventType: "sessions_revoked_all",
      sessionId: created.session.id,
      detail: `revoked ${revoked} session(s) after recovery login`,
    },
    now,
    meta.requestId,
  );

  return applySessionCookies(
    jsonOk({
      ...sessionPayload(created.session, created.csrfToken),
      username: account.username,
      keyMaterialPresent: keyMaterialPresent(account),
      // §3: the user is prompted to reconfigure TOTP after a recovery login.
      mustRebindTotp: true,
      revokedOtherSessions: revoked,
    }),
    {
      token: created.token,
      csrfToken: created.csrfToken,
      rememberDevice: created.session.rememberDevice,
    },
  );
});

/** Revokes the current session and clears the cookies. */
authRoutes.post("/auth/logout", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const now = Date.now();
  const meta = requestMeta(c.req.raw.headers);

  await revokeSession(c.env, session.userId, session.id, now);

  await writeAuditEvent(
    c.env,
    {
      userId: session.userId,
      category: "session",
      eventType: "logout",
      sessionId: session.id,
      ipTruncated: meta.ipTruncated,
      clientCategory: meta.clientCategory,
    },
    now,
    meta.requestId,
  );

  return applyClearedSessionCookies(jsonOk({ authenticated: false }));
});

/**
 * Bootstrap probe. Returns 200 with `authenticated: false` rather than 401 so
 * the client can start up without a console full of failed requests; a
 * `false` here means the client must discard any cached key material (§4).
 */
authRoutes.get("/auth/session", async (c) => {
  const session = c.get("session");
  if (!session) {
    return jsonOk({ authenticated: false });
  }

  const account = await getAccount(c.env);
  if (!account || account.id !== session.userId) {
    return jsonOk({ authenticated: false });
  }

  return jsonOk({
    authenticated: true,
    username: account.username,
    keyMaterialPresent: keyMaterialPresent(account),
    session: {
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
      rememberDevice: session.rememberDevice,
    },
  });
});
