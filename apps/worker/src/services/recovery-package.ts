import { KDF_CONTEXT, RECOVERY_KDF_CONTEXT, type CryptoEnvelope } from "@securenotes/shared";

import { ApiError } from "../lib/api-error";
import type { Env } from "../env";

/**
 * The account recovery package (§20).
 *
 * A separate artefact from the ordinary export, and deliberately not a superset of it: it holds the minimum
 * protected key material needed to recover the account on a new device — the wrapped data key, the per-code
 * wrappings, and the salts and identifiers that make them usable — and nothing else. No note content, and above
 * all **no TOTP secret**: §20 forbids exporting that, and it is the one value whose presence would turn this file
 * into a complete account takeover for anyone who found it.
 *
 * What makes the file safe to keep beside a backup is that every wrapping in it is protected by something the
 * user holds separately: the account wrapping needs the username and the authenticator secret, and each recovery
 * wrapping needs its own recovery code. The package alone opens nothing.
 */

export const RECOVERY_PACKAGE_FORMAT = "securenotes-recovery";
export const RECOVERY_PACKAGE_FORMAT_VERSION = 1;

/** What this file deliberately does not contain, named so nobody has to infer it from a field list. */
export const RECOVERY_PACKAGE_EXCLUDES = [
  "totp_secret",
  "note_content",
  "attachment_content",
] as const;

export interface RecoveryPackage {
  format: typeof RECOVERY_PACKAGE_FORMAT;
  formatVersion: number;
  createdAt: number;
  account: { id: string; username: string };
  kdf: {
    algorithm: "HKDF-SHA-256";
    /** The account's salt, base64, as the KDF consumes it. */
    accountSalt: string;
    accountContext: string;
    recoveryContext: string;
  };
  cryptoVersion: number;
  keyVersion: number;
  accountWrapping: CryptoEnvelope;
  /** One per **unused** recovery code: a used code's wrapping opens nothing. */
  recoveryWrappings: Array<{ salt: string; envelope: CryptoEnvelope }>;
  excludes: readonly string[];
}

interface AccountRow {
  id: string;
  username: string;
  kdf_salt: string;
  wrapped_dek_iv: string;
  wrapped_dek_ciphertext: string;
  crypto_version: number;
  key_version: number;
}

interface CodeRow {
  kdf_salt: string;
  wrapped_dek_iv: string;
  wrapped_dek_ciphertext: string;
  crypto_version: number;
  key_version: number;
}

export async function buildRecoveryPackage(
  env: Env,
  userId: string,
  nowMs: number,
): Promise<RecoveryPackage> {
  const account = await env.DB.prepare(
    `SELECT id, username, kdf_salt, wrapped_dek_iv, wrapped_dek_ciphertext, crypto_version, key_version
       FROM users WHERE id = ?1`,
  )
    .bind(userId)
    .first<AccountRow>();

  if (!account || account.wrapped_dek_ciphertext.length === 0) {
    throw new ApiError("PRECONDITION_FAILED", {
      diagnostic: "this account has no key material to recover",
    });
  }

  const codes = await env.DB.prepare(
    `SELECT kdf_salt, wrapped_dek_iv, wrapped_dek_ciphertext, crypto_version, key_version
       FROM recovery_codes
      WHERE user_id = ?1 AND used_at IS NULL
      ORDER BY created_at`,
  )
    .bind(userId)
    .all<CodeRow>();

  return {
    format: RECOVERY_PACKAGE_FORMAT,
    formatVersion: RECOVERY_PACKAGE_FORMAT_VERSION,
    createdAt: nowMs,
    // The account id and username are identifiers rather than secrets: the username is already a KDF input the
    // user knows, and the id is what makes the package distinguishable from another account's.
    account: { id: account.id, username: account.username },
    kdf: {
      algorithm: "HKDF-SHA-256",
      accountSalt: account.kdf_salt,
      accountContext: KDF_CONTEXT,
      recoveryContext: RECOVERY_KDF_CONTEXT,
    },
    cryptoVersion: account.crypto_version,
    keyVersion: account.key_version,
    accountWrapping: {
      crypto_version: account.crypto_version,
      key_version: account.key_version,
      alg: "AES-256-GCM",
      iv: account.wrapped_dek_iv,
      ciphertext: account.wrapped_dek_ciphertext,
    },
    recoveryWrappings: codes.results.map((row) => ({
      salt: row.kdf_salt,
      envelope: {
        crypto_version: row.crypto_version,
        key_version: row.key_version,
        alg: "AES-256-GCM" as const,
        iv: row.wrapped_dek_iv,
        ciphertext: row.wrapped_dek_ciphertext,
      },
    })),
    excludes: RECOVERY_PACKAGE_EXCLUDES,
  };
}
