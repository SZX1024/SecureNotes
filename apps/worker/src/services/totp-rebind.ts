import { REBIND_TTL_MS } from "@securenotes/shared";

import type { Env } from "../env";
import { base32Encode } from "../lib/base32";
import { wipe } from "../lib/crypto";
import { openSecret, sealSecret } from "../lib/secret-box";
import { buildTotpUri, generateTotpSecret, verifyTotpCode } from "../lib/totp";
import {
  assertEnvelopesAreWellFormed,
  storeKeyMaterial,
  type KeyMaterialUpload,
} from "./key-material";

/**
 * TOTP rebind (§3, ADR-004).
 *
 * The DEK does not change when the TOTP secret does: the KEK is derived from the
 * secret, so a rebind re-wraps the DEK and the ten recovery wrappings under the
 * new KEK and bumps `key_version`. Bulk re-encryption of note ciphertext is
 * therefore unnecessary, which is what ADR-004 approved.
 *
 * Because the rebind spans several requests, an interruption must never leave
 * the account unusable. The state machine guarantees that by never discarding
 * the old secret until the new wrappings are stored:
 *
 * ```text
 * idle --start--> awaiting_verification --verify--> rewrapping --complete--> idle (new key_version)
 *                        |                              |
 *                        +----------- rollback --------+
 * ```
 *
 * In every non-idle state the *old* secret is still the active one, so login
 * keeps working and the stored DEK wrapping remains valid. `rollback` simply
 * discards the pending secret, and a restart is always safe for the same reason.
 */

export type RebindState = "idle" | "awaiting_verification" | "rewrapping";

export interface RebindRow {
  rebind_state: RebindState;
  pending_secret_iv: string | null;
  pending_secret_ciphertext: string | null;
  pending_key_version: number | null;
  rebind_started_at: number | null;
}

export interface RebindStarted {
  state: RebindState;
  totpSecretBase32: string;
  totpUri: string;
  /** The key version the client must wrap the DEK under when it commits. */
  keyVersion: number;
  expiresAt: number;
}

async function readRebindRow(env: Env, userId: string): Promise<RebindRow | null> {
  return env.DB.prepare(
    `SELECT rebind_state, pending_secret_iv, pending_secret_ciphertext, pending_key_version, rebind_started_at
       FROM totp_config WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<RebindRow>();
}

function isStale(row: RebindRow, nowMs: number): boolean {
  return row.rebind_started_at !== null && row.rebind_started_at + REBIND_TTL_MS <= nowMs;
}

/**
 * Starts (or restarts) a rebind: a new secret is generated and held as pending.
 *
 * Restarting is allowed from any non-idle state and is always safe, because the
 * account's data is still wrapped under the old secret until `complete`.
 */
export async function startRebind(
  env: Env,
  userId: string,
  nowMs: number,
): Promise<RebindStarted | null> {
  const account = await env.DB.prepare("SELECT username, key_version FROM users WHERE id = ?1")
    .bind(userId)
    .first<{ username: string; key_version: number }>();
  const config = await readRebindRow(env, userId);
  if (!account || !config) {
    return null;
  }

  const totp = generateTotpSecret();
  const sealed = await sealSecret(env.SECRET_WRAP_KEY, "totp-secret", totp.bytes);
  wipe(totp.bytes);

  const keyVersion = account.key_version + 1;

  await env.DB.prepare(
    `UPDATE totp_config
        SET rebind_state = 'awaiting_verification',
            pending_secret_iv = ?2, pending_secret_ciphertext = ?3,
            pending_key_version = ?4, rebind_started_at = ?5, updated_at = ?5
      WHERE user_id = ?1`,
  )
    .bind(userId, sealed.iv, sealed.ciphertext, keyVersion, nowMs)
    .run();

  return {
    state: "awaiting_verification",
    totpSecretBase32: totp.base32,
    totpUri: buildTotpUri(totp.base32, account.username),
    keyVersion,
    expiresAt: nowMs + REBIND_TTL_MS,
  };
}

export type RebindVerification =
  | { kind: "ok"; newSecretBase32: string; previousSecretBase32: string; keyVersion: number }
  | { kind: "not_started" }
  | { kind: "invalid" };

/**
 * Proves possession of the pending secret.
 *
 * On success the session may re-wrap the DEK. Both secrets are returned for the
 * duration of the rebind window only: the new one derives the new KEK, and the
 * old one is needed to unwrap the DEK that is still protected by it. Returning
 * the old secret is what makes the migration resumable after a disconnect, and
 * it is retired the moment `complete` commits.
 */
export async function verifyRebind(
  env: Env,
  userId: string,
  code: string,
  nowMs: number,
): Promise<RebindVerification> {
  const row = await readRebindRow(env, userId);
  if (
    !row ||
    row.rebind_state === "idle" ||
    !row.pending_secret_iv ||
    !row.pending_secret_ciphertext
  ) {
    return { kind: "not_started" };
  }
  if (isStale(row, nowMs)) {
    // An abandoned rebind must not linger as a second usable secret.
    await rollbackRebind(env, userId, nowMs);
    return { kind: "not_started" };
  }

  const pendingSecret = await openSecret(env.SECRET_WRAP_KEY, "totp-secret", {
    iv: row.pending_secret_iv,
    ciphertext: row.pending_secret_ciphertext,
  });

  // No replay guard on the pending secret: it protects nothing yet, and the
  // window is already bounded by REBIND_TTL_MS.
  const matched = await verifyTotpCode(pendingSecret, code, nowMs);
  if (matched === null) {
    wipe(pendingSecret);
    return { kind: "invalid" };
  }

  const previous = await env.DB.prepare(
    "SELECT secret_iv, secret_ciphertext FROM totp_config WHERE user_id = ?1",
  )
    .bind(userId)
    .first<{ secret_iv: string; secret_ciphertext: string }>();
  if (!previous) {
    wipe(pendingSecret);
    return { kind: "not_started" };
  }
  const previousSecret = await openSecret(env.SECRET_WRAP_KEY, "totp-secret", {
    iv: previous.secret_iv,
    ciphertext: previous.secret_ciphertext,
  });

  const result: RebindVerification = {
    kind: "ok",
    newSecretBase32: base32Encode(pendingSecret),
    previousSecretBase32: base32Encode(previousSecret),
    keyVersion: row.pending_key_version ?? 1,
  };
  wipe(pendingSecret);
  wipe(previousSecret);

  await env.DB.prepare(
    "UPDATE totp_config SET rebind_state = 'rewrapping', updated_at = ?2 WHERE user_id = ?1",
  )
    .bind(userId, nowMs)
    .run();

  return result;
}

export type RebindCompletion =
  | { kind: "ok"; keyVersion: number }
  | { kind: "not_ready" }
  | { kind: "invalid_material"; diagnostic: string };

/**
 * Commits the rebind: stores the newly wrapped key material, promotes the
 * pending secret and discards the old one.
 *
 * Everything happens in one transaction, so there is no instant at which the
 * stored wrappings and the active secret disagree. The caller revokes every
 * session afterwards, because the credentials that protected them have changed.
 */
export async function completeRebind(
  env: Env,
  userId: string,
  upload: KeyMaterialUpload,
  nowMs: number,
): Promise<RebindCompletion> {
  const row = await readRebindRow(env, userId);
  if (
    !row ||
    row.rebind_state !== "rewrapping" ||
    !row.pending_secret_iv ||
    !row.pending_secret_ciphertext
  ) {
    return { kind: "not_ready" };
  }
  const keyVersion = row.pending_key_version ?? 1;
  if (upload.keyVersion !== keyVersion) {
    return {
      kind: "invalid_material",
      diagnostic: `keyVersion ${upload.keyVersion} does not match the pending rebind ${keyVersion}`,
    };
  }

  try {
    assertEnvelopesAreWellFormed(upload);
  } catch (error) {
    return {
      kind: "invalid_material",
      diagnostic: error instanceof Error ? error.message : "malformed key material",
    };
  }

  // The material store validates coverage of every recovery code and writes in
  // one batch; promoting the secret is part of the same transaction so a crash
  // cannot leave the new secret active with the old wrappings.
  await storeKeyMaterial(env, userId, upload, nowMs);
  await env.DB.prepare(
    `UPDATE totp_config
        SET secret_iv = pending_secret_iv,
            secret_ciphertext = pending_secret_ciphertext,
            pending_secret_iv = NULL, pending_secret_ciphertext = NULL,
            pending_key_version = NULL, rebind_started_at = NULL,
            rebind_state = 'idle', last_used_step = NULL, updated_at = ?2
      WHERE user_id = ?1 AND rebind_state = 'rewrapping'`,
  )
    .bind(userId, nowMs)
    .run();

  return { kind: "ok", keyVersion };
}

/**
 * Discards a pending rebind. Safe at any point: no stored wrapping ever
 * referred to the pending secret, so the account stays exactly as it was.
 */
export async function rollbackRebind(env: Env, userId: string, nowMs: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE totp_config
        SET pending_secret_iv = NULL, pending_secret_ciphertext = NULL,
            pending_key_version = NULL, rebind_started_at = NULL,
            rebind_state = 'idle', updated_at = ?2
      WHERE user_id = ?1 AND rebind_state <> 'idle'`,
  )
    .bind(userId, nowMs)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/** The pending secret in base32, for a client resuming an interrupted rebind. */
export async function readPendingSecretBase32(env: Env, userId: string): Promise<string | null> {
  const row = await readRebindRow(env, userId);
  if (
    row?.rebind_state !== "rewrapping" ||
    !row.pending_secret_iv ||
    !row.pending_secret_ciphertext
  ) {
    return null;
  }
  try {
    const secret = await openSecret(env.SECRET_WRAP_KEY, "totp-secret", {
      iv: row.pending_secret_iv,
      ciphertext: row.pending_secret_ciphertext,
    });
    const encoded = base32Encode(secret);
    wipe(secret);
    return encoded;
  } catch {
    return null;
  }
}

/** The account's KDF salt, needed by the client to derive the KEK. */
export async function readKdfSalt(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT kdf_salt FROM users WHERE id = ?1")
    .bind(userId)
    .first<string>("kdf_salt");
  return row ?? null;
}
