import { RECOVERY_CODE_COUNT, RECOVERY_CODE_LENGTH } from "@securenotes/shared";

import type { Env } from "../env";
import { base32Encode } from "../lib/base32";
import type { Bytes } from "@securenotes/shared";

import { bytesToBase64, randomBytes, sha256Hex, uuidv7 } from "../lib/crypto";
import { openSecret, sealSecret } from "../lib/secret-box";
import { buildTotpUri, generateTotpSecret, verifyTotpCode } from "../lib/totp";

/**
 * The single application account (§3): first-run enrolment, credential
 * verification and recovery codes.
 *
 * Two rules shape everything here:
 * - the username is a KDF input, so it is stored byte-exact, validated to a
 *   conservative ASCII set (no Unicode normalisation surprises) and immutable;
 * - plaintext credentials never reach storage — recovery codes are kept as
 *   SHA-256 digests of 160-bit random values, and the TOTP secret is sealed
 *   with the Worker-side key because it must be re-delivered after login.
 */

/**
 * 32 unambiguous characters: the alphabet of the recovery codes. Excluding
 * I/O/0/1 avoids transcription errors, and an alphabet of exactly 32 means each
 * character carries 5 bits, so a 32-character code is 160 bits of entropy.
 */
export const RECOVERY_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Usernames are restricted to ASCII on purpose: the derivation mixes the
 * username into HKDF, and two visually identical Unicode strings can encode
 * differently, which would silently derive a different key.
 */
export const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;

export interface Account {
  id: string;
  username: string;
  kdfSalt: string;
  keyVersion: number;
  cryptoVersion: number;
  wrappedDekIv: string | null;
  wrappedDekCiphertext: string | null;
  failedAuthCount: number;
  authBackoffUntil: number | null;
  createdAt: number;
}

interface AccountRow {
  id: string;
  username: string;
  kdf_salt: string;
  key_version: number;
  crypto_version: number;
  wrapped_dek_iv: string | null;
  wrapped_dek_ciphertext: string | null;
  failed_auth_count: number;
  auth_backoff_until: number | null;
  created_at: number;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    username: row.username,
    kdfSalt: row.kdf_salt,
    keyVersion: row.key_version,
    cryptoVersion: row.crypto_version,
    wrappedDekIv: row.wrapped_dek_iv,
    wrappedDekCiphertext: row.wrapped_dek_ciphertext,
    failedAuthCount: row.failed_auth_count,
    authBackoffUntil: row.auth_backoff_until,
    createdAt: row.created_at,
  };
}

/** The account, or null before first-run initialization. */
export async function getAccount(env: Env): Promise<Account | null> {
  // The schema holds exactly one account, and `initializeAccount` refuses to
  // create a second. Insertion order is the tiebreaker rather than `created_at`,
  // because a timestamp is caller-supplied and a forged or skewed value must not
  // be able to shadow the real account.
  const row = await env.DB.prepare(
    "SELECT * FROM users ORDER BY rowid ASC LIMIT 1",
  ).first<AccountRow>();

  return row ? toAccount(row) : null;
}

export interface EnrolmentResult {
  account: Account;
  /** Shown once as a QR code; never retrievable through the UI afterwards. */
  totpSecretBase32: string;
  totpUri: string;
  /**
   * Shown once. Only digests are stored from here on.
   *
   * Each entry carries the code's public HKDF salt, which the client needs to
   * derive that code's recovery KEK and wrap the DEK under it. The salt is not
   * secret; the code's 160 bits of entropy are what protect the wrapping.
   */
  recoveryCodes: Array<{ code: string; salt: string }>;
}

/**
 * First-run initialization (§3). Creates the only account that will ever exist,
 * its TOTP secret and ten recovery codes in a single transaction.
 *
 * Returns null if an account already exists: enrolment is not an update path.
 */
export async function initializeAccount(
  env: Env,
  username: string,
  nowMs: number,
): Promise<EnrolmentResult | null> {
  const existing = await getAccount(env);
  if (existing) {
    return null;
  }

  const userId = uuidv7(nowMs, randomBytes(10));
  const kdfSalt = bytesToBase64(randomBytes(16));
  const totp = generateTotpSecret();
  const sealedTotp = await sealSecret(env.SECRET_WRAP_KEY, "totp-secret", totp.bytes);

  const codeRows = await Promise.all(
    Array.from({ length: RECOVERY_CODE_COUNT }, async () => {
      const code = generateRecoveryCode();
      return {
        id: uuidv7(nowMs, randomBytes(10)),
        code,
        hash: await sha256Hex(code),
        // Per-code HKDF salt for the recovery KEK; generated here because it is
        // public, while the wrapping itself arrives with the client's key setup.
        salt: bytesToBase64(randomBytes(16)),
      };
    }),
  );

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, username, kdf_salt, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`,
    ).bind(userId, username, kdfSalt, nowMs),
    env.DB.prepare(
      `INSERT INTO totp_config (user_id, secret_iv, secret_ciphertext, verified_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4, ?4)`,
    ).bind(userId, sealedTotp.iv, sealedTotp.ciphertext, nowMs),
    ...codeRows.map((row) =>
      env.DB.prepare(
        `INSERT INTO recovery_codes (id, user_id, code_hash, kdf_salt, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind(row.id, userId, row.hash, row.salt, nowMs),
    ),
  ]);

  const account: Account = {
    id: userId,
    username,
    kdfSalt,
    keyVersion: 1,
    cryptoVersion: 1,
    wrappedDekIv: null,
    wrappedDekCiphertext: null,
    failedAuthCount: 0,
    authBackoffUntil: null,
    createdAt: nowMs,
  };

  return {
    account,
    totpSecretBase32: totp.base32,
    totpUri: buildTotpUri(totp.base32, username),
    recoveryCodes: codeRows.map((row) => ({ code: row.code, salt: row.salt })),
  };
}

function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    // The alphabet is exactly 32 characters, so `byte % 32` is uniform and
    // introduces no modulo bias.
    code += RECOVERY_CODE_ALPHABET[byte % RECOVERY_CODE_ALPHABET.length] ?? "";
  }
  return code;
}

export type CredentialResult =
  | { kind: "ok"; account: Account }
  | { kind: "invalid" }
  | { kind: "backoff"; retryAfterSeconds: number };

/**
 * Verifies username + current TOTP code (§3).
 *
 * The code's time-step is recorded so the same 6 digits can never be replayed,
 * and a failure of any kind is reported identically to the caller so that the
 * response does not reveal whether the username exists.
 */
export async function verifyTotpCredentials(
  env: Env,
  username: string,
  code: string,
  nowMs: number,
): Promise<CredentialResult> {
  const account = await getAccount(env);
  if (!account || account.username !== username) {
    // Equalise the work done for an unknown username: without this, a missing
    // account returns measurably faster than a wrong code.
    await verifyTotpCode(generateTotpSecret().bytes, code, nowMs);
    return { kind: "invalid" };
  }

  if (account.authBackoffUntil !== null && account.authBackoffUntil > nowMs) {
    return {
      kind: "backoff",
      retryAfterSeconds: Math.max(1, Math.ceil((account.authBackoffUntil - nowMs) / 1000)),
    };
  }

  const config = await env.DB.prepare(
    "SELECT secret_iv, secret_ciphertext, last_used_step FROM totp_config WHERE user_id = ?1",
  )
    .bind(account.id)
    .first<{ secret_iv: string; secret_ciphertext: string; last_used_step: number | null }>();

  if (!config) {
    return { kind: "invalid" };
  }

  let secret: Bytes;
  try {
    secret = await openSecret(env.SECRET_WRAP_KEY, "totp-secret", {
      iv: config.secret_iv,
      ciphertext: config.secret_ciphertext,
    });
  } catch {
    // A secret that cannot be opened is unusable; never fall back to "accept".
    return { kind: "invalid" };
  }

  const matchedStep = await verifyTotpCode(secret, code, nowMs, {
    lastUsedStep: config.last_used_step,
  });
  if (matchedStep === null) {
    return { kind: "invalid" };
  }

  // Only advance the step monotonically: a concurrent request that already
  // consumed a later step must not be rolled back by this one.
  await env.DB.prepare(
    `UPDATE totp_config SET last_used_step = ?2, updated_at = ?3
      WHERE user_id = ?1 AND (last_used_step IS NULL OR last_used_step < ?2)`,
  )
    .bind(account.id, matchedStep, nowMs)
    .run();

  return { kind: "ok", account };
}

/**
 * The wrapping of the DEK that belongs to the redeemed code, plus its salt.
 *
 * Without these a recovery login can authenticate but cannot decrypt anything: the KEK is derived
 * from the TOTP secret, which is exactly what the user has lost. The salt is not secret, and only
 * the redeemed code's wrapping is returned — never another code's.
 */
export interface RedeemedRecoveryWrapping {
  salt: string;
  iv: string | null;
  ciphertext: string | null;
  cryptoVersion: number | null;
  keyVersion: number | null;
}

export type RecoveryResult =
  { kind: "ok"; account: Account; wrapping: RedeemedRecoveryWrapping } | { kind: "invalid" };

/**
 * Redeems a recovery code (§3). Codes are single-use: the row is only updated
 * when `used_at IS NULL`, and the affected-row count decides the winner, so two
 * concurrent redemptions of the same code cannot both succeed.
 */
export async function redeemRecoveryCode(
  env: Env,
  username: string,
  code: string,
  nowMs: number,
): Promise<RecoveryResult> {
  const account = await getAccount(env);
  if (!account || account.username !== username) {
    await sha256Hex(code);
    return { kind: "invalid" };
  }

  const codeHash = await sha256Hex(normalizeRecoveryCode(code));
  // Read first so the wrapping can be returned, then consume: the update's affected-row count still
  // decides the winner, so two concurrent redemptions cannot both succeed.
  const row = await env.DB.prepare(
    `SELECT id, kdf_salt AS salt, wrapped_dek_iv AS iv, wrapped_dek_ciphertext AS ciphertext,
            crypto_version AS cryptoVersion, key_version AS keyVersion
       FROM recovery_codes
      WHERE user_id = ?1 AND code_hash = ?2 AND used_at IS NULL`,
  )
    .bind(account.id, codeHash)
    .first<RedeemedRecoveryWrapping & { id: string }>();

  if (!row) {
    return { kind: "invalid" };
  }

  const consumed = await env.DB.prepare(
    "UPDATE recovery_codes SET used_at = ?2 WHERE id = ?1 AND used_at IS NULL",
  )
    .bind(row.id, nowMs)
    .run();

  if ((consumed.meta.changes ?? 0) === 0) {
    return { kind: "invalid" };
  }

  const { id: _id, ...wrapping } = row;
  return { kind: "ok", account, wrapping };
}

/** Counts unused codes, so the UI can warn before the last one is spent. */
export async function countUnusedRecoveryCodes(env: Env, userId: string): Promise<number> {
  const value = await env.DB.prepare(
    "SELECT count(*) AS c FROM recovery_codes WHERE user_id = ?1 AND used_at IS NULL",
  )
    .bind(userId)
    .first<number>("c");

  return value ?? 0;
}

/**
 * Returns the account's TOTP secret in base32, for delivery to a client that has
 * just authenticated with TOTP (ADR-002).
 *
 * This is the one place a recoverable secret leaves the worker. It is never
 * logged, never returned on any other path, and `null` means "not enrolled".
 */
export async function readTotpSecretBase32(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT secret_iv, secret_ciphertext FROM totp_config WHERE user_id = ?1",
  )
    .bind(userId)
    .first<{ secret_iv: string; secret_ciphertext: string }>();

  if (!row) {
    return null;
  }
  try {
    const bytes = await openSecret(env.SECRET_WRAP_KEY, "totp-secret", {
      iv: row.secret_iv,
      ciphertext: row.secret_ciphertext,
    });
    return base32Encode(bytes);
  } catch {
    return null;
  }
}

function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase();
}
