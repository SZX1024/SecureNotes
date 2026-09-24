import {
  AES_GCM_IV_BYTES,
  CRYPTO_VERSION,
  ENVELOPE_ALG,
  buildAad,
  type AadInput,
  type CryptoEnvelope,
  type ObjectType,
} from "./format";
import { base64ToBytes, bytesToBase64, randomBytes, utf8, type Bytes } from "./bytes";

/**
 * Envelope encryption of application objects (§6).
 *
 * Every ciphertext is bound to its identity and revision through the AAD, so a
 * blob cannot be replayed into a different object, a different revision, or a
 * different key generation: all of those make decryption fail rather than
 * silently returning the wrong plaintext.
 */

/** AES-GCM key for object data. The `DEK` in the frozen key hierarchy. */
export type ObjectKey = CryptoKey;

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/**
 * Validates an untrusted value into a `CryptoEnvelope`.
 *
 * The worker uses this to reject malformed input without holding any key, and
 * the client uses it to reject anything the server hands back before feeding it
 * to WebCrypto.
 */
export function parseEnvelope(value: unknown): CryptoEnvelope {
  if (typeof value !== "object" || value === null) {
    throw new EnvelopeError("envelope must be an object");
  }
  const candidate = value as Partial<CryptoEnvelope>;

  if (candidate.alg !== ENVELOPE_ALG) {
    throw new EnvelopeError(`unsupported algorithm: ${String(candidate.alg)}`);
  }
  if (
    typeof candidate.crypto_version !== "number" ||
    !Number.isSafeInteger(candidate.crypto_version) ||
    candidate.crypto_version < 1
  ) {
    throw new EnvelopeError("crypto_version must be a positive integer");
  }
  if (
    typeof candidate.key_version !== "number" ||
    !Number.isSafeInteger(candidate.key_version) ||
    candidate.key_version < 1
  ) {
    throw new EnvelopeError("key_version must be a positive integer");
  }
  if (typeof candidate.iv !== "string" || typeof candidate.ciphertext !== "string") {
    throw new EnvelopeError("iv and ciphertext must be base64 strings");
  }

  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    iv = base64ToBytes(candidate.iv);
    ciphertext = base64ToBytes(candidate.ciphertext);
  } catch {
    throw new EnvelopeError("iv and ciphertext must be valid base64");
  }
  if (iv.length !== AES_GCM_IV_BYTES) {
    throw new EnvelopeError(`iv must be ${AES_GCM_IV_BYTES} bytes, got ${iv.length}`);
  }
  if (ciphertext.length < 16) {
    // Anything shorter cannot contain the 128-bit GCM tag.
    throw new EnvelopeError("ciphertext is shorter than the authentication tag");
  }

  return {
    crypto_version: candidate.crypto_version,
    key_version: candidate.key_version,
    alg: ENVELOPE_ALG,
    iv: candidate.iv,
    ciphertext: candidate.ciphertext,
  };
}

/**
 * The versions this build can read. Reading an object written by a *newer*
 * build must fail loudly: guessing at an unknown layout is how data gets
 * silently corrupted.
 */
export function assertSupportedVersions(envelope: CryptoEnvelope): void {
  if (envelope.crypto_version !== CRYPTO_VERSION) {
    throw new EnvelopeError(
      `crypto_version ${envelope.crypto_version} is not supported by this build (${CRYPTO_VERSION})`,
    );
  }
}

/**
 * The AAD bytes, taken from the frozen format module so the client and the
 * worker can never disagree about the canonical string. `buildAad` validates
 * every field, and its failures are surfaced as `EnvelopeError` for callers.
 */
function buildAdditionalData(aad: AadInput): Bytes {
  try {
    return buildAad(aad);
  } catch (error) {
    throw new EnvelopeError(error instanceof Error ? error.message : "invalid AAD");
  }
}

/**
 * Encrypts one object under `key` with a fresh random 96-bit IV (§6: never
 * reuse an IV). The caller supplies the AAD identity, which is bound into the
 * tag so the ciphertext cannot be moved.
 */
export async function encryptObject(
  key: ObjectKey,
  aad: AadInput,
  plaintext: Bytes,
): Promise<CryptoEnvelope> {
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: buildAdditionalData(aad), tagLength: 128 },
    key,
    plaintext,
  );

  return {
    crypto_version: aad.cryptoVersion ?? CRYPTO_VERSION,
    key_version: aad.keyVersion,
    alg: ENVELOPE_ALG,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypts an object, failing closed on any mismatch: wrong key, wrong AAD
 * (object type, id, revision or key version), or tampered ciphertext.
 */
export async function decryptObject(
  key: ObjectKey,
  aad: AadInput,
  envelope: CryptoEnvelope,
): Promise<Bytes> {
  const parsed = parseEnvelope(envelope);
  assertSupportedVersions(parsed);

  if (parsed.key_version !== aad.keyVersion) {
    // The key generation is part of the AAD, so this would fail anyway; failing
    // here names the actual problem instead of reporting a generic auth failure.
    throw new EnvelopeError(
      `envelope key_version ${parsed.key_version} does not match the expected ${aad.keyVersion}`,
    );
  }

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(parsed.iv),
        additionalData: buildAdditionalData(aad),
        tagLength: 128,
      },
      key,
      base64ToBytes(parsed.ciphertext),
    );
    return new Uint8Array(plaintext);
  } catch {
    // WebCrypto reports every failure identically; keep it that way so a caller
    // cannot distinguish "wrong key" from "wrong object" from "tampered".
    throw new EnvelopeError("decryption failed: wrong key, wrong object or tampered ciphertext");
  }
}

/** Convenience wrappers for the common case of JSON-ish text payloads. */
export async function encryptJson(
  key: ObjectKey,
  aad: AadInput,
  value: unknown,
): Promise<CryptoEnvelope> {
  return encryptObject(key, aad, utf8(JSON.stringify(value)));
}

export async function decryptJson<T>(
  key: ObjectKey,
  aad: AadInput,
  envelope: CryptoEnvelope,
): Promise<T> {
  const plaintext = await decryptObject(key, aad, envelope);
  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    throw new EnvelopeError("decrypted payload is not valid JSON");
  }
}

/** Object types this module will encrypt as application data. */
export const DATA_OBJECT_TYPES: readonly ObjectType[] = [
  "note",
  "note_revision",
  "note_conflict",
  "folder",
  "tag",
  "note_tag_link",
  "attachment_meta",
  "attachment_blob",
  "export_manifest",
];
