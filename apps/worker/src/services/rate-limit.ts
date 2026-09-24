import { AUTH_BACKOFF_BASE_MS, AUTH_BACKOFF_CAP_MS } from "@securenotes/shared";

import type { Env } from "../env";

/**
 * Rate limiting (§3): counting windows by IP, account and endpoint/global, plus
 * the progressive authentication backoff.
 *
 * The window is fixed and stored in D1 so every isolate sees the same counter —
 * an in-memory limiter would let an attacker multiply their budget by the number
 * of live isolates.
 */

export type RateLimitScope = "ip" | "account" | "endpoint" | "global";

export interface RateLimitRule {
  scope: RateLimitScope;
  /** Maximum number of events allowed inside one window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the current window ends; 0 when the request was allowed. */
  retryAfterSeconds: number;
}

/**
 * Counts one event against `rule` for `bucket` and reports whether it is still
 * inside the budget.
 *
 * The increment is a single atomic upsert; the following read is racy only in
 * the direction of another increment, which can make the verdict more
 * conservative but never more permissive.
 */
export async function consumeRateLimit(
  env: Env,
  rule: RateLimitRule,
  bucket: string,
  nowMs: number,
): Promise<RateLimitVerdict> {
  const windowStart = Math.floor(nowMs / rule.windowMs) * rule.windowMs;
  const expiresAt = windowStart + rule.windowMs;

  await env.DB.prepare(
    `INSERT INTO rate_limits (scope, bucket, window_start, counter, expires_at)
     VALUES (?1, ?2, ?3, 1, ?4)
     ON CONFLICT (scope, bucket, window_start) DO UPDATE SET counter = counter + 1`,
  )
    .bind(rule.scope, bucket, windowStart, expiresAt)
    .run();

  const counter =
    (await env.DB.prepare(
      `SELECT counter FROM rate_limits
        WHERE scope = ?1 AND bucket = ?2 AND window_start = ?3`,
    )
      .bind(rule.scope, bucket, windowStart)
      .first<number>("counter")) ?? 0;

  if (counter <= rule.limit) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - nowMs) / 1000)),
  };
}

/**
 * Exponential backoff with a cap, never a permanent lockout (§3). The delay for
 * the n-th consecutive failure is `base * 2^(n-1)`, capped.
 */
export function backoffDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) {
    return 0;
  }
  const exponent = Math.min(consecutiveFailures - 1, 20);
  return Math.min(AUTH_BACKOFF_BASE_MS * 2 ** exponent, AUTH_BACKOFF_CAP_MS);
}

/** Records a failed authentication and arms the next backoff deadline. */
export async function registerAuthFailure(
  env: Env,
  userId: string,
  nowMs: number,
): Promise<number> {
  const row = await env.DB.prepare(
    `UPDATE users
        SET failed_auth_count = failed_auth_count + 1,
            auth_backoff_until = ?2,
            updated_at = ?3
      WHERE id = ?1
      RETURNING failed_auth_count`,
  )
    .bind(userId, nowMs, nowMs)
    .first<number>("failed_auth_count");

  const failures = row ?? 0;
  const delay = backoffDelayMs(failures);
  if (delay > 0) {
    await env.DB.prepare("UPDATE users SET auth_backoff_until = ?2 WHERE id = ?1")
      .bind(userId, nowMs + delay)
      .run();
  }
  return delay;
}

/** Clears the backoff after a successful authentication. */
export async function clearAuthFailures(env: Env, userId: string, nowMs: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE users
        SET failed_auth_count = 0, auth_backoff_until = NULL, updated_at = ?2
      WHERE id = ?1 AND (failed_auth_count <> 0 OR auth_backoff_until IS NOT NULL)`,
  )
    .bind(userId, nowMs)
    .run();
}
