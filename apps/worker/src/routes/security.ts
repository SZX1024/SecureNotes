import { Hono } from "hono";
import { z } from "zod";

import type { AppBindings } from "../env";
import { ApiError } from "../lib/api-error";
import { classifyClient, truncateIp } from "../lib/client-meta";
import { jsonOk } from "../lib/http";
import { parseJsonBody } from "../middleware/guards";
import { requireCsrf, requireSession } from "../middleware/session";
import { writeAuditEvent } from "../services/audit";
import {
  keyMaterialSchema,
  readWrappedDek,
  storeKeyMaterial,
  type KeyMaterialUpload,
} from "../services/key-material";
import { consumeNonce, isOperation, issueNonce } from "../services/nonces";
import { revokeAllSessions } from "../services/sessions";
import { completeRebind, rollbackRebind, startRebind, verifyRebind } from "../services/totp-rebind";

/**
 * Security-sensitive state transitions (§3, §20, §26).
 *
 * Every route here requires an authenticated session, a valid CSRF token and a
 * one-time nonce issued for exactly this operation, so a request cannot be
 * replayed and a nonce cannot be borrowed from another operation.
 */

export const securityRoutes = new Hono<AppBindings>();

const nonceRequestSchema = z.object({ operation: z.string().min(1).max(64) }).strict();
const nonceSchema = z.string().min(16).max(128);

const keyMaterialRequestSchema = keyMaterialSchema.extend({ nonce: nonceSchema }).strict();

const rebindVerifySchema = z
  .object({ nonce: nonceSchema, code: z.string().regex(/^[0-9]{6}$/) })
  .strict();

const rebindSimpleSchema = z.object({ nonce: nonceSchema }).strict();

/** Issues a nonce bound to this user, this session and this operation. */
securityRoutes.post("/security/operation-nonce", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const body = await parseJsonBody(c, nonceRequestSchema);
  if (!isOperation(body.operation)) {
    throw new ApiError("VALIDATION_FAILED", { diagnostic: "unknown operation" });
  }

  const issued = await issueNonce(
    c.env,
    { userId: session.userId, sessionId: session.id, operation: body.operation },
    Date.now(),
  );

  return jsonOk({ nonce: issued.nonce, expiresAt: issued.expiresAt });
});

/** Uploads the client-wrapped DEK and its ten recovery wrappings. */
securityRoutes.post("/key-material", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const now = Date.now();
  const body = await parseJsonBody(c, keyMaterialRequestSchema);

  const spent = await consumeNonce(
    c.env,
    {
      userId: session.userId,
      sessionId: session.id,
      operation: "key-material-upload",
      nonce: body.nonce,
    },
    now,
  );
  if (!spent) {
    throw new ApiError("PRECONDITION_FAILED", { diagnostic: "nonce is invalid or already used" });
  }

  const upload: KeyMaterialUpload = {
    keyVersion: body.keyVersion,
    wrappedDek: body.wrappedDek,
    recoveryWrappings: body.recoveryWrappings,
  };
  await storeKeyMaterial(c.env, session.userId, upload, now);

  await writeAuditEvent(
    c.env,
    {
      userId: session.userId,
      category: "key",
      eventType: "key_material_updated",
      sessionId: session.id,
      ipTruncated: truncateIp(c.req.header("cf-connecting-ip")),
      clientCategory: classifyClient(c.req.header("user-agent")),
      detail: `key version ${upload.keyVersion}, ${upload.recoveryWrappings.length} recovery wrappings`,
    },
    now,
    c.get("requestId"),
  );

  return jsonOk({ keyMaterialPresent: true, keyVersion: upload.keyVersion });
});

/** Reads the wrapped DEK so an authenticated client can unlock. */
securityRoutes.get("/key-material", requireSession(), async (c) => {
  const session = c.get("session")!;
  const material = await readWrappedDek(c.env, session.userId);

  if (!material) {
    return jsonOk({ keyMaterialPresent: false, keyVersion: null, wrappedDek: null });
  }
  return jsonOk({
    keyMaterialPresent: true,
    keyVersion: material.keyVersion,
    wrappedDek: material.envelope,
  });
});

/** Starts a TOTP rebind: a new secret is generated and held pending (§3). */
securityRoutes.post("/security/totp/change/start", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const now = Date.now();
  const body = await parseJsonBody(c, rebindSimpleSchema);

  const spent = await consumeNonce(
    c.env,
    {
      userId: session.userId,
      sessionId: session.id,
      operation: "totp-change-start",
      nonce: body.nonce,
    },
    now,
  );
  if (!spent) {
    throw new ApiError("PRECONDITION_FAILED", { diagnostic: "nonce is invalid or already used" });
  }

  const started = await startRebind(c.env, session.userId, now);
  if (!started) {
    throw new ApiError("PRECONDITION_FAILED", { diagnostic: "no TOTP configuration" });
  }

  await writeAuditEvent(
    c.env,
    {
      userId: session.userId,
      category: "key",
      eventType: "totp_change_started",
      sessionId: session.id,
      detail: `moving to key version ${started.keyVersion}`,
    },
    now,
    c.get("requestId"),
  );

  return jsonOk(started);
});

/** Verifies a code from the pending secret; the old secret stays active. */
securityRoutes.post("/security/totp/change/verify", requireSession(), requireCsrf(), async (c) => {
  const session = c.get("session")!;
  const now = Date.now();
  const body = await parseJsonBody(c, rebindVerifySchema);

  const spent = await consumeNonce(
    c.env,
    {
      userId: session.userId,
      sessionId: session.id,
      operation: "totp-change-verify",
      nonce: body.nonce,
    },
    now,
  );
  if (!spent) {
    throw new ApiError("PRECONDITION_FAILED", { diagnostic: "nonce is invalid or already used" });
  }

  const result = await verifyRebind(c.env, session.userId, body.code, now);
  if (result.kind === "not_started") {
    throw new ApiError("PRECONDITION_FAILED", { diagnostic: "no rebind in progress" });
  }
  if (result.kind === "invalid") {
    await writeAuditEvent(
      c.env,
      {
        userId: session.userId,
        category: "key",
        eventType: "totp_change_verified",
        outcome: "failure",
        sessionId: session.id,
      },
      now,
      c.get("requestId"),
    );
    throw new ApiError("INVALID_CREDENTIALS");
  }

  // Other devices are signed out as soon as the new secret is proven, which
  // narrows the rebind window without breaking this migration.
  const revoked = await revokeAllSessions(c.env, session.userId, now, {
    keepSessionId: session.id,
  });

  await writeAuditEvent(
    c.env,
    {
      userId: session.userId,
      category: "key",
      eventType: "totp_change_verified",
      sessionId: session.id,
      detail: `revoked ${revoked} other session(s)`,
    },
    now,
    c.get("requestId"),
  );

  return jsonOk({
    state: "rewrapping" as const,
    keyVersion: result.keyVersion,
    // Both secrets, for the duration of the rebind only: the new one derives the
    // new KEK, the old one unwraps the DEK that is still protected by it.
    totpSecret: result.newSecretBase32,
    previousTotpSecret: result.previousSecretBase32,
  });
});

/** Commits the rebind with the re-wrapped key material and revokes all sessions. */
securityRoutes.post(
  "/security/totp/change/complete",
  requireSession(),
  requireCsrf(),
  async (c) => {
    const session = c.get("session")!;
    const now = Date.now();
    const body = await parseJsonBody(c, keyMaterialRequestSchema);

    const spent = await consumeNonce(
      c.env,
      {
        userId: session.userId,
        sessionId: session.id,
        operation: "totp-change-complete",
        nonce: body.nonce,
      },
      now,
    );
    if (!spent) {
      throw new ApiError("PRECONDITION_FAILED", { diagnostic: "nonce is invalid or already used" });
    }

    const completed = await completeRebind(
      c.env,
      session.userId,
      {
        keyVersion: body.keyVersion,
        wrappedDek: body.wrappedDek,
        recoveryWrappings: body.recoveryWrappings,
      },
      now,
    );

    if (completed.kind === "not_ready") {
      throw new ApiError("PRECONDITION_FAILED", { diagnostic: "no verified rebind to complete" });
    }
    if (completed.kind === "invalid_material") {
      throw new ApiError("VALIDATION_FAILED", { diagnostic: completed.diagnostic });
    }

    // §3: every session is revoked once the credentials have changed, including
    // this one — the client re-authenticates with the new secret.
    const revoked = await revokeAllSessions(c.env, session.userId, now);

    await writeAuditEvent(
      c.env,
      {
        userId: session.userId,
        category: "key",
        eventType: "totp_changed",
        sessionId: session.id,
        detail: `key version ${completed.keyVersion}, revoked ${revoked} session(s)`,
      },
      now,
      c.get("requestId"),
    );

    return jsonOk({ keyVersion: completed.keyVersion, revokedSessions: revoked, loggedOut: true });
  },
);

/** Abandons a rebind without touching the stored key material. */
securityRoutes.post(
  "/security/totp/change/rollback",
  requireSession(),
  requireCsrf(),
  async (c) => {
    const session = c.get("session")!;
    const now = Date.now();
    const body = await parseJsonBody(c, rebindSimpleSchema);

    const spent = await consumeNonce(
      c.env,
      {
        userId: session.userId,
        sessionId: session.id,
        operation: "totp-change-rollback",
        nonce: body.nonce,
      },
      now,
    );
    if (!spent) {
      throw new ApiError("PRECONDITION_FAILED", { diagnostic: "nonce is invalid or already used" });
    }

    const rolledBack = await rollbackRebind(c.env, session.userId, now);
    if (!rolledBack) {
      throw new ApiError("PRECONDITION_FAILED", { diagnostic: "no rebind in progress" });
    }

    await writeAuditEvent(
      c.env,
      {
        userId: session.userId,
        category: "key",
        eventType: "totp_change_rolled_back",
        sessionId: session.id,
      },
      now,
      c.get("requestId"),
    );

    return jsonOk({ state: "idle" as const });
  },
);
