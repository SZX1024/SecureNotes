/**
 * Small WebCrypto helpers used on the authentication path.
 *
 * Nothing here holds application data keys: note/folder/attachment plaintext is
 * encrypted in the browser and this worker never has a key for it. These
 * primitives only protect worker-side authentication state (session tokens,
 * TOTP secrets at rest, CSRF tokens).
 */

const textEncoder = new TextEncoder();

export function utf8(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Random bytes from the platform CSPRNG. Never Math.random. */
export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** URL-safe random token, used for session tokens and CSRF tokens. */
export function randomToken(byteLength = 32): string {
  return bytesToBase64(randomBytes(byteLength))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** Hex SHA-256, the storage form of every verification digest in the schema. */
export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const input = typeof value === "string" ? utf8(value) : value;
  return bytesToHex(await sha256(input));
}

export async function hmac(
  algorithm: "SHA-1" | "SHA-256" | "SHA-512",
  key: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, message));
}

/**
 * Compares two hex digests without an early exit, so verification time does not
 * reveal how many leading characters an attacker guessed correctly.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * UUIDv7 (§4 session ids, and the id shape used across the schema): a
 * millisecond timestamp followed by random bits, so ids sort by creation time
 * without being guessable from a counter.
 */
export function uuidv7(nowMs: number, random: Uint8Array): string {
  if (random.length < 10) {
    throw new RangeError("uuidv7 needs at least 10 random bytes");
  }
  const bytes = new Uint8Array(16);
  bytes[0] = Math.floor(nowMs / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(nowMs / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(nowMs / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(nowMs / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(nowMs / 2 ** 8) & 0xff;
  bytes[5] = nowMs & 0xff;
  bytes.set(random.subarray(0, 10), 6);
  // Version 7 in the high nibble of byte 6, RFC 4122 variant in byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytesToHex(bytes);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/** Imports a base64 secret as an AES-GCM key, rejecting anything not 256-bit. */
export async function importAesGcmKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Key);
  if (raw.length !== 32) {
    throw new RangeError("expected a 256-bit (32 byte) base64 key");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Derives a purpose-specific 256-bit key from the single `SECRET_WRAP_KEY` root,
 * via HKDF-SHA-256 (the same KDF the frozen format mandates, §6).
 *
 * One root secret is easier to provision and rotate than several, and deriving
 * per-purpose keys keeps the purposes separated: ciphertext sealed for the TOTP
 * secret cannot be opened as an audit detail even though both use the same root.
 * The HKDF `info` string is fixed and versioned, never user-controlled.
 */
export async function deriveWorkerKey(rootBase64Key: string, purpose: string): Promise<string> {
  const root = base64ToBytes(rootBase64Key);
  if (root.length !== 32) {
    throw new RangeError("expected a 256-bit (32 byte) base64 root key");
  }
  const hkdfKey = await crypto.subtle.importKey("raw", root, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: utf8(`SecureNotes/v1/worker/${purpose}`),
    },
    hkdfKey,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
}
