import {
  CRYPTO_VERSION,
  ENVELOPE_ALG,
  RECOVERY_CODE_COUNT,
  parseEnvelope,
  type CryptoEnvelope,
} from "@securenotes/shared";
import { z } from "zod";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";

/**
 * Storage of client-produced key material.
 *
 * The server never sees a key: the browser generates the DEK, wraps it with the
 * KEK, wraps it again under each recovery code, and uploads only those
 * envelopes. Everything here is therefore validation and bookkeeping — the
 * worker can check shape, version and completeness, but not correctness, which
 * is exactly the trust boundary in the threat model.
 */

/** Shape of one envelope as it arrives over the wire. */
export const envelopeSchema = z
  .object({
    crypto_version: z.number().int().min(1),
    key_version: z.number().int().min(1),
    alg: z.literal(ENVELOPE_ALG),
    iv: z.string().min(1),
    ciphertext: z.string().min(1),
  })
  .strict();

export const keyMaterialSchema = z
  .object({
    keyVersion: z.number().int().min(1),
    wrappedDek: envelopeSchema,
    // One wrapping per recovery code, identified by that code's public salt.
    recoveryWrappings: z
      .array(z.object({ salt: z.string().min(1), envelope: envelopeSchema }).strict())
      .min(1)
      .max(RECOVERY_CODE_COUNT),
  })
  .strict();

export type KeyMaterialUpload = z.infer<typeof keyMaterialSchema>;

/**
 * The material a TOTP rebind uploads.
 *
 * Identical except that the recovery wrappings may be absent, meaning "keep the stored ones". The
 * codes and the DEK are unchanged by a rebind, so the existing wrappings remain the way back in.
 */
export type RebindMaterialUpload = Omit<KeyMaterialUpload, "recoveryWrappings"> & {
  recoveryWrappings?: KeyMaterialUpload["recoveryWrappings"];
};

/**
 * Re-validates every envelope with the shared parser.
 *
 * Zod has already checked the fields' presence and types; `parseEnvelope` adds
 * the parts a schema cannot express — base64 validity, a 96-bit IV, a ciphertext
 * long enough to hold the GCM tag — so a malformed envelope is rejected before
 * it is stored rather than when it is first read.
 */
export function assertEnvelopesAreWellFormed(upload: RebindMaterialUpload): void {
  try {
    parseEnvelope(upload.wrappedDek);
    for (const wrapping of upload.recoveryWrappings ?? []) {
      parseEnvelope(wrapping.envelope);
    }
  } catch (error) {
    throw new ApiError("VALIDATION_FAILED", {
      diagnostic: error instanceof Error ? error.message : "malformed envelope",
    });
  }

  if (upload.wrappedDek.key_version !== upload.keyVersion) {
    throw new ApiError("VALIDATION_FAILED", {
      diagnostic: "wrappedDek.key_version does not match keyVersion",
    });
  }
  for (const wrapping of upload.recoveryWrappings ?? []) {
    if (wrapping.envelope.key_version !== upload.keyVersion) {
      throw new ApiError("VALIDATION_FAILED", {
        diagnostic: "a recovery wrapping has a mismatched key_version",
      });
    }
  }
  if (upload.wrappedDek.crypto_version !== CRYPTO_VERSION) {
    throw new ApiError("VALIDATION_FAILED", {
      diagnostic: "wrappedDek.crypto_version is not the version this worker supports",
    });
  }
}

/** A recovery code row as far as wrapping storage is concerned. */
interface CodeRow {
  id: string;
  kdf_salt: string;
  wrapped_dek_ciphertext: string | null;
}

/**
 * Writes the account's key material, atomically:
 * - the KEK-wrapped DEK onto the account,
 * - each recovery wrapping onto the code row it belongs to,
 * - the key version on both.
 *
 * Every stored recovery code must be covered. Uploading a partial set would
 * leave codes that can never recover the DEK while still looking usable.
 */
export async function storeKeyMaterial(
  env: Env,
  userId: string,
  upload: RebindMaterialUpload,
  nowMs: number,
): Promise<void> {
  assertEnvelopesAreWellFormed(upload);

  const codes = await env.DB.prepare(
    "SELECT id, kdf_salt, wrapped_dek_ciphertext FROM recovery_codes WHERE user_id = ?1 AND used_at IS NULL",
  )
    .bind(userId)
    .all<CodeRow>();

  if (codes.results.length === 0) {
    throw new ApiError("PRECONDITION_FAILED", {
      diagnostic: "account has no unused recovery codes",
    });
  }

  const bySalt = new Map(codes.results.map((row) => [row.kdf_salt, row]));
  const wrappings = upload.recoveryWrappings;

  if (wrappings !== undefined) {
    for (const wrapping of wrappings) {
      if (!bySalt.has(wrapping.salt)) {
        throw new ApiError("VALIDATION_FAILED", {
          diagnostic: "a recovery wrapping refers to an unknown code salt",
        });
      }
    }
    if (new Set(wrappings.map((w) => w.salt)).size !== wrappings.length) {
      throw new ApiError("VALIDATION_FAILED", { diagnostic: "duplicate recovery wrapping" });
    }
    if (wrappings.length !== codes.results.length) {
      // Enforced rather than tolerated: partially wrapped codes are a recovery path that silently
      // does not work.
      throw new ApiError("VALIDATION_FAILED", {
        diagnostic: `expected ${codes.results.length} recovery wrappings, got ${wrappings.length}`,
      });
    }
  }

  // The account's wrapping is written whether or not recovery wrappings were supplied: it is the part
  // a rebind actually changes. Returning early when they were absent would report success while
  // changing nothing.
  const statements = [
    env.DB.prepare(
      `UPDATE users
          SET wrapped_dek_iv = ?2, wrapped_dek_ciphertext = ?3,
              key_version = ?4, crypto_version = ?5, updated_at = ?6
        WHERE id = ?1`,
    ).bind(
      userId,
      upload.wrappedDek.iv,
      upload.wrappedDek.ciphertext,
      upload.keyVersion,
      upload.wrappedDek.crypto_version,
      nowMs,
    ),
    ...(wrappings ?? []).map((wrapping) =>
      env.DB.prepare(
        `UPDATE recovery_codes
            SET wrapped_dek_iv = ?2, wrapped_dek_ciphertext = ?3,
                crypto_version = ?4, key_version = ?5
          WHERE id = ?1`,
      ).bind(
        bySalt.get(wrapping.salt)!.id,
        wrapping.envelope.iv,
        wrapping.envelope.ciphertext,
        wrapping.envelope.crypto_version,
        wrapping.envelope.key_version,
      ),
    ),
  ];

  await env.DB.batch(statements);
}

/** Reads the account's wrapped DEK, for delivery to an authenticated client. */
export async function readWrappedDek(
  env: Env,
  userId: string,
): Promise<{ envelope: CryptoEnvelope; keyVersion: number } | null> {
  const row = await env.DB.prepare(
    "SELECT wrapped_dek_iv, wrapped_dek_ciphertext, crypto_version, key_version FROM users WHERE id = ?1",
  )
    .bind(userId)
    .first<{
      wrapped_dek_iv: string | null;
      wrapped_dek_ciphertext: string | null;
      crypto_version: number;
      key_version: number;
    }>();

  if (!row?.wrapped_dek_iv || !row.wrapped_dek_ciphertext) {
    return null;
  }

  return {
    envelope: {
      crypto_version: row.crypto_version,
      key_version: row.key_version,
      alg: ENVELOPE_ALG,
      iv: row.wrapped_dek_iv,
      ciphertext: row.wrapped_dek_ciphertext,
    },
    keyVersion: row.key_version,
  };
}

/** Reads the recovery wrapping for one code salt, for a recovery login. */
export async function readRecoveryWrapping(
  env: Env,
  userId: string,
  codeSalt: string,
): Promise<CryptoEnvelope | null> {
  const row = await env.DB.prepare(
    `SELECT wrapped_dek_iv, wrapped_dek_ciphertext, crypto_version, key_version
       FROM recovery_codes WHERE user_id = ?1 AND kdf_salt = ?2`,
  )
    .bind(userId, codeSalt)
    .first<{
      wrapped_dek_iv: string | null;
      wrapped_dek_ciphertext: string | null;
      crypto_version: number | null;
      key_version: number | null;
    }>();

  if (!row?.wrapped_dek_iv || !row.wrapped_dek_ciphertext) {
    return null;
  }

  return {
    crypto_version: row.crypto_version ?? CRYPTO_VERSION,
    key_version: row.key_version ?? 1,
    // The algorithm is fixed by the frozen format; it is not stored per row.
    alg: ENVELOPE_ALG,
    iv: row.wrapped_dek_iv,
    ciphertext: row.wrapped_dek_ciphertext,
  };
}
