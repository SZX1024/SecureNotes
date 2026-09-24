import { base32Decode } from "./base32";
import {
  base64ToBytes,
  bytesToBase64,
  concatBytes,
  randomBytes,
  utf8,
  wipe,
  type Bytes,
} from "./bytes";
import { EnvelopeError, parseEnvelope } from "./envelope";
import {
  AES_GCM_IV_BYTES,
  CRYPTO_VERSION,
  ENVELOPE_ALG,
  KDF_CONTEXT,
  KEY_VERSION_INITIAL,
  RECOVERY_KDF_CONTEXT,
  buildAad,
  type CryptoEnvelope,
} from "./format";

/**
 * Key hierarchy of requirements §6.
 *
 * ```text
 * username + TOTP secret + KDF_CONTEXT + per-account salt -> HKDF-SHA-256 -> KEK
 * KEK wraps the DEK; the DEK is what encrypts application data.
 * each recovery code + RECOVERY_KDF_CONTEXT + per-code salt -> recovery KEK
 * recovery KEK wraps the same DEK, independently per code.
 * ```
 *
 * Only the long-lived TOTP secret is ever a derivation input — never a 6-digit
 * code (§6) — and the plaintext DEK exists only transiently while it is wrapped
 * or unwrapped. What remains is a non-extractable `CryptoKey` in memory and, on
 * disk, only wrapped blobs.
 *
 * Wrapped key material is itself an envelope, bound with the frozen AAD using
 * the `user_key_material` object type. The KEK wrapping and each recovery
 * wrapping share that identity on purpose: they are distinct keys over the same
 * secret, so swapping two wrappings can only cause a decryption failure.
 */

export const KDF_SALT_BYTES = 16;
export const DEK_BYTES = 32;
const HKDF_HASH = "SHA-256";

export interface AccountKeyInput {
  /** Stored byte-exact; it is a KDF input, so it must never be normalised. */
  username: string;
  /** Base32 TOTP secret, delivered after authentication (ADR-002). */
  totpSecretBase32: string;
  /** Base64 per-account random salt, public and stored in D1. */
  kdfSaltBase64: string;
}

/** Identifies a wrapped DEK: the account and the key generation. */
export interface KeyMaterialIdentity {
  /** The account id. Ids are identifiers, never authorization (§26). */
  userId: string;
  keyVersion?: number;
}

async function deriveAesKey(material: Bytes, salt: Bytes, info: string): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: HKDF_HASH, salt, info: utf8(info) },
    hkdfKey,
    256,
  );
  return crypto.subtle.importKey("raw", new Uint8Array(bits), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Derives the KEK from the account credentials. Deterministic by construction:
 * the same inputs always produce the same key, which is what makes the wrapped
 * DEK portable across devices and recoverable after a TOTP rebind.
 *
 * The material is `username || 0x00 || totpSecretBytes`. The separator is
 * unambiguous because usernames are restricted to ASCII without NUL (see
 * `USERNAME_PATTERN` in the worker), and the secret is raw bytes rather than its
 * base32 text so no encoding choice can drift between implementations.
 */
export async function deriveKek(input: AccountKeyInput): Promise<CryptoKey> {
  const secret = base32Decode(input.totpSecretBase32);
  const material = concatBytes(utf8(input.username), new Uint8Array([0]), secret);
  try {
    return await deriveAesKey(material, base64ToBytes(input.kdfSaltBase64), KDF_CONTEXT);
  } finally {
    wipe(material);
    wipe(secret);
  }
}

/** Derives the recovery KEK for one recovery code and its per-code salt. */
export async function deriveRecoveryKek(code: string, codeSaltBase64: string): Promise<CryptoKey> {
  const material = utf8(normalizeRecoveryCode(code));
  try {
    return await deriveAesKey(material, base64ToBytes(codeSaltBase64), RECOVERY_KDF_CONTEXT);
  } finally {
    wipe(material);
  }
}

/**
 * Recovery codes are compared without surrounding whitespace, internal
 * separators or case, so a code copied from the screen or a password manager
 * still derives the same key. Nothing else about the code is normalised.
 */
export function normalizeRecoveryCode(code: string): string {
  return code
    .trim()
    .replace(/[\s-]+/g, "")
    .toUpperCase();
}

/** A fresh data encryption key. The raw form exists only long enough to wrap it. */
export function generateDekRaw(): Bytes {
  return randomBytes(DEK_BYTES);
}

/**
 * Imports raw DEK bytes as a **non-extractable** AES-GCM key (§7). The DEK is
 * only ever held in this form, and only after its wrappings have been produced,
 * so the key itself cannot be exported by the page that holds it.
 */
export async function importDek(raw: Bytes): Promise<CryptoKey> {
  if (raw.length !== DEK_BYTES) {
    throw new EnvelopeError(`a DEK must be ${DEK_BYTES} bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function keyMaterialAad(identity: KeyMaterialIdentity) {
  const keyVersion = identity.keyVersion ?? KEY_VERSION_INITIAL;
  return buildAad({
    objectType: "user_key_material",
    objectId: identity.userId,
    revision: keyVersion,
    keyVersion,
    cryptoVersion: CRYPTO_VERSION,
  });
}

/** Wraps the raw DEK with a key-encrypting key (the KEK or a recovery KEK). */
export async function wrapDek(
  wrappingKey: CryptoKey,
  rawDek: Bytes,
  identity: KeyMaterialIdentity,
): Promise<CryptoEnvelope> {
  if (rawDek.length !== DEK_BYTES) {
    throw new EnvelopeError(`a DEK must be ${DEK_BYTES} bytes, got ${rawDek.length}`);
  }
  const keyVersion = identity.keyVersion ?? KEY_VERSION_INITIAL;
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: keyMaterialAad(identity), tagLength: 128 },
    wrappingKey,
    rawDek,
  );

  return {
    crypto_version: CRYPTO_VERSION,
    key_version: keyVersion,
    alg: ENVELOPE_ALG,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Unwraps the DEK, failing closed when the wrapping key is wrong — a mistyped
 * recovery code, or a rebind whose new key is not committed yet.
 */
export async function unwrapDek(
  wrappingKey: CryptoKey,
  envelope: CryptoEnvelope,
  identity: KeyMaterialIdentity,
): Promise<Bytes> {
  const parsed = parseEnvelope(envelope);
  const keyVersion = identity.keyVersion ?? KEY_VERSION_INITIAL;

  if (parsed.crypto_version !== CRYPTO_VERSION) {
    throw new EnvelopeError(`unsupported crypto_version ${parsed.crypto_version}`);
  }
  if (parsed.key_version !== keyVersion) {
    throw new EnvelopeError(`wrapped DEK is version ${parsed.key_version}, expected ${keyVersion}`);
  }

  try {
    const raw = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(parsed.iv),
        additionalData: keyMaterialAad(identity),
        tagLength: 128,
      },
      wrappingKey,
      base64ToBytes(parsed.ciphertext),
    );
    return new Uint8Array(raw);
  } catch {
    throw new EnvelopeError("the DEK could not be unwrapped: wrong key or tampered wrapping");
  }
}

/**
 * Builds the ten independent recovery wrappings of one DEK (§6). Each code has
 * its own salt, so compromising one code reveals nothing about the others, and
 * losing one loses only that path.
 */
export async function buildRecoveryWrappings(
  rawDek: Bytes,
  codes: ReadonlyArray<{ code: string; salt: string }>,
  identity: KeyMaterialIdentity,
): Promise<CryptoEnvelope[]> {
  return Promise.all(
    codes.map(async (entry) =>
      wrapDek(await deriveRecoveryKek(entry.code, entry.salt), rawDek, identity),
    ),
  );
}
