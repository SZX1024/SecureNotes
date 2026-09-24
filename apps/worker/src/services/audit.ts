import { AUDIT_RETENTION_MS } from "@securenotes/shared";

import type { Env } from "../env";
import { uuidv7, randomBytes } from "../lib/crypto";
import { sealText } from "../lib/secret-box";

/**
 * Security audit log (§5).
 *
 * Invariants enforced here rather than at each call site:
 * - plaintext secrets never reach this module: callers pass an already-safe
 *   `detail`, and it is encrypted before it touches D1;
 * - IP is stored truncated and the User-Agent only as a browser/OS category,
 *   both handled by the caller through `lib/client-meta`;
 * - the log can never be cleared by a user — retention is enforced by
 *   `purgeExpiredAuditLogs` from the scheduled handler only.
 */

export const AUDIT_CATEGORIES = ["auth", "session", "key", "data", "account"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/**
 * The event vocabulary. Kept as a plain union rather than a database CHECK so a
 * new event does not need a migration; the category is the closed dimension.
 */
export type AuditEventType =
  | "account_initialized"
  | "login_succeeded"
  | "login_failed"
  | "recovery_login_succeeded"
  | "recovery_login_failed"
  | "session_created"
  | "session_evicted"
  | "session_revoked"
  | "sessions_revoked_all"
  | "logout"
  | "rate_limited"
  | "totp_changed"
  | "totp_change_started"
  | "totp_change_verified"
  | "totp_change_rolled_back"
  | "key_material_updated"
  | "data_operation";

export interface AuditEvent {
  userId: string | null;
  category: AuditCategory;
  eventType: AuditEventType;
  outcome?: "success" | "failure";
  sessionId?: string | null;
  ipTruncated?: string | null;
  clientCategory?: string | null;
  /** Passed through `sealText`; must never contain note plaintext or a secret. */
  detail?: string | null;
}

export async function writeAuditEvent(
  env: Env,
  event: AuditEvent,
  nowMs: number,
  requestId?: string,
): Promise<void> {
  const detail = event.detail
    ? await sealText(env.SECRET_WRAP_KEY, "audit-detail", event.detail)
    : null;

  await env.DB.prepare(
    `INSERT INTO audit_logs
       (id, user_id, category, event_type, outcome, session_id, ip_truncated, client_category, detail_iv, detail_ciphertext, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      uuidv7(nowMs, randomBytes(10)),
      event.userId,
      event.category,
      event.eventType,
      event.outcome ?? "success",
      event.sessionId ?? null,
      event.ipTruncated ?? null,
      event.clientCategory ?? null,
      detail?.iv ?? null,
      detail?.ciphertext ?? null,
      nowMs,
    )
    .run();

  // The request id correlates a worker log line with the audit entry without
  // adding an identifier column; it is not secret and not request-derived data.
  if (requestId !== undefined && event.outcome === "failure") {
    console.warn(`[${requestId}] audit: ${event.category}/${event.eventType}`);
  }
}

/**
 * Deletes audit rows older than the 30-day retention window (§5). Called from
 * the hourly cron trigger; returns the number of removed rows.
 */
export async function purgeExpiredAuditLogs(
  env: Env,
  nowMs: number,
  batchSize = 500,
): Promise<number> {
  const cutoff = nowMs - AUDIT_RETENTION_MS;
  const result = await env.DB.prepare(
    `DELETE FROM audit_logs WHERE id IN (
       SELECT id FROM audit_logs WHERE created_at < ?1 ORDER BY created_at LIMIT ?2
     )`,
  )
    .bind(cutoff, batchSize)
    .run();

  return result.meta.changes ?? 0;
}

/** Sweeps expired rate-limit windows; they are derived data, not history. */
export async function purgeExpiredRateLimits(env: Env, nowMs: number): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?1")
    .bind(nowMs)
    .run();
  return result.meta.changes ?? 0;
}
