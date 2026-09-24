/**
 * Frozen cryptographic format (requirements §6).
 *
 * These constants define the wire format shared by the browser (which performs
 * all plaintext encryption) and the worker (which only ever handles envelopes
 * and must be able to validate their shape without holding any key).
 *
 * Changing anything in this file is a crypto-version change: old objects must
 * remain decryptable, so bump `CRYPTO_VERSION` and keep the old reader.
 */

/** Version of the envelope format itself. */
export const CRYPTO_VERSION = 1;

/** First DEK/KEK generation. Bumped when key material is rotated (§3 TOTP rebind). */
export const KEY_VERSION_INITIAL = 1;

/** Only AES-256-GCM is permitted for data encryption. */
export const ENVELOPE_ALG = "AES-256-GCM";

/** AES-GCM: 256-bit keys, 96-bit random IV, 128-bit tag (§6). */
export const AES_KEY_BITS = 256;
export const AES_GCM_IV_BYTES = 12;
export const AES_GCM_TAG_BITS = 128;
export const AES_GCM_TAG_BYTES = 16;

/** HKDF-SHA-256 is the only KDF in use (§6). */
export const HKDF_HASH = "SHA-256";

/** Fixed application context mixed into every derivation (never user-controlled). */
export const KDF_CONTEXT = "SecureNotes/v1/KEK";
export const RECOVERY_KDF_CONTEXT = "SecureNotes/v1/RecoveryKEK";
export const ATTACHMENT_KDF_CONTEXT = "SecureNotes/v1/AttachmentKey";

/** Prefix of the canonical AAD string. Versioned with the AAD layout. */
export const AAD_PREFIX = "SecureNotes/v1";

/**
 * Every encrypted object declares what it is, so an envelope can never be
 * replayed in a different position of the data model (AAD binds this value).
 */
export const OBJECT_TYPES = [
  "note",
  "note_revision",
  "note_conflict",
  "folder",
  "tag",
  "note_tag_link",
  "attachment_meta",
  "attachment_blob",
  "audit_field",
  "user_key_material",
  "export_manifest",
] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];

/**
 * On-the-wire shape of every encrypted object (§6 "Encrypted object format").
 * `iv` and `ciphertext` are base64 (standard alphabet, padded); `ciphertext`
 * includes the 16-byte GCM authentication tag appended to the ciphertext.
 */
export interface CryptoEnvelope {
  crypto_version: number;
  key_version: number;
  alg: typeof ENVELOPE_ALG;
  iv: string;
  ciphertext: string;
}

export interface AadInput {
  objectType: ObjectType;
  objectId: string;
  /** Monotonically increasing revision of the object. */
  revision: number;
  keyVersion: number;
  cryptoVersion?: number;
}

/**
 * Object ids are server- or client-generated random identifiers. Restricting
 * the charset keeps the AAD string unambiguous: no separator can be injected
 * through an id, so distinct tuples can never produce the same AAD.
 */
const OBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidObjectId(value: string): boolean {
  return OBJECT_ID_PATTERN.test(value);
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

export function isObjectType(value: unknown): value is ObjectType {
  return typeof value === "string" && (OBJECT_TYPES as readonly string[]).includes(value);
}

/**
 * Canonical AAD string. Deterministic by construction: fixed field order,
 * fixed prefix, all fields validated before assembly.
 */
export function canonicalAad(input: AadInput): string {
  if (!isObjectType(input.objectType)) {
    throw new RangeError("objectType is not a known object type");
  }
  if (!isValidObjectId(input.objectId)) {
    throw new RangeError("objectId must match [A-Za-z0-9_-]{1,64}");
  }
  assertNonNegativeInteger(input.revision, "revision");
  assertPositiveInteger(input.keyVersion, "keyVersion");
  const cryptoVersion = input.cryptoVersion ?? CRYPTO_VERSION;
  assertPositiveInteger(cryptoVersion, "cryptoVersion");

  return [
    AAD_PREFIX,
    input.objectType,
    input.objectId,
    String(input.revision),
    String(input.keyVersion),
    String(cryptoVersion),
  ].join("|");
}

/**
 * AAD bytes handed to AES-GCM. The same function must be used on encrypt and
 * on decrypt; a mismatch makes `decrypt` fail, which is the intended
 * integrity check for object identity and revision.
 *
 * UTF-8 is guaranteed to be byte-identical in the browser and in workerd.
 */
export function buildAad(input: AadInput): Uint8Array {
  return new TextEncoder().encode(canonicalAad(input));
}
