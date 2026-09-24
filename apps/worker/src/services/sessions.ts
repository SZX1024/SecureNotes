import {
  MAX_ACTIVE_SESSIONS,
  REMEMBER_DEVICE_MAX_MS,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from "@securenotes/shared";

import type { Env } from "../env";
import {
  base64ToBytes,
  bytesToBase64,
  hmac,
  randomBytes,
  randomToken,
  sha256Hex,
  timingSafeEqualHex,
  utf8,
  uuidv7,
} from "../lib/crypto";

/**
 * Session lifecycle (§4).
 *
 * The token is 256 bits of CSPRNG output and only its SHA-256 digest is stored,
 * so a database leak does not yield a usable cookie. The session id is a UUIDv7
 * and is the only identifier the API exposes to the client.
 *
 * Expiry model, read literally from §4 (which states exactly two rules):
 * - every session expires 40 minutes after its last request (sliding);
 * - a remember-device session is additionally capped at 30 days absolute.
 * `expires_at` therefore stores the sliding deadline; the absolute cap is
 * derived from `created_at` and `remember_device`, so it needs no extra column.
 */

export interface SessionRecord {
  id: string;
  userId: string;
  rememberDevice: boolean;
  deviceName: string | null;
  clientCategory: string | null;
  ipTruncated: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface SessionSummary extends SessionRecord {
  current: boolean;
}

export interface CreatedSession {
  token: string;
  csrfToken: string;
  session: SessionRecord;
}

interface SessionRow {
  id: string;
  user_id: string;
  remember_device: number;
  device_name: string | null;
  client_category: string | null;
  ip_truncated: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    rememberDevice: row.remember_device === 1,
    deviceName: row.device_name,
    clientCategory: row.client_category,
    ipTruncated: row.ip_truncated,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

export async function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/** Absolute deadline for a session, or Infinity when it has no absolute cap. */
export function absoluteDeadline(record: SessionRecord): number {
  return record.rememberDevice
    ? record.createdAt + REMEMBER_DEVICE_MAX_MS
    : Number.POSITIVE_INFINITY;
}

export function isSessionExpired(record: SessionRecord, nowMs: number): boolean {
  return nowMs >= Math.min(record.lastSeenAt + SESSION_IDLE_TIMEOUT_MS, absoluteDeadline(record));
}

/** A 40-minute sliding deadline; ignores the absolute cap, which is derived. */
function slidingDeadline(nowMs: number): number {
  return nowMs + SESSION_IDLE_TIMEOUT_MS;
}

/**
 * Creates a session, enforcing the 5-session cap by revoking the least recently
 * active one (ADR-005). Returns the evicted session so the caller can audit it.
 */
export async function createSession(
  env: Env,
  input: {
    userId: string;
    rememberDevice: boolean;
    deviceName?: string | null;
    ipTruncated?: string | null;
    clientCategory?: string | null;
  },
  nowMs: number,
): Promise<{ created: CreatedSession; evicted: SessionRecord | null }> {
  const active = await env.DB.prepare(
    `SELECT * FROM sessions
      WHERE user_id = ?1 AND revoked_at IS NULL AND expires_at > ?2
      ORDER BY last_seen_at ASC`,
  )
    .bind(input.userId, nowMs)
    .all<SessionRow>();

  const evicted =
    active.results.length >= MAX_ACTIVE_SESSIONS ? toRecord(active.results[0]!) : null;
  if (evicted) {
    await env.DB.prepare("UPDATE sessions SET revoked_at = ?2 WHERE id = ?1")
      .bind(evicted.id, nowMs)
      .run();
  }

  const token = randomToken(32);
  const id = uuidv7(nowMs, randomBytes(10));
  const expiresAt = slidingDeadline(nowMs);

  await env.DB.prepare(
    `INSERT INTO sessions
       (id, user_id, token_hash, remember_device, device_name, client_category, ip_truncated, created_at, last_seen_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)`,
  )
    .bind(
      id,
      input.userId,
      await hashSessionToken(token),
      input.rememberDevice ? 1 : 0,
      input.deviceName ?? null,
      input.clientCategory ?? null,
      input.ipTruncated ?? null,
      nowMs,
      expiresAt,
    )
    .run();

  return {
    created: {
      token,
      csrfToken: await csrfTokenFor(env, id),
      session: {
        id,
        userId: input.userId,
        rememberDevice: input.rememberDevice,
        deviceName: input.deviceName ?? null,
        clientCategory: input.clientCategory ?? null,
        ipTruncated: input.ipTruncated ?? null,
        createdAt: nowMs,
        lastSeenAt: nowMs,
        expiresAt,
      },
    },
    evicted,
  };
}

/**
 * Resolves a cookie token to a live session, or null when it is unknown,
 * revoked or expired. A null result is the single signal that makes the client
 * discard its cached key material (§4).
 */
export async function findSessionByToken(
  env: Env,
  token: string,
  nowMs: number,
): Promise<SessionRecord | null> {
  const tokenHash = await hashSessionToken(token);
  const row = await env.DB.prepare(
    "SELECT * FROM sessions WHERE token_hash = ?1 AND revoked_at IS NULL",
  )
    .bind(tokenHash)
    .first<SessionRow>();

  if (!row) {
    return null;
  }
  const record = toRecord(row);
  return isSessionExpired(record, nowMs) ? null : record;
}

/**
 * Slides the expiry forward, at most once per `SESSION_TOUCH_INTERVAL_MS` (§4
 * explicitly allows a write threshold). Returns the session as the caller should
 * treat it afterwards.
 */
export async function touchSession(
  env: Env,
  record: SessionRecord,
  nowMs: number,
): Promise<SessionRecord> {
  if (nowMs - record.lastSeenAt < SESSION_TOUCH_INTERVAL_MS) {
    return record;
  }
  const expiresAt = slidingDeadline(nowMs);
  await env.DB.prepare(
    "UPDATE sessions SET last_seen_at = ?2, expires_at = ?3 WHERE id = ?1 AND revoked_at IS NULL",
  )
    .bind(record.id, nowMs, expiresAt)
    .run();

  return { ...record, lastSeenAt: nowMs, expiresAt };
}

/** Revokes one session owned by `userId`. Returns false when nothing matched. */
export async function revokeSession(
  env: Env,
  userId: string,
  sessionId: string,
  nowMs: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE sessions SET revoked_at = ?3 WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL",
  )
    .bind(sessionId, userId, nowMs)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Revokes every session of the account, optionally keeping one (used by
 * recovery login, which keeps the current session, and by TOTP rebind, which
 * keeps none). Returns the number of revoked sessions.
 */
export async function revokeAllSessions(
  env: Env,
  userId: string,
  nowMs: number,
  options: { keepSessionId?: string } = {},
): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ?2
      WHERE user_id = ?1 AND revoked_at IS NULL AND (?3 IS NULL OR id <> ?3)`,
  )
    .bind(userId, nowMs, options.keepSessionId ?? null)
    .run();

  return result.meta.changes ?? 0;
}

export async function listSessions(
  env: Env,
  userId: string,
  nowMs: number,
  currentSessionId: string,
): Promise<SessionSummary[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM sessions
      WHERE user_id = ?1 AND revoked_at IS NULL AND expires_at > ?2
      ORDER BY last_seen_at DESC`,
  )
    .bind(userId, nowMs)
    .all<SessionRow>();

  return rows.results
    .map(toRecord)
    .filter((record) => !isSessionExpired(record, nowMs))
    .map((record) => ({ ...record, current: record.id === currentSessionId }));
}

/** Renames a device. Names are user-supplied metadata, length-bounded by the route. */
export async function renameSession(
  env: Env,
  userId: string,
  sessionId: string,
  deviceName: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE sessions SET device_name = ?3 WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL",
  )
    .bind(sessionId, userId, deviceName)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Double-submit CSRF token (§14), derived from the session id.
 *
 * Stateless on purpose: the token is an HMAC over the session id, so no extra
 * column or write is needed and the value cannot be forged without the signing
 * key. It is bound to one session, so it stops being useful the moment that
 * session is revoked, and a token from one session never validates another.
 */
export async function csrfTokenFor(env: Env, sessionId: string): Promise<string> {
  const mac = await hmac(
    "SHA-256",
    base64ToBytes(env.CSRF_SIGNING_KEY),
    utf8(`SecureNotes/v1/csrf/${sessionId}`),
  );
  return bytesToBase64(mac).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time comparison of a submitted token against the session's token. */
export async function verifyCsrfToken(
  env: Env,
  sessionId: string,
  submitted: string | null | undefined,
): Promise<boolean> {
  if (!submitted) {
    return false;
  }
  const expected = await csrfTokenFor(env, sessionId);
  return timingSafeEqualHex(await sha256Hex(expected), await sha256Hex(submitted));
}
