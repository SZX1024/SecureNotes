import { OPERATION_NONCE_TTL_MS } from "@securenotes/shared";

import type { Env } from "../env";
import { randomToken } from "../lib/crypto";

/**
 * One-time operation ids (§26).
 *
 * A nonce is issued by the server, bound to the user *and* the session that
 * asked for it, and tied to one operation name. Consuming it is a conditional
 * update, so two concurrent requests can never both spend it — which is what
 * makes "one-time" true rather than best-effort.
 */

export const OPERATIONS = [
  "key-material-upload",
  "totp-change-start",
  "totp-change-verify",
  "totp-change-complete",
  "totp-change-rollback",
] as const;
export type Operation = (typeof OPERATIONS)[number];

export function isOperation(value: unknown): value is Operation {
  return typeof value === "string" && (OPERATIONS as readonly string[]).includes(value);
}

export interface IssuedNonce {
  nonce: string;
  expiresAt: number;
}

export async function issueNonce(
  env: Env,
  input: { userId: string; sessionId: string; operation: Operation },
  nowMs: number,
): Promise<IssuedNonce> {
  const nonce = randomToken(32);
  const expiresAt = nowMs + OPERATION_NONCE_TTL_MS;

  await env.DB.prepare(
    `INSERT INTO operation_nonces (id, user_id, session_id, operation, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(nonce, input.userId, input.sessionId, input.operation, expiresAt, nowMs)
    .run();

  return { nonce, expiresAt };
}

/**
 * Spends a nonce. Returns false when it is unknown, already used, expired, for
 * a different operation, or was issued to a different session — all of which
 * are the same answer to the caller.
 */
export async function consumeNonce(
  env: Env,
  input: { userId: string; sessionId: string; operation: Operation; nonce: string },
  nowMs: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE operation_nonces SET consumed_at = ?5
      WHERE id = ?1 AND user_id = ?2 AND session_id = ?3 AND operation = ?4
        AND consumed_at IS NULL AND expires_at > ?5`,
  )
    .bind(input.nonce, input.userId, input.sessionId, input.operation, nowMs)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/** Removes nonces whose lifetime has passed; called from the scheduled sweep. */
export async function purgeExpiredNonces(env: Env, nowMs: number): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM operation_nonces WHERE expires_at < ?1")
    .bind(nowMs)
    .run();
  return result.meta.changes ?? 0;
}
